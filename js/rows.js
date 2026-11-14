// Row geometry and automatic row detection. Pure functions, no DOM:
// shared by the app and the Node tests.
//
// Coordinates are "page units": the pdf.js viewport at scale 1, x to the
// right, y DOWN, origin at the top-left corner of the rendered page.
//
// A calibration describes one chart grid on one page:
//   { rect: {x0, y0, x1, y1}, rows, firstRow, bottomUp,
//     cols?, start?, spans?, spansKey? }
// rect is the outer border of the grid, rows is the number of rows inside it,
// firstRow is the number of the row next to the starting edge, bottomUp says
// the numbering grows upwards (the usual knitting-chart convention).
// cols is the number of cells across; start says on which side odd and even
// rows begin ({odd, even}: "left" | "right", from where the row numbers are
// printed); spans[k] is the [first, last] column that holds a stitch in the
// k-th row from firstRow (read from the rendered page), null for an empty row.
// The optional fields were added later: older saved charts lack them.

export const DEFAULT_START = { odd: "right", even: "left" };

export function rowHeight(cal) {
  return (cal.rect.y1 - cal.rect.y0) / cal.rows;
}

export function colWidth(cal) {
  return (cal.rect.x1 - cal.rect.x0) / cal.cols;
}

// Column (0 = leftmost) at page-x, or null outside the grid.
export function colAt(cal, x) {
  if (!cal.cols || x < cal.rect.x0 || x > cal.rect.x1) return null;
  return Math.min(cal.cols - 1, Math.max(0, Math.floor((x - cal.rect.x0) / colWidth(cal))));
}

// Cells across for a grid whose stitch numbers were not found: square cells.
export function squareCols(rect, rows) {
  const h = (rect.y1 - rect.y0) / rows;
  return Math.max(1, Math.round((rect.x1 - rect.x0) / h));
}

// Side where row n begins.
export function rowStart(start, n) {
  const s = start || DEFAULT_START;
  return Math.abs(n) % 2 === 1 ? s.odd : s.even;
}

// --- stitches inside a row ----------------------------------------------------
// A row's stitches are the columns span[0]..span[1]; they are knitted from the
// row's start side. k = stitches already knitted.

export function stitchCount(span) {
  return span ? span[1] - span[0] + 1 : 0;
}

// Column of the i-th stitch (0-based) in knitting order.
export function stitchCol(span, side, i) {
  return side === "left" ? span[0] + i : span[1] - i;
}

// Knitting-order index of the stitch in column c (snapped into the row).
export function stitchIndex(span, side, c) {
  const cc = Math.min(span[1], Math.max(span[0], c));
  return side === "left" ? cc - span[0] : span[1] - cc;
}

// Columns [from, to) covered by the first k stitches.
export function knittedCols(span, side, k) {
  return side === "left" ? [span[0], span[0] + k] : [span[1] + 1 - k, span[1] + 1];
}

// First and last column of a row that hold a stitch. isFilled(c) -> bool.
export function spanOf(cols, isFilled) {
  let a = -1;
  for (let c = 0; c < cols; c++) if (isFilled(c)) { a = c; break; }
  if (a < 0) return null;
  let b = a;
  for (let c = cols - 1; c > a; c--) if (isFilled(c)) { b = c; break; }
  return [a, b];
}

// Is anything drawn inside a cell? data: RGBA pixels of an image `width`
// wide; the box (x0, y0)-(x1, y1) is the inside of the cell without its grid
// lines. A dark symbol, a coloured cell or a grey fill counts; white does not.
export function cellInk(data, width, x0, y0, x1, y1) {
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 110 || mx - mn > 45) return true;
      sum += mx;
      count++;
    }
  }
  return count > 0 && sum / count < 215;
}

export function spansKey(cal) {
  const r = cal.rect;
  return [cal.rows, cal.firstRow, cal.cols, r.x0, r.y0, r.x1, r.y1].map((v) => Math.round(v * 100)).join(",");
}

// Span of row n, or undefined when not known (yet).
export function rowSpan(cal, n) {
  if (!cal || !cal.spans || cal.spansKey !== spansKey(cal)) return undefined;
  const s = cal.spans[n - cal.firstRow];
  return s === undefined ? undefined : s;
}

export function lastRow(cal) {
  return cal.firstRow + cal.rows - 1;
}

// Row number at page-y (and optionally page-x), or null outside the grid.
export function rowAt(cal, y, x) {
  const { x0, y0, x1, y1 } = cal.rect;
  if (y < y0 || y > y1) return null;
  if (x !== undefined && (x < x0 || x > x1)) return null;
  const h = rowHeight(cal);
  let k = cal.bottomUp ? Math.floor((y1 - y) / h) : Math.floor((y - y0) / h);
  k = Math.min(Math.max(k, 0), cal.rows - 1);
  return cal.firstRow + k;
}

// Top and bottom page-y of row n, or null if the row is not on this grid.
export function rowBand(cal, n) {
  const k = n - cal.firstRow;
  if (k < 0 || k >= cal.rows) return null;
  const h = rowHeight(cal);
  const { y0, y1 } = cal.rect;
  return cal.bottomUp
    ? { top: y1 - (k + 1) * h, bottom: y1 - k * h }
    : { top: y0 + k * h, bottom: y0 + (k + 1) * h };
}

export function hasRow(cal, n) {
  return !!cal && n >= cal.firstRow && n <= lastRow(cal);
}

// Normalise a rectangle drawn in any direction.
export function normRect(a, b) {
  return {
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
  };
}

// ---------------------------------------------------------------------------
// Automatic detection from the PDF text layer.
//
// Chart editors (Stitch Fiddle and others) print row numbers as text beside
// the grid: one column of numbers, or two (odd rows on one side, even on the
// other), sometimes only every 5th or 10th row. We look for numeric labels
// whose position changes linearly with their value, which gives the row
// pitch and the position of every row. Stitch numbers along the top or bottom
// edge are found the same way along x and give the width of the grid.

// pdf.js textContent items -> numeric label points in page units.
// viewportTransform: page.getViewport({scale: 1}).transform
export function labelPoints(items, viewportTransform) {
  const [A, B, C, D, E, F] = viewportTransform;
  const out = [];
  for (const it of items) {
    const s = (it.str || "").trim();
    if (!/^\d{1,4}$/.test(s)) continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6) continue; // rotated text
    const fh = Math.abs(d) || it.height || 0;
    const w = it.width || 0;
    // Glyph centre in PDF space: middle of the advance width, ~0.35em above
    // the baseline (half the height of a digit).
    const px = e + w / 2;
    const py = f + 0.35 * fh;
    out.push({
      n: Number(s),
      x: A * px + C * py + E,
      y: B * px + D * py + F,
      w: Math.abs(A * w + B * 0) || w,
    });
  }
  return out;
}

// Least-squares fit pos = c + p*n.
function fit(pts, pos) {
  const m = pts.length;
  let sn = 0, sp = 0, snn = 0, snp = 0;
  for (const q of pts) { sn += q.n; sp += q[pos]; snn += q.n * q.n; snp += q.n * q[pos]; }
  const den = m * snn - sn * sn;
  if (!den) return null;
  const p = (m * snp - sn * sp) / den;
  return { p, c: (sp - p * sn) / m };
}

function inliersOf(points, pos, model, tol) {
  const lim = Math.abs(model.p) * tol;
  return points.filter((q) => Math.abs(q[pos] - (model.c + model.p * q.n)) < lim);
}

// Labels of a sequence stand in one or two columns (rows) or lines
// (stitches). A stray number that happens to fit the line elsewhere on the
// page (a stitch number "227" at the level where row 227 would be) is
// dropped: it has no column of its own.
function columnsOnly(pts, cross) {
  if (pts.length < 4) return pts;
  const sorted = [...pts].sort((u, v) => u[cross] - v[cross]);
  const groups = [[sorted[0]]];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k][cross] - sorted[k - 1][cross] > 6) groups.push([]);
    groups[groups.length - 1].push(sorted[k]);
  }
  const min = Math.max(3, pts.length * 0.1);
  const kept = groups.filter((g) => g.length >= min).flat();
  return kept.length >= 4 ? kept : pts;
}

function distinctCount(pts) {
  return new Set(pts.map((q) => q.n)).size;
}

// Find the best linear label sequence along `pos` ("y" for rows, "x" for
// stitches). Labels of one sequence share roughly the same `cross` coordinate
// per column. Returns {p, c, nMin, nMax, step, inliers} or null.
export function detectSequence(points, pos, opts = {}) {
  const cross = pos === "y" ? "x" : "y";
  const minPitch = opts.minPitch ?? 0.5;
  const minDistinct = opts.minDistinct ?? 4;
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    // Candidate partners: labels in the same column with a nearby value.
    const partners = [];
    for (let j = 0; j < points.length; j++) {
      const b = points[j];
      if (j === i || b.n === a.n) continue;
      if (Math.abs(b[cross] - a[cross]) > 6) continue;
      const dn = Math.abs(b.n - a.n);
      if (dn > 20) continue;
      partners.push(b);
    }
    partners.sort((u, v) => Math.abs(u[pos] - a[pos]) - Math.abs(v[pos] - a[pos]));
    for (const b of partners.slice(0, 3)) {
      const p = (b[pos] - a[pos]) / (b.n - a.n);
      if (Math.abs(p) < minPitch) continue;
      const model = { p, c: a[pos] - p * a.n };
      const inl = inliersOf(points, pos, model, 0.3);
      const score = distinctCount(inl);
      if (!best || score > best.score) best = { score, model };
    }
  }
  if (!best || best.score < minDistinct) return null;

  // Refine twice with least squares on the inliers.
  let model = best.model;
  let inl = inliersOf(points, pos, model, 0.3);
  for (let r = 0; r < 3; r++) {
    inl = columnsOnly(inl, cross);
    const m = fit(inl, pos);
    if (!m || Math.abs(m.p) < minPitch) break;
    model = m;
    inl = inliersOf(points, pos, model, 0.25);
  }
  inl = columnsOnly(inl, cross);
  const ns = [...new Set(inl.map((q) => q.n))].sort((u, v) => u - v);
  if (ns.length < minDistinct) return null;
  let step = Infinity;
  for (let k = 1; k < ns.length; k++) step = Math.min(step, ns[k] - ns[k - 1]);
  if (!isFinite(step)) step = 1;
  return { p: model.p, c: model.c, nMin: ns[0], nMax: ns[ns.length - 1], step, inliers: inl };
}

// Labels every 5th/10th row: the unlabeled rows before the first label still
// belong to the grid (10, 20, 30 -> rows start at 1; 110, 120 -> at 101).
function firstOf(seq) {
  return seq.step > 1 ? Math.max(1, seq.nMin - seq.step + 1) : seq.nMin;
}

// Detect the chart grid on a page. Returns a calibration or null.
export function detectCalibration(points, pageWidth, pageHeight) {
  const rows = detectSequence(points, "y");
  if (!rows) return null;
  const first = firstOf(rows);
  const last = rows.nMax;
  const pitch = Math.abs(rows.p);
  const yA = rows.c + rows.p * first;
  const yB = rows.c + rows.p * last;
  const y0 = Math.max(0, Math.min(yA, yB) - pitch / 2);
  const y1 = Math.min(pageHeight, Math.max(yA, yB) + pitch / 2);

  let x0 = 0, x1 = pageWidth;
  let open = null; // a side of the grid we could not locate from text
  let colCount = null;
  // Stitch numbers along x give the exact width of the grid.
  const stitchPts = points.filter((q) => q.y < y0 + pitch || q.y > y1 - pitch);
  const cols = detectSequence(stitchPts, "x");
  if (cols && Math.abs(Math.abs(cols.p) - pitch) < pitch * 0.6) {
    const cf = firstOf(cols);
    const xa = cols.c + cols.p * cf;
    const xb = cols.c + cols.p * cols.nMax;
    x0 = Math.min(xa, xb) - Math.abs(cols.p) / 2;
    x1 = Math.max(xa, xb) + Math.abs(cols.p) / 2;
    colCount = cols.nMax - cf + 1;
  } else {
    // Otherwise the grid sits between the row-label columns.
    const xs = rows.inliers.map((q) => q.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const left = rows.inliers.filter((q) => q.x < mid);
    const right = rows.inliers.filter((q) => q.x >= mid);
    const span = Math.max(...xs) - Math.min(...xs);
    const gap = pitch * 0.2;
    if (span > pitch * 4 && left.length && right.length) {
      x0 = Math.max(...left.map((q) => q.x + q.w / 2)) + gap;
      x1 = Math.min(...right.map((q) => q.x - q.w / 2)) - gap;
    } else if (xs[0] > pageWidth / 2) {
      x1 = Math.min(...rows.inliers.map((q) => q.x - q.w / 2)) - gap;
      open = "left";
    } else {
      x0 = Math.max(...rows.inliers.map((q) => q.x + q.w / 2)) + gap;
      open = "right";
    }
  }
  const rect = { x0, y0, x1, y1 };
  const rowCount = last - first + 1;
  return {
    rect,
    rows: rowCount,
    firstRow: first,
    bottomUp: rows.p < 0,
    cols: colCount ?? squareCols(rect, rowCount),
    start: startSides(rows.inliers, (x0 + x1) / 2),
    auto: true,
    ...(open ? { open } : {}),
  };
}

// Charts print a row's number on the side where the row begins. Both odd and
// even numbers must be seen to tell flat knitting from knitting in the round.
export function startSides(labels, midX) {
  const side = (odd) => {
    const xs = labels.filter((q) => (q.n % 2 === 1) === odd).map((q) => q.x);
    if (!xs.length) return null;
    const left = xs.filter((x) => x < midX).length;
    if (left > xs.length * 0.8) return "left";
    if (left < xs.length * 0.2) return "right";
    return null;
  };
  const odd = side(true), even = side(false);
  return odd && even ? { odd, even } : null;
}

// ---------------------------------------------------------------------------
// Project-level progress. pages: [{cal, skip}], done: row numbers.

export function allRowsOf(pages) {
  const set = new Set();
  for (const p of pages || []) {
    if (!p || p.skip || !p.cal) continue;
    for (let n = p.cal.firstRow; n <= lastRow(p.cal); n++) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

export function progressOf(pages, done) {
  const rows = allRowsOf(pages);
  const set = new Set(done || []);
  let count = 0;
  let maxDone = -Infinity;
  for (const n of rows) if (set.has(n)) { count++; maxDone = n; }
  const next = rows.length ? (maxDone === -Infinity ? rows[0] : rows.find((n) => n > maxDone) ?? null) : null;
  return { done: count, total: rows.length, next };
}
