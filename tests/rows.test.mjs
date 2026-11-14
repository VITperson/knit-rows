import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  rowAt, rowBand, rowHeight, lastRow, normRect,
  labelPoints, detectCalibration, detectSequence,
} from "../js/rows.js";

const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} ±${tol}, got ${a}`);

// --- geometry ---------------------------------------------------------------

const cal = { rect: { x0: 10, y0: 100, x1: 210, y1: 300 }, rows: 20, firstRow: 1, bottomUp: true };

test("row height and last row", () => {
  assert.equal(rowHeight(cal), 10);
  assert.equal(lastRow(cal), 20);
});

test("bottom-up numbering: row 1 at the bottom", () => {
  assert.equal(rowAt(cal, 299), 1);
  assert.equal(rowAt(cal, 291), 1);
  assert.equal(rowAt(cal, 289), 2);
  assert.equal(rowAt(cal, 101), 20);
  assert.deepEqual(rowBand(cal, 1), { top: 290, bottom: 300 });
  assert.deepEqual(rowBand(cal, 20), { top: 100, bottom: 110 });
});

test("top-down numbering and first row other than 1", () => {
  const c = { ...cal, bottomUp: false, firstRow: 41 };
  assert.equal(rowAt(c, 101), 41);
  assert.equal(rowAt(c, 299), 60);
  assert.deepEqual(rowBand(c, 41), { top: 100, bottom: 110 });
  assert.equal(rowBand(c, 40), null);
  assert.equal(rowBand(c, 61), null);
});

test("outside the grid is no row", () => {
  assert.equal(rowAt(cal, 99), null);
  assert.equal(rowAt(cal, 301), null);
  assert.equal(rowAt(cal, 200, 5), null);
  assert.equal(rowAt(cal, 200, 215), null);
  assert.equal(rowAt(cal, 205, 100), 10);
});

test("band centre maps back to the same row for every row", () => {
  for (let n = 1; n <= 20; n++) {
    const b = rowBand(cal, n);
    assert.equal(rowAt(cal, (b.top + b.bottom) / 2), n);
  }
});

test("rectangle drawn in any direction is normalised", () => {
  assert.deepEqual(normRect({ x: 50, y: 80 }, { x: 10, y: 20 }), { x0: 10, y0: 20, x1: 50, y1: 80 });
});

// --- detection on synthetic labels -------------------------------------------

function label(n, x, y) { return { n, x, y, w: 4 }; }

test("labels every 10th row on one side: rows start at 1", () => {
  // Rows 1..60, pitch 5, row 1 centred at y=400, labels at the right.
  const pts = [];
  for (let n = 10; n <= 60; n += 10) pts.push(label(n, 300, 400 - (n - 1) * 5));
  const c = detectCalibration(pts, 320, 450);
  assert.ok(c);
  assert.equal(c.firstRow, 1);
  assert.equal(c.rows, 60);
  assert.equal(c.bottomUp, true);
  near(c.rect.y1, 402.5, 0.01);
  near(c.rect.y0, 402.5 - 60 * 5, 0.01);
  assert.ok(c.rect.x1 < 300, "grid ends before the label column");
});

test("top-down chart with labels on the left", () => {
  const pts = [];
  for (let n = 1; n <= 30; n++) pts.push(label(n, 8, 50 + (n - 1) * 4));
  const c = detectCalibration(pts, 200, 200);
  assert.equal(c.bottomUp, false);
  assert.equal(c.firstRow, 1);
  assert.equal(c.rows, 30);
  near(c.rect.y0, 48, 0.01);
  assert.ok(c.rect.x0 > 8);
});

test("a stray number in line with the rows is ignored", () => {
  const pts = [];
  for (let n = 1; n <= 30; n++) pts.push(label(n, 8, 200 - n * 4));
  pts.push(label(31, 120, 200 - 31 * 4)); // e.g. a stitch number
  const s = detectSequence(pts, "y");
  assert.equal(s.nMax, 30);
});

test("no labels -> no calibration", () => {
  assert.equal(detectCalibration([label(1, 10, 10), label(2, 10, 14)], 100, 100), null);
});

// --- detection on the real sample (skipped when the sample is absent) ---------

const SAMPLE = fileURLToPath(new URL("../samples/scarf-m.pdf", import.meta.url));

test("Stitch Fiddle sample: 226 rows, grid edges match the cells", { skip: !existsSync(SAMPLE) }, async () => {
  const { getDocument } = await import("../node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(readFileSync(SAMPLE)), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const c = detectCalibration(labelPoints(tc.items, vp.transform), vp.width, vp.height);
  assert.ok(c, "calibration found");
  assert.equal(c.firstRow, 1);
  assert.equal(c.rows, 226);
  assert.equal(c.bottomUp, true);
  const h = rowHeight(c);
  near(h, 2.386, 0.005, "row pitch");
  // Cells in the PDF: top row's top edge at y_up=578.44, bottom row's bottom
  // edge at y_up=41.57-2.386; page height 595, y flipped.
  const tol = 0.1 * h;
  near(c.rect.y0, 595 - 578.44, tol, "top edge");
  near(c.rect.y1, 595 - (41.57 - 2.386), tol, "bottom edge");
  near(c.rect.x0, 16.56, tol, "left edge");
  near(c.rect.x1, 823.05 + 2.39, tol, "right edge");
  await task.destroy();
});

// --- stitches inside a row ---------------------------------------------------------

import {
  colAt, colWidth, squareCols, rowStart, stitchCount, stitchCol, stitchIndex, knittedCols,
  spanOf, cellInk, spansKey, rowSpan, startSides,
} from "../js/rows.js";

test("columns of the grid", () => {
  const c = { ...cal, cols: 20 };
  assert.equal(colWidth(c), 10);
  assert.equal(colAt(c, 10), 0);
  assert.equal(colAt(c, 19.9), 0);
  assert.equal(colAt(c, 20), 1);
  assert.equal(colAt(c, 210), 19);
  assert.equal(colAt(c, 9), null);
  assert.equal(squareCols(cal.rect, cal.rows), 20);
});

test("row direction: flat knitting alternates, labels decide", () => {
  assert.equal(rowStart(null, 1), "right");
  assert.equal(rowStart(null, 2), "left");
  assert.equal(rowStart({ odd: "left", even: "right" }, 13), "left");
  assert.equal(rowStart({ odd: "right", even: "right" }, 14), "right");
});

test("stitch order from either side", () => {
  const span = [5, 9]; // 5 stitches in columns 5..9
  assert.equal(stitchCount(span), 5);
  assert.equal(stitchCount(null), 0);
  assert.equal(stitchCol(span, "right", 0), 9);
  assert.equal(stitchCol(span, "left", 0), 5);
  assert.equal(stitchIndex(span, "right", 9), 0);
  assert.equal(stitchIndex(span, "right", 5), 4);
  assert.equal(stitchIndex(span, "left", 7), 2);
  assert.equal(stitchIndex(span, "left", 2), 0, "a click left of the row snaps to its first stitch");
  assert.deepEqual(knittedCols(span, "right", 2), [8, 10]);
  assert.deepEqual(knittedCols(span, "left", 2), [5, 7]);
  assert.deepEqual(knittedCols(span, "left", 0), [5, 5]);
});

test("a row's span is its first and last drawn cell", () => {
  const filled = new Set([3, 4, 6, 8]);
  assert.deepEqual(spanOf(12, (c) => filled.has(c)), [3, 8]);
  assert.deepEqual(spanOf(12, (c) => c === 7), [7, 7]);
  assert.equal(spanOf(12, () => false), null);
});

test("cell ink: symbols, colours and grey fills count, white does not", () => {
  const W = 4, H = 4;
  const img = (rgb) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) d.set([...rgb, 255], i * 4); return d; };
  assert.equal(cellInk(img([255, 255, 255]), W, 0, 0, W, H), false);
  assert.equal(cellInk(img([250, 248, 252]), W, 0, 0, W, H), false, "near white");
  assert.equal(cellInk(img([167, 205, 209]), W, 0, 0, W, H), true, "pale teal");
  assert.equal(cellInk(img([160, 160, 160]), W, 0, 0, W, H), true, "grey fill");
  const sym = img([255, 255, 255]);
  sym.set([20, 20, 20, 255], (1 * W + 2) * 4); // one dark pixel
  assert.equal(cellInk(sym, W, 0, 0, W, H), true);
  assert.equal(cellInk(sym, W, 0, 2, W, H), false, "outside the box");
});

test("stored spans are used only for the grid they were read from", () => {
  const c = { ...cal, cols: 20 };
  c.spans = Array.from({ length: 20 }, (_, k) => [10 - Math.floor(k / 2), 10 + Math.floor(k / 2)]);
  c.spansKey = spansKey(c);
  assert.deepEqual(rowSpan(c, 1), [10, 10]);
  assert.deepEqual(rowSpan(c, 20), [1, 19]);
  const moved = { ...c, rect: { ...c.rect, x1: 220 } };
  assert.equal(rowSpan(moved, 1), undefined);
  assert.equal(rowSpan({ ...cal }, 1), undefined, "old charts have no spans");
});

test("start sides from where odd and even numbers are printed", () => {
  const L = (n) => ({ n, x: 5, y: 0, w: 4 }), R = (n) => ({ n, x: 300, y: 0, w: 4 });
  assert.deepEqual(startSides([R(1), L(2), R(3), L(4)], 150), { odd: "right", even: "left" });
  assert.deepEqual(startSides([R(1), R(2), R(3), R(4)], 150), { odd: "right", even: "right" });
  assert.equal(startSides([R(10), R(20), R(30)], 150), null, "only even numbers: unknown");
});

test("Stitch Fiddle sample: 339 stitches across, row sides from the labels", { skip: !existsSync(SAMPLE) }, async () => {
  const { getDocument } = await import("../node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(readFileSync(SAMPLE)), verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const c = detectCalibration(labelPoints(tc.items, vp.transform), vp.width, vp.height);
  assert.equal(c.cols, 339);
  near(colWidth(c), rowHeight(c), 0.01, "square cells");
  assert.deepEqual(c.start, { odd: "left", even: "right" });
  await task.destroy();
});

// --- clicking a row: knitted up to here ------------------------------------------

import { clickPlan, gapsOf, rangesText } from "../js/rows.js";

const R = Array.from({ length: 100 }, (_, i) => i + 1);
const upTo = (n) => new Set(R.filter((r) => r <= n));

test("click on a row ahead marks every row up to it", () => {
  const p = clickPlan(R, upTo(57), 77);
  assert.deepEqual(p.add, R.filter((r) => r >= 58 && r <= 77));
  assert.deepEqual(p.remove, []);
});

test("click on the current row marks just it", () => {
  assert.deepEqual(clickPlan(R, upTo(57), 58), { add: [58], remove: [] });
});

test("click on the last knitted row takes only it back", () => {
  assert.deepEqual(clickPlan(R, upTo(57), 57), { add: [], remove: [57] });
});

test("click on an earlier knitted row goes back to it", () => {
  const p = clickPlan(R, upTo(57), 30);
  assert.deepEqual(p.add, []);
  assert.deepEqual(p.remove, R.filter((r) => r >= 31 && r <= 57));
});

test("click fills gaps left by earlier single-row marks", () => {
  // Version 1 toggled single rows: 1..57 and 77 marked, 58..76 not.
  const done = upTo(57); done.add(77);
  assert.deepEqual(clickPlan(R, done, 76).add, R.filter((r) => r >= 58 && r <= 76));
  assert.deepEqual(clickPlan(R, done, 77), { add: [], remove: [77] });
  const p = clickPlan(R, done, 80);
  assert.deepEqual(p.add, R.filter((r) => (r >= 58 && r <= 76) || (r >= 78 && r <= 80)));
});

test("rows from a first row other than 1", () => {
  const rows = [41, 42, 43, 44, 45];
  assert.deepEqual(clickPlan(rows, new Set(), 43), { add: [41, 42, 43], remove: [] });
});

test("gaps below the last knitted row", () => {
  const done = upTo(57); done.add(77); done.delete(10);
  assert.deepEqual(gapsOf(R, done), [10, ...R.filter((r) => r >= 58 && r <= 76)]);
  assert.deepEqual(gapsOf(R, upTo(57)), []);
  assert.deepEqual(gapsOf(R, new Set()), []);
});

test("row ranges in words", () => {
  assert.equal(rangesText([58, 59, 60, 64]), "58–60, 64");
  assert.equal(rangesText([5]), "5");
  assert.equal(rangesText([1, 3, 5, 7, 9]), "1, 3, 5, …");
});
