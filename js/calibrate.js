// Row-calibration wizard: confirm auto-detected rows or frame the grid by hand.
import { squareCols } from "./rows.js";

const $ = (id) => document.getElementById(id);

export class Calibrator {
  constructor(viewer, hooks) {
    this.viewer = viewer;
    this.hooks = hooks; // {onDone(), onChange(project)}
    this.queue = [];
    this.single = false;
    this.el = {
      panel: $("cal-panel"), step: $("cal-step"), title: $("cal-title"), text: $("cal-text"),
      rows: $("cal-rows"), first: $("cal-first"), cols: $("cal-cols"), bottomUp: $("cal-bottomup"),
      ok: $("cal-ok"), redraw: $("cal-redraw"), skip: $("cal-skip"), cancel: $("cal-cancel"),
    };
    const e = this.el;
    for (const inp of [e.rows, e.first]) inp.addEventListener("input", () => this.fromFields());
    e.cols.addEventListener("input", () => {
      const c = parseInt(e.cols.value, 10);
      this.draft.cols = c > 0 ? Math.min(c, 5000) : null;
      this.colsEdited = true;
      this.edited = true;
      this.viewer.requestDraw();
      this.render();
    });
    e.bottomUp.addEventListener("change", () => this.fromFields());
    e.ok.addEventListener("click", () => this.confirm());
    e.redraw.addEventListener("click", () => this.redraw());
    e.skip.addEventListener("click", () => this.skipPage());
    e.cancel.addEventListener("click", () => this.cancel());
  }

  get active() { return !this.el.panel.hidden; }

  // Walk through every page that still needs a decision.
  startPending() {
    const pages = this.viewer.project.pages;
    this.queue = pages.map((p, i) => (p && p.confirmed ? -1 : i)).filter((i) => i >= 0);
    this.single = false;
    if (!this.queue.length) return false;
    this.total = this.queue.length;
    this.next();
    return true;
  }

  // Re-do the current page from the toolbar.
  startCurrent() {
    this.queue = [this.viewer.pageIndex];
    this.single = true;
    this.total = 1;
    this.next();
  }

  async next() {
    const i = this.queue.shift();
    if (i === undefined) { this.finish(); return; }
    const v = this.viewer;
    if (i !== v.pageIndex) await v.showPage(i);
    else v.fit();
    this.pageIndex = i;
    this.edited = false;
    const info = v.project.pages[i] || {};
    const cal = info.cal;
    this.original = info.cal ? JSON.parse(JSON.stringify(info.cal)) : null;
    this.draft = cal
      ? { rect: { ...cal.rect }, rows: cal.rows, firstRow: cal.firstRow, bottomUp: cal.bottomUp, auto: !!cal.auto, cols: cal.cols || null }
      : { rect: null, rows: null, firstRow: 1, bottomUp: true, auto: false, cols: null };
    this.colsEdited = !!(cal && cal.cols);
    // Row numbers on one side only: find the other edge of the grid on the page.
    if (cal && cal.auto && cal.open) {
      const ext = v.inkExtent(this.draft.rect);
      if (ext) {
        if (cal.open === "left" && ext.x0 < this.draft.rect.x1) this.draft.rect.x0 = ext.x0;
        if (cal.open === "right" && ext.x1 > this.draft.rect.x0) this.draft.rect.x1 = ext.x1;
      }
    }
    this.el.panel.hidden = false;
    this.hooks.onShow?.(true);
    this.el.cancel.hidden = !this.single;
    const pc = v.pageCount;
    this.el.step.textContent = pc > 1 ? `Страница ${i + 1} из ${pc}` : "";
    this.render();
    v.startCalibration(this.draft, () => { this.edited = true; this.render(); });
  }

  render() {
    const d = this.draft;
    const e = this.el;
    const hasRect = !!d.rect;
    if (d.auto && !this.edited) {
      e.title.textContent = "Ряды найдены";
      e.text.innerHTML = `На схеме <b>${d.rows}</b> ${plural(d.rows, "ряд", "ряда", "рядов")}: с ${d.firstRow} по ${d.firstRow + d.rows - 1}. ` +
        "Увеличьте низ и верх схемы и проверьте, что зелёные линии легли на линии сетки.";
    } else if (!hasRect) {
      e.title.textContent = "Обведите сетку схемы";
      e.text.textContent = "Зажмите кнопку мыши в одном углу сетки — по её внешней линии — и протяните до противоположного угла. " +
        "Потом укажите, сколько в сетке рядов.";
    } else {
      e.title.textContent = "Проверьте разметку";
      e.text.textContent = "Края рамки можно подвинуть мышью. Зелёные линии должны лечь на линии рядов по всей высоте схемы.";
    }
    // Cells across: from the stitch numbers, or square cells until typed in.
    if (!this.colsEdited && hasRect && d.rows >= 1) d.cols = squareCols(d.rect, d.rows);
    if (document.activeElement !== e.cols) e.cols.value = d.cols ?? "";
    if (document.activeElement !== e.rows) e.rows.value = d.rows ?? "";
    if (document.activeElement !== e.first) e.first.value = d.firstRow ?? 1;
    e.bottomUp.checked = !!d.bottomUp;
    const valid = hasRect && d.rows >= 1 && Number.isFinite(d.firstRow);
    e.ok.disabled = !valid;
    e.ok.textContent = d.auto && !this.edited ? "Всё верно" : "Готово";
    e.redraw.textContent = hasRect ? "Обвести заново" : "Обвести сетку";
  }

  fromFields() {
    const d = this.draft;
    const rows = parseInt(this.el.rows.value, 10);
    const first = parseInt(this.el.first.value, 10);
    d.rows = rows > 0 ? Math.min(rows, 5000) : null;
    d.firstRow = Number.isFinite(first) ? first : 1;
    d.bottomUp = this.el.bottomUp.checked;
    this.edited = true;
    this.viewer.requestDraw();
    this.render();
  }

  redraw() {
    this.draft.rect = null;
    this.colsEdited = false;
    this.edited = true;
    this.viewer.beginRedraw();
    this.viewer.requestDraw();
    this.render();
  }

  saveCurrent(info) {
    const p = this.viewer.project;
    p.pages[this.pageIndex] = info;
    p.updatedAt = Date.now();
    this.hooks.onChange(p);
  }

  confirm() {
    const d = this.draft;
    if (!d.rect || !(d.rows >= 1)) return;
    const cal = { rect: { ...d.rect }, rows: d.rows, firstRow: d.firstRow, bottomUp: !!d.bottomUp, auto: d.auto && !this.edited };
    cal.cols = d.cols > 0 ? d.cols : squareCols(d.rect, d.rows);
    cal.start = this.original && "start" in this.original ? this.original.start : null;
    // Stitches read from the page stay valid while the grid is unchanged.
    if (this.original && this.original.spans) { cal.spans = this.original.spans; cal.spansKey = this.original.spansKey; }
    this.saveCurrent({ cal, skip: false, confirmed: true });
    this.edited = false;
    this.next();
  }

  skipPage() {
    this.saveCurrent({ cal: null, skip: true, confirmed: true });
    this.edited = false;
    this.next();
  }

  cancel() {
    this.edited = false;
    this.queue = [];
    this.finish();
  }

  finish() {
    this.el.panel.hidden = true;
    this.hooks.onShow?.(false);
    this.viewer.endCalibration();
    this.hooks.onDone?.();
  }
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
