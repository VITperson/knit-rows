// Knitting statistics from the moment each row was marked. Pure functions, no
// DOM: shared by the app and the Node tests.
//
// Rows marked before the app kept times have no time: they count for
// progress, not for speed or the forecast.
//
// "Units" are stitches when the stitches of every row are known, otherwise
// rows: in a triangle shawl the first row has 5 stitches and the last 339, so
// a forecast in rows would be far too optimistic.

const DAY = 864e5;
export const MAX_GAP = 90 * 60e3; // a longer pause between two rows is a break
export const MIN_GAP = 15e3; // rows marked together (catching up, Shift+click)

export function dayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Calendar arithmetic (safe across daylight-saving changes).
export function addDays(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// rows: every row number of the chart; done: Set of knitted rows;
// doneAt: {row: ms}; weightOf(n): stitches in row n, or null when unknown.
export function knitStats({ rows, done, doneAt, weightOf = null, now = Date.now(), days = 14 }) {
  const weighted = !!weightOf && rows.length > 0 && rows.every((n) => weightOf(n) != null);
  const w = (n) => (weighted ? weightOf(n) : 1);
  const at = doneAt || {};

  let totalUnits = 0, doneUnits = 0;
  for (const n of rows) {
    totalUnits += w(n);
    if (done.has(n)) doneUnits += w(n);
  }
  const remaining = totalUnits - doneUnits;

  const stamps = rows
    .filter((n) => done.has(n) && at[n] > 0)
    .map((n) => ({ n, t: at[n] }))
    .sort((a, b) => a.t - b.t || a.n - b.n);

  // Speed: the pause before a row, per unit of that row.
  const gaps = stamps.map((s, i) => (i ? s.t - stamps[i - 1].t : Infinity));
  const timed = (i) => gaps[i] >= MIN_GAP && gaps[i] <= MAX_GAP && w(stamps[i].n) > 0;
  const rates = [];
  stamps.forEach((s, i) => { if (timed(i)) rates.push(gaps[i] / w(s.n)); });
  const msPerUnit = rates.length >= 3 ? median(rates) : null;

  // Day by day.
  const today = dayStart(now);
  const daily = [];
  for (let k = days - 1; k >= 0; k--) daily.push({ start: addDays(today, -k), rows: 0, units: 0 });
  const byDay = new Map(daily.map((d, i) => [d.start, i]));
  let todayMs = 0;
  stamps.forEach((s, i) => {
    const d = dayStart(s.t);
    const k = byDay.get(d);
    if (k !== undefined) { daily[k].rows++; daily[k].units += w(s.n); }
    if (d === today) {
      // The first row of a sitting has no measured time: estimate it.
      if (timed(i)) todayMs += gaps[i];
      else if (msPerUnit) todayMs += msPerUnit * w(s.n);
    }
  });
  const week = daily.slice(-7).reduce((a, d) => ({ rows: a.rows + d.rows, units: a.units + d.units }), { rows: 0, units: 0 });

  // Forecast: units per calendar day (rest days included) since the first
  // timed day of the window, once there are at least two knitting days.
  let finish = null, perDay = null, windowDays = 0;
  if (stamps.length && remaining > 0) {
    const winStart = Math.max(dayStart(stamps[0].t), daily[0].start);
    const inWin = daily.filter((d) => d.start >= winStart);
    const active = inWin.filter((d) => d.rows > 0).length;
    const units = inWin.reduce((a, d) => a + d.units, 0);
    if (active >= 2 && units > 0) {
      windowDays = inWin.length;
      perDay = units / windowDays;
      finish = addDays(today, Math.ceil(remaining / perDay));
    }
  }

  return {
    weighted,
    stamped: stamps.length,
    totalUnits, doneUnits, remaining,
    today: daily[daily.length - 1],
    todayMs,
    week,
    daily,
    msPerUnit,
    remainingMs: msPerUnit ? remaining * msPerUnit : null,
    perDay,
    windowDays,
    finish,
  };
}
