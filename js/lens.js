// A round magnifier that follows the pointer over the chart. It shows the
// rendered page (crisp: the area around the pointer is re-rendered at the
// lens's own scale once the pointer rests) with the row marks on top.
import { renderRegion, isCancel } from "./render.js";
import { drawKnit, drawCalibration } from "./overlay.js";

const $ = (id) => document.getElementById(id);
const dpr = () => window.devicePixelRatio || 1;
const PREF = "knit-rows:lens";
const SIZE = 260; // CSS px
const MAX_ZOOM = 60; // CSS px per page unit
export const MAGS = [2, 4, 8];

export class Lens {
  constructor(viewer) {
    this.viewer = viewer;
    this.el = $("lens");
    this.on = false;
    this.mag = 4;
    this.pos = null;
    this.tile = null;
    this.job = null;
    try {
      const p = JSON.parse(localStorage.getItem(PREF) || "{}");
      this.on = !!p.on;
      if (MAGS.includes(p.mag)) this.mag = p.mag;
    } catch {}
  }

  get size() { return SIZE; }

  save() {
    try { localStorage.setItem(PREF, JSON.stringify({ on: this.on, mag: this.mag })); } catch {}
  }

  setOn(on) {
    this.on = !!on;
    this.save();
    if (!this.on) this.hide();
    this.viewer.requestDraw();
  }

  setMag(m) {
    this.mag = m;
    this.save();
    this.viewer.requestDraw();
  }

  // Pointer position in stage coordinates, or null when it left the chart.
  move(p) {
    this.pos = p;
    if (!p) this.el.hidden = true;
    if (this.on) this.viewer.requestDraw();
  }

  hide() {
    this.pos = null;
    this.el.hidden = true;
    clearTimeout(this.timer);
  }

  visible() {
    const v = this.viewer;
    return this.on && !!this.pos && !!v.base && !!v.page;
  }

  zoom() {
    return Math.min(this.viewer.v.z * this.mag, MAX_ZOOM);
  }

  draw() {
    if (!this.visible()) { this.el.hidden = true; return; }
    const v = this.viewer;
    const el = this.el;
    const d = dpr();
    const D = SIZE, R = D / 2;
    if (el.width !== Math.round(D * d)) {
      el.width = el.height = Math.round(D * d);
      el.style.width = el.style.height = D + "px";
    }
    const ctx = el.getContext("2d");
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const zl = this.zoom();
    const q = v.toPage(this.pos);
    const lv = { z: zl, tx: R - q.x * zl, ty: R - q.y * zl, w: D, h: D };

    ctx.fillStyle = "#e9e3da";
    ctx.fillRect(0, 0, D, D);
    // Visible part of the page, in page units.
    const vx0 = Math.max(0, -lv.tx / zl), vy0 = Math.max(0, -lv.ty / zl);
    const vx1 = Math.min(v.size.width, (D - lv.tx) / zl), vy1 = Math.min(v.size.height, (D - lv.ty) / zl);
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(lv.tx + vx0 * zl, lv.ty + vy0 * zl, (vx1 - vx0) * zl, (vy1 - vy0) * zl);
      const t = this.tile;
      const tileOk = t && t.page === v.pageIndex && t.zl === zl &&
        vx0 >= t.x0 && vy0 >= t.y0 && vx1 <= t.x0 + t.w && vy1 <= t.y0 + t.h;
      const src = tileOk ? t : { canvas: v.base.canvas, S: v.base.scale, x0: 0, y0: 0 };
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(
        src.canvas,
        (vx0 - src.x0) * src.S, (vy0 - src.y0) * src.S, (vx1 - vx0) * src.S, (vy1 - vy0) * src.S,
        lv.tx + vx0 * zl, lv.ty + vy0 * zl, (vx1 - vx0) * zl, (vy1 - vy0) * zl,
      );
      if (!tileOk && zl * d > v.base.scale * 1.05) this.scheduleTile();
    }

    // No dimming inside: the lens is for looking closer at any part.
    if (v.mode === "knit") drawKnit(ctx, lv, v.cal(), { ...v.knitState(), dim: false, labels: false });
    else drawCalibration(ctx, lv, v.draft);

    // Where the pointer is.
    ctx.strokeStyle = "rgba(47, 39, 34, 0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(R, R, 5, 0, Math.PI * 2);
    ctx.stroke();

    el.style.transform = `translate(${this.pos.x - R}px, ${this.pos.y - R}px)`;
    el.hidden = false;
  }

  scheduleTile() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.renderTile(), 140);
  }

  async renderTile() {
    const v = this.viewer;
    if (!this.visible()) return;
    if (this.job) { try { this.job.task.cancel(); } catch {} this.job = null; }
    const zl = this.zoom();
    const S = zl * dpr();
    const q = v.toPage(this.pos);
    // Twice the lens in each direction, so small moves stay sharp.
    const span = SIZE / zl;
    const x0 = Math.max(0, q.x - span), y0 = Math.max(0, q.y - span);
    const w = Math.min(v.size.width, q.x + span) - x0;
    const h = Math.min(v.size.height, q.y + span) - y0;
    if (w <= 0 || h <= 0) return;
    const page = v.page, pageIndex = v.pageIndex;
    const job = renderRegion(page, S, -x0 * S, -y0 * S, w * S, h * S);
    this.job = job;
    try {
      await job.promise;
    } catch (e) {
      if (!isCancel(e)) console.warn("lens render failed", e);
      return;
    }
    if (this.job !== job) return;
    this.job = null;
    if (v.page !== page) return;
    this.tile = { canvas: job.canvas, S, zl, x0, y0, w, h, page: pageIndex };
    v.requestDraw();
  }

  reset() {
    if (this.job) { try { this.job.task.cancel(); } catch {} this.job = null; }
    this.tile = null;
    this.hide();
  }
}
