// Draws the row marks on top of the chart, in screen space.
import { rowAt, rowBand, rowHeight, lastRow } from "./rows.js";

const DONE_FILL = "rgba(47, 138, 85, 0.30)";
const DONE_INK = "#2f8a55";
const CURRENT = "#ff5a1f";
const CURRENT_FILL = "rgba(255, 90, 31, 0.10)";
const DIM = "rgba(246, 241, 234, 0.78)";
const CAL = "#1f9d55";

// view: {z, tx, ty, w, h, dpr}  (screen = page * z + t, in CSS px)
const sx = (v, x) => x * v.z + v.tx;
const sy = (v, y) => y * v.z + v.ty;

function pill(ctx, text, x, y, align, bg, fg) {
  ctx.font = "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  const w = ctx.measureText(text).width + 12;
  const h = 20;
  const left = align === "right" ? x - w : x;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y - h / 2, w, h, 6);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + 6, y + 0.5);
  return w;
}

// Merge consecutive done rows into runs so stacked bands have no seams.
function runs(rows) {
  const out = [];
  for (const n of rows) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

export function drawKnit(ctx, v, cal, s) {
  // s: {done:Set, current, hover, dim}
  if (!cal) return;
  const { x0, x1 } = cal.rect;
  const L = sx(v, x0), R = sx(v, x1);
  const rh = rowHeight(cal) * v.z;
  // Visible rows only.
  const ra = rowAt(cal, Math.max(cal.rect.y0, (0 - v.ty) / v.z));
  const rb = rowAt(cal, Math.min(cal.rect.y1, (v.h - v.ty) / v.z));
  const lo = Math.min(ra ?? cal.firstRow, rb ?? lastRow(cal));
  const hi = Math.max(ra ?? cal.firstRow, rb ?? lastRow(cal));
  const visible = [];
  for (let n = Math.max(lo - 1, cal.firstRow); n <= Math.min(hi + 1, lastRow(cal)); n++) visible.push(n);

  // Done rows.
  const doneVisible = visible.filter((n) => s.done.has(n));
  ctx.fillStyle = DONE_FILL;
  for (const [a, b] of runs(doneVisible)) {
    const ba = rowBand(cal, a), bb = rowBand(cal, b);
    const top = sy(v, Math.min(ba.top, bb.top));
    const bottom = sy(v, Math.max(ba.bottom, bb.bottom));
    ctx.fillRect(L, top, R - L, bottom - top);
  }

  // Dim everything except the current row and its neighbours.
  const cb = s.current != null ? rowBand(cal, s.current) : null;
  if (s.dim && cb) {
    const nb1 = rowBand(cal, s.current - 1) || cb;
    const nb2 = rowBand(cal, s.current + 1) || cb;
    const top = sy(v, Math.min(cb.top, nb1.top, nb2.top));
    const bottom = sy(v, Math.max(cb.bottom, nb1.bottom, nb2.bottom));
    ctx.fillStyle = DIM;
    ctx.fillRect(0, 0, v.w, Math.max(0, top));
    ctx.fillRect(0, bottom, v.w, Math.max(0, v.h - bottom));
  }

  // Ticks in the margin when rows are big enough.
  if (rh >= 11) {
    ctx.strokeStyle = DONE_INK;
    ctx.lineWidth = Math.min(2.2, rh / 7);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const size = Math.min(10, rh * 0.6);
    for (const n of doneVisible) {
      const b = rowBand(cal, n);
      const cy = sy(v, (b.top + b.bottom) / 2);
      for (const xx of [L - size - 6, R + 6]) {
        ctx.beginPath();
        ctx.moveTo(xx, cy);
        ctx.lineTo(xx + size * 0.38, cy + size * 0.36);
        ctx.lineTo(xx + size, cy - size * 0.42);
        ctx.stroke();
      }
    }
  }

  // Hovered row.
  if (s.hover != null && s.hover !== s.current) {
    const b = rowBand(cal, s.hover);
    if (b) {
      ctx.strokeStyle = "rgba(47, 39, 34, 0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(L + 0.5, sy(v, b.top) + 0.5, R - L - 1, (b.bottom - b.top) * v.z - 1);
    }
  }

  // Current row: a bright "magnetic ruler" outline.
  if (cb) {
    const top = sy(v, cb.top), bottom = sy(v, cb.bottom);
    ctx.fillStyle = CURRENT_FILL;
    ctx.fillRect(L, top, R - L, bottom - top);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#fff";
    ctx.strokeRect(L - 2.5, top - 2.5, R - L + 5, bottom - top + 5);
    ctx.lineWidth = 2;
    ctx.strokeStyle = CURRENT;
    ctx.strokeRect(L - 2, top - 2, R - L + 4, bottom - top + 4);
    const cy = (top + bottom) / 2;
    if (cy > -20 && cy < v.h + 20) {
      const label = `ряд ${s.current}`;
      const lx = Math.max(4, L - 8);
      if (L - 8 > 70) pill(ctx, label, lx, cy, "right", CURRENT, "#fff");
      else pill(ctx, label, Math.max(4, L + 4), cy, "left", CURRENT, "#fff");
      const rx = Math.min(v.w - 4, R + 8);
      if (v.w - R - 8 > 70) pill(ctx, label, rx, cy, "left", CURRENT, "#fff");
    }
  }
}

// Calibration preview: frame, row lines, handles.
export function drawCalibration(ctx, v, draft) {
  if (!draft || !draft.rect) return;
  const { x0, y0, x1, y1 } = draft.rect;
  const L = sx(v, x0), T = sy(v, y0), R = sx(v, x1), B = sy(v, y1);

  // Shade outside the frame.
  ctx.fillStyle = "rgba(47, 39, 34, 0.18)";
  ctx.beginPath();
  ctx.rect(0, 0, v.w, v.h);
  ctx.rect(L, T, R - L, B - T);
  ctx.fill("evenodd");

  const n = draft.rows;
  if (n > 0) {
    const cal = { rect: draft.rect, rows: n, firstRow: draft.firstRow ?? 1, bottomUp: draft.bottomUp };
    const rh = (B - T) / n;
    const every = rh >= 5 ? 1 : rh * 5 >= 5 ? 5 : rh * 10 >= 5 ? 10 : rh * 50 >= 5 ? 50 : 100;
    ctx.lineWidth = 1;
    const kTop = Math.max(0, Math.floor((0 - T) / rh));
    const kBottom = Math.min(n, Math.ceil((v.h - T) / rh));
    for (let k = kTop; k <= kBottom; k++) {
      const y = T + k * rh;
      // Boundary index counted from the starting edge of the numbering.
      const idx = cal.bottomUp ? n - k : k;
      const major = idx % 10 === 0 || k === 0 || k === n;
      if (!major && idx % every !== 0) continue;
      ctx.strokeStyle = major ? "rgba(31, 157, 85, 0.95)" : "rgba(31, 157, 85, 0.6)";
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(L, Math.round(y) + 0.5);
      ctx.lineTo(R, Math.round(y) + 0.5);
      ctx.stroke();
    }
    // Row numbers in the left margin.
    ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    const labelEvery = rh >= 16 ? 1 : rh * 5 >= 16 ? 5 : rh * 10 >= 16 ? 10 : rh * 50 >= 16 ? 50 : 100;
    for (let k = kTop; k < kBottom; k++) {
      const rowNo = cal.bottomUp ? cal.firstRow + (n - 1 - k) : cal.firstRow + k;
      if ((rowNo - cal.firstRow + 1) % labelEvery !== 0 && rowNo !== cal.firstRow && rowNo !== lastRow(cal)) continue;
      const y = T + (k + 0.5) * rh;
      const text = String(rowNo);
      const w = ctx.measureText(text).width + 8;
      const x = Math.max(w + 2, L - 6);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(x - w, y - 8, w, 16);
      ctx.fillStyle = CAL;
      ctx.fillText(text, x - 4, y);
    }
  }

  // Frame and handles.
  ctx.strokeStyle = CAL;
  ctx.lineWidth = 2;
  ctx.setLineDash(draft.drawing ? [6, 4] : []);
  ctx.strokeRect(L, T, R - L, B - T);
  ctx.setLineDash([]);
  if (!draft.drawing) {
    for (const [hx, hy] of handlePoints(L, T, R, B)) {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = CAL;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(hx - 5, hy - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
    }
  }
}

export function handlePoints(L, T, R, B) {
  const mx = (L + R) / 2, my = (T + B) / 2;
  return [[L, T], [mx, T], [R, T], [R, my], [R, B], [mx, B], [L, B], [L, my]];
}

// Which edge(s) of the frame the pointer grabs: "n", "se", ... or null.
export function hitHandle(v, rect, px, py) {
  const L = sx(v, rect.x0), T = sy(v, rect.y0), R = sx(v, rect.x1), B = sy(v, rect.y1);
  const tol = 8;
  const nearX = (x) => Math.abs(px - x) <= tol;
  const nearY = (y) => Math.abs(py - y) <= tol;
  const inX = px >= L - tol && px <= R + tol;
  const inY = py >= T - tol && py <= B + tol;
  let s = "";
  if (nearY(T) && inX) s += "n";
  else if (nearY(B) && inX) s += "s";
  if (nearX(L) && inY) s += "w";
  else if (nearX(R) && inY) s += "e";
  return s || null;
}
