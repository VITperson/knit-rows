// The chart viewer: pan and zoom, crisp rendering, row marks.
import { openPdf, pageSize, baseScaleFor, renderPage, renderRegion, isCancel } from "./render.js";
import { rowAt, rowBand, rowHeight, hasRow, normRect, allRowsOf } from "./rows.js";
import { drawKnit, drawCalibration, hitHandle } from "./overlay.js";

const $ = (id) => document.getElementById(id);
const dpr = () => window.devicePixelRatio || 1;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Viewer {
  constructor(hooks) {
    this.hooks = hooks; // {onChange(project, {view}), onProgress(), toast(msg)}
    this.stage = $("stage");
    this.world = $("world");
    this.sharpCanvas = $("sharp");
    this.overlay = $("overlay");
    this.tag = $("hover-tag");
    this.loading = $("loading");
    this.project = null;
    this.pdf = null;
    this.page = null;
    this.pageIndex = 0;
    this.pageCount = 0;
    this.size = { width: 1, height: 1 };
    this.v = { z: 1, tx: 0, ty: 0 };
    this.fitZ = 1;
    this.base = null;
    this.sharpJob = null;
    this.sharpView = null;
    this.mode = "knit";
    this.draft = null;
    this.drawMode = false;
    this.onDraft = null;
    this.hover = null;
    this.doneSet = new Set();
    this.undo = [];
    this.pageToken = 0;
    this.stats = {};
    this.bindInput();
    new ResizeObserver(() => this.onResize()).observe(this.stage);
  }

  get W() { return this.stage.clientWidth; }
  get H() { return this.stage.clientHeight; }

  // --- lifecycle ----------------------------------------------------------

  async open(project, pdfBlob) {
    this.close();
    this.project = project;
    this.doneSet = new Set(project.done || []);
    this.undo = [];
    this.showLoading("Открываю схему…");
    const data = new Uint8Array(await pdfBlob.arrayBuffer());
    this.pdf = await openPdf(data);
    this.pageCount = this.pdf.doc.numPages;
    const view = project.view;
    const start = view && view.page < this.pageCount ? view.page : this.firstPageWithRows();
    await this.showPage(start, { restore: view && view.page === start ? view : null });
  }

  close() {
    this.pageToken++;
    this.cancelSharp();
    clearTimeout(this.sharpTimer);
    clearTimeout(this.viewTimer);
    if (this.baseJob) { try { this.baseJob.task.cancel(); } catch {} this.baseJob = null; }
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
    this.world.replaceChildren();
    this.base = null;
    this.sharpView = null;
    this.sharpCanvas.hidden = true;
    this.page = null;
    this.endCalibration();
    this.hideTag();
    this.requestDraw();
  }

  firstPageWithRows() {
    const i = (this.project.pages || []).findIndex((p) => p && p.cal && !p.skip);
    return i < 0 ? 0 : i;
  }

  async showPage(i, opts = {}) {
    const token = ++this.pageToken;
    this.cancelSharp();
    if (this.baseJob) { try { this.baseJob.task.cancel(); } catch {} this.baseJob = null; }
    this.pageIndex = i;
    this.page = await this.pdf.doc.getPage(i + 1);
    if (token !== this.pageToken) return;
    this.size = pageSize(this.page);
    this.base = null;
    this.sharpView = null;
    this.sharpCanvas.hidden = true;
    this.world.replaceChildren();
    this.world.style.width = this.size.width + "px";
    this.world.style.height = this.size.height + "px";
    this.computeFit();
    const r = opts.restore;
    if (r && r.zr) {
      this.v.z = clamp(r.zr * this.fitZ, this.zMin, this.zMax);
      this.v.tx = this.W / 2 - r.cx * this.v.z;
      this.v.ty = this.H / 2 - r.cy * this.v.z;
    } else {
      this.fit(false);
    }
    this.hooks.onPage?.(i, this.pageCount);
    this.showLoading(this.pageCount > 1 ? `Рисую страницу ${i + 1}…` : "Рисую схему…");
    const scale = baseScaleFor(this.size);
    const t0 = performance.now();
    const job = renderPage(this.page, scale);
    this.baseJob = job;
    try {
      await job.promise;
    } catch (e) {
      if (isCancel(e)) return;
      throw e;
    }
    if (token !== this.pageToken) return;
    this.baseJob = null;
    this.stats.baseMs = Math.round(performance.now() - t0);
    job.canvas.style.width = this.size.width + "px";
    job.canvas.style.height = this.size.height + "px";
    this.world.replaceChildren(job.canvas);
    this.base = { scale, canvas: job.canvas };
    this.contentCache = new Map();
    this.hideLoading();
    this.applyView();
    opts.after?.();
  }

  // --- view ---------------------------------------------------------------

  computeFit() {
    const m = 24;
    this.fitZ = Math.max(0.05, Math.min((this.W - 2 * m) / this.size.width, (this.H - 2 * m) / this.size.height));
    this.zMin = this.fitZ * 0.5;
    this.zMax = Math.max(this.fitZ * 4, 48);
  }

  fit(apply = true) {
    this.v.z = this.fitZ;
    this.v.tx = (this.W - this.size.width * this.fitZ) / 2;
    this.v.ty = (this.H - this.size.height * this.fitZ) / 2;
    if (apply) this.applyView();
  }

  applyView() {
    const { z, tx, ty } = this.v;
    this.world.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    this.hooks.onZoom?.(Math.round((z / this.fitZ) * 100));
    this.updateSharpTransform();
    this.scheduleSharp();
    this.requestDraw();
    this.scheduleViewSave();
  }

  zoomAt(f, x, y) {
    const nz = clamp(this.v.z * f, this.zMin, this.zMax);
    const k = nz / this.v.z;
    this.v.tx = x - (x - this.v.tx) * k;
    this.v.ty = y - (y - this.v.ty) * k;
    this.v.z = nz;
    this.applyView();
  }

  zoomStep(dir) {
    this.zoomAt(dir > 0 ? 1.35 : 1 / 1.35, this.W / 2, this.H / 2);
  }

  animateTo(target, ms = 220) {
    cancelAnimationFrame(this.anim);
    const from = { ...this.v };
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.v.z = from.z + (target.z - from.z) * e;
      this.v.tx = from.tx + (target.tx - from.tx) * e;
      this.v.ty = from.ty + (target.ty - from.ty) * e;
      this.applyView();
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  onResize() {
    if (!this.page) { this.requestDraw(); return; }
    const cx = (this.W / 2 - this.v.tx) / this.v.z;
    const cy = (this.H / 2 - this.v.ty) / this.v.z;
    const rel = this.v.z / this.fitZ;
    this.computeFit();
    this.v.z = clamp(rel * this.fitZ, this.zMin, this.zMax);
    this.v.tx = this.W / 2 - cx * this.v.z;
    this.v.ty = this.H / 2 - cy * this.v.z;
    this.applyView();
  }

  scheduleViewSave() {
    if (!this.project || !this.base) return;
    clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      if (!this.project) return;
      this.project.view = {
        page: this.pageIndex,
        zr: this.v.z / this.fitZ,
        cx: (this.W / 2 - this.v.tx) / this.v.z,
        cy: (this.H / 2 - this.v.ty) / this.v.z,
      };
      this.hooks.onChange(this.project, { view: true });
    }, 700);
  }

  // --- crisp layer ----------------------------------------------------------
  // The base bitmap is limited in size; when zoomed in further, the visible
  // part is re-rendered at screen resolution once the view settles.

  needSharp() {
    return !!this.base && this.v.z * dpr() > this.base.scale * 1.15;
  }

  updateSharpTransform() {
    const s = this.sharpView;
    const el = this.sharpCanvas;
    if (!s || s.page !== this.pageIndex || !this.needSharp()) { el.hidden = true; return; }
    const k = this.v.z / s.z;
    el.style.transform = `matrix(${k}, 0, 0, ${k}, ${this.v.tx - s.tx * k}, ${this.v.ty - s.ty * k})`;
    el.hidden = false;
  }

  scheduleSharp() {
    clearTimeout(this.sharpTimer);
    this.cancelSharp();
    if (!this.needSharp()) return;
    const s = this.sharpView;
    if (s && s.page === this.pageIndex && s.z === this.v.z && s.tx === this.v.tx && s.ty === this.v.ty) return;
    this.sharpTimer = setTimeout(() => this.renderSharp(), 150);
  }

  cancelSharp() {
    if (this.sharpJob) {
      try { this.sharpJob.task.cancel(); } catch {}
      this.sharpJob = null;
    }
  }

  async renderSharp() {
    if (!this.page || !this.needSharp()) return;
    const d = dpr();
    const W = this.W, H = this.H;
    const { z, tx, ty } = this.v;
    const t0 = performance.now();
    const job = renderRegion(this.page, z * d, tx * d, ty * d, W * d, H * d);
    this.sharpJob = job;
    try {
      await job.promise;
    } catch (e) {
      if (!isCancel(e)) console.warn("sharp render failed", e);
      return;
    }
    if (this.sharpJob !== job) return;
    this.sharpJob = null;
    this.stats.sharpMs = Math.round(performance.now() - t0);
    const el = this.sharpCanvas;
    el.width = job.canvas.width;
    el.height = job.canvas.height;
    el.style.width = W + "px";
    el.style.height = H + "px";
    el.getContext("2d").drawImage(job.canvas, 0, 0);
    this.sharpView = { z, tx, ty, page: this.pageIndex };
    this.updateSharpTransform();
  }

  // --- overlay --------------------------------------------------------------

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw() {
    const c = this.overlay;
    const d = dpr();
    const W = this.W, H = this.H;
    if (c.width !== Math.round(W * d) || c.height !== Math.round(H * d)) {
      c.width = Math.round(W * d);
      c.height = Math.round(H * d);
      c.style.width = W + "px";
      c.style.height = H + "px";
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.base || !this.project) return;
    const v = { ...this.v, w: W, h: H };
    if (this.mode === "knit") {
      drawKnit(ctx, v, this.cal(), {
        done: this.doneSet,
        current: this.currentOnPage(),
        hover: this.hover,
        dim: !!this.project.dim,
      });
    } else {
      drawCalibration(ctx, v, this.draft);
    }
  }

  // --- rows across pages ----------------------------------------------------

  pageInfo(i = this.pageIndex) {
    return (this.project.pages || [])[i] || null;
  }

  cal(i = this.pageIndex) {
    const p = this.pageInfo(i);
    return p && !p.skip ? p.cal : null;
  }

  allRows() {
    return allRowsOf(this.project.pages);
  }

  progress() {
    const rows = this.allRows();
    const done = rows.filter((n) => this.doneSet.has(n)).length;
    return { done, total: rows.length, next: this.nextRow(rows) };
  }

  nextRow(rows = this.allRows()) {
    if (!rows.length) return null;
    let maxDone = -Infinity;
    for (const n of rows) if (this.doneSet.has(n)) maxDone = n;
    if (maxDone === -Infinity) return rows[0];
    return rows.find((n) => n > maxDone) ?? null;
  }

  currentOnPage() {
    const n = this.nextRow();
    return n != null && hasRow(this.cal(), n) ? n : null;
  }

  pageForRow(n) {
    if (hasRow(this.cal(), n)) return this.pageIndex;
    const i = (this.project.pages || []).findIndex((p) => p && !p.skip && hasRow(p.cal, n));
    return i < 0 ? null : i;
  }

  // --- marking --------------------------------------------------------------

  pushUndo() {
    this.undo.push([...this.doneSet]);
    if (this.undo.length > 300) this.undo.shift();
  }

  commit() {
    this.project.done = [...this.doneSet].sort((a, b) => a - b);
    this.project.updatedAt = Date.now();
    this.hooks.onChange(this.project, {});
    this.hooks.onProgress?.();
    this.requestDraw();
  }

  markNext() {
    const n = this.nextRow();
    if (n == null) { this.hooks.toast?.("Все ряды уже отмечены 🎉"); return; }
    this.pushUndo();
    this.doneSet.add(n);
    this.commit();
    const next = this.nextRow();
    this.followRow(next ?? n);
  }

  toggleRow(n) {
    this.pushUndo();
    if (this.doneSet.has(n)) this.doneSet.delete(n);
    else this.doneSet.add(n);
    this.commit();
  }

  markUpTo(n) {
    this.pushUndo();
    for (const r of this.allRows()) if (r <= n) this.doneSet.add(r);
    this.commit();
  }

  undoLast() {
    const prev = this.undo.pop();
    if (!prev) return false;
    this.doneSet = new Set(prev);
    this.commit();
    const next = this.nextRow();
    if (next != null) this.followRow(next);
    return true;
  }

  canUndo() { return this.undo.length > 0; }

  // Keep row n comfortably on screen (pan vertically; switch page if needed).
  followRow(n) {
    const pi = this.pageForRow(n);
    if (pi == null) return;
    if (pi !== this.pageIndex) {
      this.showPage(pi, { after: () => this.centerRow(n, true, false) });
      return;
    }
    const cal = this.cal();
    const b = rowBand(cal, n);
    const top = b.top * this.v.z + this.v.ty;
    const bottom = b.bottom * this.v.z + this.v.ty;
    let { tx, ty } = this.v;
    if (top < this.H * 0.15 || bottom > this.H * 0.85) {
      ty = this.H * 0.45 - ((b.top + b.bottom) / 2) * this.v.z;
    }
    // If the stitches of the row are off to the side, bring them into view.
    const ext = this.rowContent(n);
    if (ext) {
      const viewL = -tx / this.v.z, viewR = (this.W - tx) / this.v.z;
      if (ext.x1 < viewL || ext.x0 > viewR) tx = this.W / 2 - ((ext.x0 + ext.x1) / 2) * this.v.z;
    }
    if (tx !== this.v.tx || ty !== this.v.ty) this.animateTo({ z: this.v.z, tx, ty });
  }

  // Leftmost and rightmost drawn pixel (grid lines included) across the
  // grid's height. Used to find the edge of a grid whose row numbers are
  // printed on one side only.
  inkExtent(rect) {
    if (!this.base || !this.base.canvas) return null;
    const s = this.base.scale;
    const c = this.base.canvas;
    const ctx = c.getContext("2d");
    let lo = Infinity, hi = -Infinity;
    const samples = 24;
    for (let k = 1; k < samples; k++) {
      const y = Math.round((rect.y0 + ((rect.y1 - rect.y0) * k) / samples) * s);
      if (y < 0 || y >= c.height) continue;
      let data;
      try { data = ctx.getImageData(0, y, c.width, 1).data; } catch { return null; }
      for (let x = 0; x < c.width; x++) {
        const i = x * 4;
        if (Math.min(data[i], data[i + 1], data[i + 2]) < 225) { lo = Math.min(lo, x); break; }
      }
      for (let x = c.width - 1; x >= 0; x--) {
        const i = x * 4;
        if (Math.min(data[i], data[i + 1], data[i + 2]) < 225) { hi = Math.max(hi, x + 1); break; }
      }
    }
    return lo < hi ? { x0: lo / s, x1: hi / s } : null;
  }

  // Horizontal extent of what is drawn in row n (stitch symbols, coloured
  // cells), read from the rendered page; empty and "no stitch" cells are
  // ignored. Lets "go to row" land on the stitches of a triangle or a sleeve.
  rowContent(n) {
    const cal = this.cal();
    const b = cal && rowBand(cal, n);
    if (!b || !this.base || !this.base.canvas) return null;
    const key = this.pageIndex + ":" + n;
    if (this.contentCache.has(key)) return this.contentCache.get(key);
    const s = this.base.scale;
    const c = this.base.canvas;
    const x0 = Math.max(0, Math.floor(cal.rect.x0 * s));
    const x1 = Math.min(c.width, Math.ceil(cal.rect.x1 * s));
    const bh = (b.bottom - b.top) * s;
    const y0 = Math.max(0, Math.floor(b.top * s + bh * 0.2));
    const y1 = Math.min(c.height, Math.max(y0 + 1, Math.ceil(b.bottom * s - bh * 0.2)));
    const w = x1 - x0, h = y1 - y0;
    let res = null;
    if (w > 0 && h > 0) {
      let data;
      try { data = c.getContext("2d").getImageData(x0, y0, w, h).data; } catch { data = null; }
      if (data) {
        let first = -1, last = -1;
        for (let x = 0; x < w; x++) {
          for (let y = 0; y < h; y++) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i + 1], bl = data[i + 2];
            const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
            if (mx < 110 || mx - mn > 45) { if (first < 0) first = x; last = x; break; }
          }
        }
        if (first >= 0) res = { x0: (x0 + first) / s, x1: (x0 + last + 1) / s };
      }
    }
    this.contentCache.set(key, res);
    return res;
  }

  // Bring row n to the middle of the screen, zooming in if rows are tiny.
  centerRow(n = this.nextRow(), zoom = true, animate = true) {
    if (n == null) return;
    const pi = this.pageForRow(n);
    if (pi == null) return;
    if (pi !== this.pageIndex) {
      this.showPage(pi, { after: () => this.centerRow(n, zoom, false) });
      return;
    }
    const cal = this.cal();
    const b = rowBand(cal, n);
    const rh = rowHeight(cal);
    let z = this.v.z;
    if (zoom && rh * z < 16) z = clamp(24 / rh, this.zMin, this.zMax);
    const ext = this.rowContent(n) || { x0: cal.rect.x0, x1: cal.rect.x1 };
    let cx = (this.W / 2 - this.v.tx) / this.v.z;
    if (z !== this.v.z || cx < ext.x0 || cx > ext.x1) cx = (ext.x0 + ext.x1) / 2;
    const cy = (b.top + b.bottom) / 2;
    const target = { z, tx: this.W / 2 - cx * z, ty: this.H * 0.45 - cy * z };
    if (animate) this.animateTo(target, 260);
    else { this.v = target; this.applyView(); }
  }

  setDim(on) {
    this.project.dim = !!on;
    this.hooks.onChange(this.project, {});
    this.requestDraw();
  }

  // --- calibration hooks ------------------------------------------------------

  startCalibration(draft, onDraft) {
    this.mode = "calibrate";
    this.draft = draft;
    this.drawMode = !draft.rect;
    this.onDraft = onDraft;
    this.hover = null;
    this.hideTag();
    this.updateCursor(null);
    this.requestDraw();
  }

  beginRedraw() {
    this.drawMode = true;
    this.updateCursor(null);
  }

  endCalibration() {
    this.mode = "knit";
    this.draft = null;
    this.drawMode = false;
    this.onDraft = null;
    this.stage.classList.remove("drawing");
    this.requestDraw();
  }

  draftChanged(final) {
    this.requestDraw();
    this.onDraft?.(this.draft, final);
  }

  // --- input ----------------------------------------------------------------

  local(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  toPage(p) {
    return { x: (p.x - this.v.tx) / this.v.z, y: (p.y - this.v.ty) / this.v.z };
  }

  bindInput() {
    const st = this.stage;
    st.addEventListener("pointerdown", (e) => this.onDown(e));
    st.addEventListener("pointermove", (e) => this.onMove(e));
    st.addEventListener("pointerup", (e) => this.onUp(e, false));
    st.addEventListener("pointercancel", (e) => this.onUp(e, true));
    st.addEventListener("pointerleave", () => {
      if (this.drag) return;
      this.hover = null;
      this.hideTag();
      this.requestDraw();
    });
    st.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Safari trackpad pinch.
    st.addEventListener("gesturestart", (e) => { e.preventDefault(); this.gesture = { z0: this.v.z }; });
    st.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      if (!this.gesture || !this.base) return;
      const p = this.local(e);
      this.zoomAt((this.gesture.z0 * e.scale) / this.v.z, p.x, p.y);
    });
    st.addEventListener("gestureend", (e) => { e.preventDefault(); this.gesture = null; });
    st.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (!this.base) return;
    cancelAnimationFrame(this.anim);
    this.stage.focus({ preventScroll: true });
    const p = this.local(e);
    this.stage.setPointerCapture(e.pointerId);
    const d = { id: e.pointerId, start: p, t0: { tx: this.v.tx, ty: this.v.ty }, moved: false, kind: "pan" };
    if (this.mode === "calibrate") {
      if (this.drawMode) {
        d.kind = "draw";
        d.anchor = this.toPage(p);
      } else if (this.draft && this.draft.rect) {
        const h = hitHandle({ ...this.v }, this.draft.rect, p.x, p.y);
        if (h) {
          d.kind = "edge";
          d.edge = h;
          d.anchor = this.toPage(p);
          d.rect0 = { ...this.draft.rect };
        }
      }
    }
    this.drag = d;
  }

  onMove(e) {
    const p = this.local(e);
    const d = this.drag;
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        if (d.kind === "pan") this.stage.classList.add("panning");
        this.hideTag();
      }
      if (!d.moved) return;
      if (d.kind === "pan") {
        this.v.tx = d.t0.tx + dx;
        this.v.ty = d.t0.ty + dy;
        this.applyView();
      } else if (d.kind === "draw") {
        const q = this.toPage(p);
        const a = d.anchor;
        const clampPt = (pt) => ({ x: clamp(pt.x, 0, this.size.width), y: clamp(pt.y, 0, this.size.height) });
        this.draft.rect = normRect(clampPt(a), clampPt(q));
        this.draft.drawing = true;
        this.draftChanged(false);
      } else if (d.kind === "edge") {
        const q = this.toPage(p);
        const ddx = q.x - d.anchor.x, ddy = q.y - d.anchor.y;
        const r = { ...d.rect0 };
        const min = 2;
        if (d.edge.includes("n")) r.y0 = Math.min(d.rect0.y0 + ddy, r.y1 - min);
        if (d.edge.includes("s")) r.y1 = Math.max(d.rect0.y1 + ddy, r.y0 + min);
        if (d.edge.includes("w")) r.x0 = Math.min(d.rect0.x0 + ddx, r.x1 - min);
        if (d.edge.includes("e")) r.x1 = Math.max(d.rect0.x1 + ddx, r.x0 + min);
        this.draft.rect = r;
        this.draftChanged(false);
      }
      return;
    }
    this.updateHover(p);
  }

  onUp(e, cancelled) {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.stage.classList.remove("panning");
    if (d.kind === "draw") {
      if (this.draft) {
        this.draft.drawing = false;
        const r = this.draft.rect;
        if (d.moved && r && (r.x1 - r.x0) * this.v.z > 12 && (r.y1 - r.y0) * this.v.z > 12) {
          this.drawMode = false;
        }
        this.draftChanged(true);
      }
      this.updateCursor(null);
      return;
    }
    if (d.kind === "edge") {
      this.draftChanged(true);
      return;
    }
    if (!d.moved && !cancelled && this.mode === "knit") {
      const q = this.toPage(d.start);
      const cal = this.cal();
      const n = cal ? rowAt(cal, q.y, q.x) : null;
      if (n != null) {
        if (e.shiftKey) this.markUpTo(n);
        else this.toggleRow(n);
      }
    }
    this.updateHover(this.local(e));
  }

  updateHover(p) {
    if (!this.base) return;
    if (this.mode === "calibrate") {
      const h = this.draft && this.draft.rect && !this.drawMode ? hitHandle({ ...this.v }, this.draft.rect, p.x, p.y) : null;
      this.updateCursor(h);
      return;
    }
    const q = this.toPage(p);
    const cal = this.cal();
    const n = cal ? rowAt(cal, q.y, q.x) : null;
    this.stage.classList.toggle("row-hover", n != null);
    if (n !== this.hover) {
      this.hover = n;
      this.requestDraw();
    }
    if (n == null) { this.hideTag(); return; }
    const done = this.doneSet.has(n);
    const cur = n === this.nextRow();
    this.tag.textContent = `Ряд ${n}${done ? " · провязан ✓" : cur ? " · текущий" : ""}`;
    this.tag.style.left = p.x + "px";
    this.tag.style.top = p.y + "px";
    this.tag.hidden = false;
  }

  updateCursor(h) {
    const st = this.stage.classList;
    st.remove("resize-ns", "resize-ew", "resize-nwse", "resize-nesw", "row-hover");
    st.toggle("drawing", this.mode === "calibrate" && this.drawMode);
    if (!h) return;
    if (h === "n" || h === "s") st.add("resize-ns");
    else if (h === "e" || h === "w") st.add("resize-ew");
    else if (h === "nw" || h === "se") st.add("resize-nwse");
    else st.add("resize-nesw");
  }

  hideTag() { this.tag.hidden = true; }

  onWheel(e) {
    e.preventDefault();
    if (!this.base) return;
    cancelAnimationFrame(this.anim);
    const p = this.local(e);
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= this.H; dy *= this.H; }
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch (Chrome, Firefox) or Ctrl + wheel.
      if (this.gesture) return;
      this.zoomAt(Math.exp(-clamp(dy, -60, 60) * 0.012), p.x, p.y);
      return;
    }
    // A mouse wheel zooms; a trackpad two-finger scroll pans.
    const trackpad = e.wheelDeltaY ? e.wheelDeltaY === -3 * e.deltaY || e.deltaX !== 0 : e.deltaMode === 0;
    if (!trackpad) {
      this.zoomAt(dy < 0 ? 1.2 : 1 / 1.2, p.x, p.y);
      return;
    }
    this.v.tx -= dx;
    this.v.ty -= dy;
    this.applyView();
    this.updateHover(p);
  }

  // Returns true when the key was handled.
  handleKey(e) {
    if (!this.project) return false;
    const code = e.code;
    const mod = e.metaKey || e.ctrlKey;
    if (this.mode === "calibrate") {
      if (code === "Equal" || code === "NumpadAdd") { this.zoomStep(1); return true; }
      if (code === "Minus" || code === "NumpadSubtract") { this.zoomStep(-1); return true; }
      if (code === "Digit0" || code === "Numpad0") { this.fit(); return true; }
      return false;
    }
    if (mod && code === "KeyZ") { this.undoLast(); return true; }
    if (mod) return false;
    switch (code) {
      case "Space": case "Enter": case "NumpadEnter": this.markNext(); return true;
      case "Backspace": this.undoLast(); return true;
      case "Equal": case "NumpadAdd": this.zoomStep(1); return true;
      case "Minus": case "NumpadSubtract": this.zoomStep(-1); return true;
      case "Digit0": case "Numpad0": this.fit(); return true;
      case "KeyC": this.centerRow(); return true;
      case "ArrowUp": this.v.ty += 80; this.applyView(); return true;
      case "ArrowDown": this.v.ty -= 80; this.applyView(); return true;
      case "ArrowLeft": this.v.tx += 80; this.applyView(); return true;
      case "ArrowRight": this.v.tx -= 80; this.applyView(); return true;
      case "PageUp": this.gotoPage(this.pageIndex - 1); return true;
      case "PageDown": this.gotoPage(this.pageIndex + 1); return true;
    }
    return false;
  }

  gotoPage(i) {
    if (!this.pdf || i < 0 || i >= this.pageCount || i === this.pageIndex) return;
    this.showPage(i);
  }

  showLoading(text) {
    $("loading-text").textContent = text;
    this.loading.hidden = false;
  }

  hideLoading() { this.loading.hidden = true; }
}
