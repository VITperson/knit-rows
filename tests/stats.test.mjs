import { test } from "node:test";
import assert from "node:assert/strict";
import { knitStats, dayStart, addDays, MAX_GAP } from "../js/stats.js";
import { allRowsOf, progressOf } from "../js/rows.js";

const MIN = 60e3;
// A fixed local "now": 14 Nov 2026, 21:00.
const NOW = new Date(2026, 10, 14, 21, 0).getTime();
const at = (daysAgo, h, m = 0) => new Date(2026, 10, 14 - daysAgo, h, m).getTime();
const rows = Array.from({ length: 10 }, (_, i) => i + 1);

test("no times yet: nothing to show, progress still counted", () => {
  const s = knitStats({ rows, done: new Set([1, 2, 3]), doneAt: undefined, now: NOW });
  assert.equal(s.stamped, 0);
  assert.equal(s.doneUnits, 3);
  assert.equal(s.remaining, 7);
  assert.equal(s.msPerUnit, null);
  assert.equal(s.finish, null);
  assert.equal(s.today.rows, 0);
});

test("rows marked before times were kept are ignored for speed", () => {
  // Rows 1-3 are old (no time), 4-7 were knitted today 10 minutes apart.
  const doneAt = { 4: at(0, 18, 0), 5: at(0, 18, 10), 6: at(0, 18, 20), 7: at(0, 18, 30) };
  const s = knitStats({ rows, done: new Set([1, 2, 3, 4, 5, 6, 7]), doneAt, now: NOW });
  assert.equal(s.stamped, 4);
  assert.equal(s.today.rows, 4);
  assert.equal(s.msPerUnit, 10 * MIN);
  // 3 measured gaps + the first row of the sitting estimated at the median.
  assert.equal(s.todayMs, 40 * MIN);
  assert.equal(s.remainingMs, 3 * 10 * MIN);
  assert.equal(s.finish, null, "one knitting day is not enough for a forecast");
});

test("long pauses and rows marked together do not count as speed", () => {
  const doneAt = {
    1: at(0, 10, 0), 2: at(0, 10, 10), 3: at(0, 10, 20), 4: at(0, 10, 30),
    5: at(0, 10, 30) + 2000, // marked together with 4
    6: at(0, 10, 30) + MAX_GAP + MIN, // after a long break
  };
  const s = knitStats({ rows, done: new Set([1, 2, 3, 4, 5, 6]), doneAt, now: NOW });
  assert.equal(s.msPerUnit, 10 * MIN);
});

test("speed and forecast in stitches when every row's stitches are known", () => {
  // Triangle: row n has 2n+3 stitches.
  const weightOf = (n) => 2 * n + 3;
  // 6 stitches a minute: row n takes (2n+3)*10 s.
  let t = at(1, 19, 0);
  const doneAt = {};
  for (const n of [1, 2, 3]) { t += weightOf(n) * 10e3 + 20e3; doneAt[n] = t; }
  t = at(0, 19, 0);
  for (const n of [4, 5, 6]) { t += weightOf(n) * 10e3 + 20e3; doneAt[n] = t; }
  const s = knitStats({ rows, done: new Set([1, 2, 3, 4, 5, 6]), doneAt, weightOf, now: NOW });
  assert.equal(s.weighted, true);
  assert.equal(s.totalUnits, rows.reduce((a, n) => a + weightOf(n), 0));
  assert.equal(s.doneUnits, [1, 2, 3, 4, 5, 6].reduce((a, n) => a + weightOf(n), 0));
  assert.ok(s.msPerUnit > 10e3 && s.msPerUnit < 15e3, `ms per stitch ${s.msPerUnit}`);
  // Two knitting days in a two-day window: per day = all done units / 2.
  assert.equal(s.windowDays, 2);
  assert.equal(s.perDay, s.doneUnits / 2);
  assert.equal(s.finish, addDays(dayStart(NOW), Math.ceil(s.remaining / s.perDay)));
  assert.equal(s.week.rows, 6);
});

test("unknown stitches in any row fall back to rows", () => {
  const s = knitStats({ rows, done: new Set([1]), doneAt: { 1: at(0, 9) }, weightOf: (n) => (n < 5 ? 3 : null), now: NOW });
  assert.equal(s.weighted, false);
  assert.equal(s.totalUnits, 10);
});

test("rest days lower the pace", () => {
  const doneAt = { 1: at(9, 20), 2: at(9, 20, 10), 3: at(0, 20), 4: at(0, 20, 10) };
  const s = knitStats({ rows, done: new Set([1, 2, 3, 4]), doneAt, now: NOW });
  assert.equal(s.windowDays, 10);
  assert.equal(s.perDay, 4 / 10);
  assert.equal(s.finish, addDays(dayStart(NOW), Math.ceil(6 / 0.4)));
  assert.equal(s.daily.length, 14);
  assert.equal(s.daily[13].rows, 2);
  assert.equal(s.daily[4].rows, 2);
});

test("finished chart has no forecast", () => {
  const doneAt = Object.fromEntries(rows.map((n) => [n, at(n % 2, 12, n)]));
  const s = knitStats({ rows, done: new Set(rows), doneAt, now: NOW });
  assert.equal(s.remaining, 0);
  assert.equal(s.finish, null);
});

test("calendar days survive daylight-saving changes", () => {
  // Europe moves the clocks on the last Sunday of March and October.
  const a = new Date(2026, 2, 28, 12).getTime();
  assert.equal(new Date(addDays(a, 1)).getDate(), 29);
  assert.equal(new Date(addDays(a, 2)).getDate(), 30);
  assert.equal(new Date(addDays(dayStart(a), 2)).getHours(), 0);
});

// --- charts saved by the first version ------------------------------------------

test("a chart saved before this update keeps its progress", () => {
  // Exactly what version 1 stored: no doneAt, no stitch fields, no cols.
  const v1 = {
    id: "x", name: "Шарф", pages: [{ cal: { rect: { x0: 16.5, y0: 16.5, x1: 825.4, y1: 555.8 }, rows: 226, firstRow: 1, bottomUp: true, auto: true }, skip: false, confirmed: true }],
    done: Array.from({ length: 57 }, (_, i) => i + 1), dim: false, view: null,
  };
  const p = progressOf(v1.pages, v1.done);
  assert.deepEqual(p, { done: 57, total: 226, next: 58 });
  const s = knitStats({ rows: allRowsOf(v1.pages), done: new Set(v1.done), doneAt: v1.doneAt, now: NOW });
  assert.equal(s.doneUnits, 57);
  assert.equal(s.stamped, 0);
});
