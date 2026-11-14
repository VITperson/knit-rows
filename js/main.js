// App shell: routing between the library and a chart, panels, keys, saving.
import * as db from "./db.js";
import { Library, saveBackup } from "./library.js";
import { Viewer } from "./viewer.js";
import { Calibrator, plural } from "./calibrate.js";
import { knitStats } from "./stats.js";
import { rangesText } from "./rows.js";

const $ = (id) => document.getElementById(id);

// --- small UI helpers --------------------------------------------------------

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// A simple overlay spinner for the library (re-uses the viewer one by moving it).
const libBusy = (() => {
  const box = document.createElement("div");
  box.className = "loading";
  box.style.position = "fixed";
  box.style.zIndex = "30";
  box.hidden = true;
  box.innerHTML = '<span class="spinner"></span><span></span>';
  document.body.append(box);
  return (text) => {
    if (text) { box.lastChild.textContent = text; box.hidden = false; }
    else box.hidden = true;
  };
})();

function ask({ title, text = "", input = null, okText = "OK", cancelText = "Отмена", danger = false }) {
  const dlg = $("dlg");
  $("dlg-title").textContent = title;
  $("dlg-text").textContent = text;
  $("dlg-text").hidden = !text;
  const inp = $("dlg-input");
  inp.hidden = input == null;
  inp.value = input ?? "";
  $("dlg-ok").textContent = okText;
  $("dlg-cancel").textContent = cancelText;
  dlg.classList.toggle("danger", danger);
  dlg.returnValue = "";
  dlg.showModal();
  if (input != null) { inp.focus(); inp.select(); }
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "ok") resolve(input != null ? null : false);
      else resolve(input != null ? inp.value : true);
    }, { once: true });
  });
}

// --- saving (debounced, flushed when the page hides) ------------------------

const pending = new Map();
let saveTimer = 0;
function scheduleSave(project, delay = 250) {
  pending.set(project.id, project);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, delay);
}
async function flushSaves() {
  clearTimeout(saveTimer);
  const items = [...pending.values()];
  pending.clear();
  for (const p of items) {
    try { await db.putProject(structuredClone(p)); }
    catch (e) { console.error(e); toast("Не получилось сохранить отметки"); }
  }
}
addEventListener("pagehide", flushSaves);
document.addEventListener("visibilitychange", () => { if (document.hidden) flushSaves(); });

// --- screens -------------------------------------------------------------------

const library = new Library({
  open: (id) => { location.hash = "#/p/" + id; },
  toast,
  ask,
  busy: libBusy,
});

const viewer = new Viewer({
  onChange: (p, { view } = {}) => scheduleSave(p, view ? 600 : 250),
  onProgress: updatePanel,
  onZoom: (pct) => { $("zoom-label").textContent = pct + "%"; },
  onPage: (i, n) => {
    $("pager").hidden = n <= 1;
    $("page-label").textContent = `Стр. ${i + 1} из ${n}`;
    $("btn-prev-page").disabled = i <= 0;
    $("btn-next-page").disabled = i >= n - 1;
  },
  toast,
});

const calibrator = new Calibrator(viewer, {
  onChange: (p) => scheduleSave(p, 0),
  onShow: (on) => {
    $("knit-panel").hidden = on;
    $("btn-calibrate").disabled = on;
  },
  onDone: () => {
    viewer.ensureSpans();
    updatePanel();
    const prog = viewer.progress();
    if (!prog.total) {
      toast("На схеме не размечено ни одного ряда. Нажмите «Разметка», чтобы обвести сетку.", 5000);
      return;
    }
    viewer.centerRow(prog.next ?? prog.total, true);
  },
});

function updatePanel() {
  if (!viewer.project) return;
  const { done, total, next } = viewer.progress();
  $("p-done").textContent = done;
  $("p-total").textContent = total;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("p-bar").style.width = pct + "%";
  $("p-pct").textContent = total ? `${pct}% · осталось ${total - done} ${plural(total - done, "ряд", "ряда", "рядов")}` : "";
  const finished = total > 0 && next == null;
  $("btn-next").hidden = finished || total === 0;
  $("finished").hidden = !finished;
  $("next-row").textContent = next ?? "—";
  $("btn-undo").disabled = !viewer.canUndo();
  $("chk-dim").checked = !!viewer.project.dim;
  $("chk-stitches").checked = viewer.stitchesOn();
  const gaps = viewer.gaps();
  $("gap-note").hidden = !gaps.length;
  if (gaps.length) {
    $("gap-text").textContent = `Не отмечены ${gaps.length === 1 ? "ряд" : "ряды"} ${rangesText(gaps)}`;
  }
  updateStitchBox(finished);
  updateStats();
}

// --- stitches in the current row ----------------------------------------------

function updateStitchBox(finished) {
  const box = $("stitch-box");
  const info = viewer.stitchesOn() && !finished ? viewer.stitchInfo() : null;
  box.hidden = !info;
  if (!info) return;
  $("s-row").textContent = info.row;
  $("btn-dir").textContent = info.side === "left" ? "→ слева направо" : "← справа налево";
  const known = !!info.span;
  $("s-count").hidden = !known;
  $("s-steps").hidden = !known;
  $("s-wait").hidden = known;
  $("s-wait").textContent = info.span === null
    ? "В этом ряду на схеме нет петель."
    : "Считаю клетки ряда… Если не получается, увеличьте схему или проверьте «Разметку».";
  if (!known) return;
  $("s-k").textContent = info.k;
  $("s-total").textContent = info.total;
  const left = info.total - info.k;
  $("s-left").textContent = left > 0
    ? `осталось ${left} ${plural(left, "петля", "петли", "петель")}`
    : "ряд закончен — нажмите Пробел";
  $("s-bar").style.width = (info.total ? (info.k / info.total) * 100 : 0) + "%";
}

$("chk-stitches").addEventListener("change", (e) => {
  viewer.setStitches(e.target.checked);
  updatePanel();
  if (e.target.checked) viewer.followStitch();
  $("stage").focus({ preventScroll: true });
});
$("btn-dir").addEventListener("click", () => { viewer.flipDirection(); updatePanel(); });
$("btn-st-back").addEventListener("click", () => viewer.stepStitch(-1));
$("btn-st-fwd").addEventListener("click", () => viewer.stepStitch(1));
$("btn-st-fwd10").addEventListener("click", () => viewer.stepStitch(10));

// --- statistics ------------------------------------------------------------------

const fmtNum = (n) => Math.round(n).toLocaleString("ru-RU");

function fmtDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 10) return `${Math.round(min / 60)} ч`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function fmtDay(ts, withWeekday = false) {
  return new Date(ts).toLocaleDateString("ru-RU", withWeekday
    ? { weekday: "short", day: "numeric", month: "long" }
    : { day: "numeric", month: "long" });
}

function rowsText(n) { return `${n} ${plural(n, "ряд", "ряда", "рядов")}`; }
function stitchesText(n) { return `${fmtNum(n)} ${plural(Math.round(n), "петля", "петли", "петель")}`; }

function updateStats() {
  const rows = viewer.allRows();
  const box = $("stats");
  box.hidden = rows.length === 0;
  if (!rows.length) return;
  const s = knitStats({ rows, done: viewer.doneSet, doneAt: viewer.doneAt, weightOf: (n) => viewer.weightOf(n) });
  const units = (n) => (s.weighted ? stitchesText(n) : rowsText(n));

  $("p-sts").hidden = !s.weighted;
  if (s.weighted) {
    const pct = s.totalUnits ? Math.round((s.doneUnits / s.totalUnits) * 100) : 0;
    $("p-sts").textContent = `по петлям — ${pct}% (${fmtNum(s.doneUnits)} из ${fmtNum(s.totalUnits)})`;
  }

  const lines = [];
  const add = (k, v, hint) => lines.push([k, v, hint]);
  if (s.stamped) {
    const t = s.today;
    add("Сегодня", t.rows ? `${rowsText(t.rows)} · ≈ ${fmtDuration(s.todayMs)}` : "пока ничего");
    add("За 7 дней", s.week.rows ? `${rowsText(s.week.rows)}${s.weighted ? ` · ${stitchesText(s.week.units)}` : ""}` : "—");
    if (s.msPerUnit) {
      if (s.weighted) {
        const perMin = 60000 / s.msPerUnit;
        const whole = perMin >= 10 || Number.isInteger(Math.round(perMin * 10) / 10);
        const num = whole ? fmtNum(perMin) : perMin.toFixed(1).replace(".", ",");
        // "6,4 петли" (fractions take the genitive singular), "12 петель".
        add("Скорость", `≈ ${num} ${whole ? plural(Math.round(perMin), "петля", "петли", "петель") : "петли"} в минуту`);
        const info = viewer.stitchInfo();
        const w = info ? viewer.weightOf(info.row) : null;
        if (w) {
          const leftInRow = info.span ? w - info.k : w;
          add(`Ряд ${info.row}`, `≈ ${fmtDuration(leftInRow * s.msPerUnit)}${info.k ? " до конца" : ""}`);
        }
      } else {
        add("Скорость", `≈ ${fmtDuration(s.msPerUnit)} на ряд`);
      }
      if (s.remaining > 0) add("Осталось", `≈ ${fmtDuration(s.remainingMs)} вязания`);
    }
    if (s.finish) add("Закончите", `≈ ${fmtDay(s.finish)}`, `Если вязать в том же темпе, что последние ${s.windowDays} ${plural(s.windowDays, "день", "дня", "дней")}`);
    else if (s.remaining > 0) add("Закончите", "прогноз появится после двух дней вязания");
  }
  const dl = $("stats-list");
  dl.replaceChildren();
  for (const [k, v, hint] of lines) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    if (hint) dd.title = hint;
    dl.append(dt, dd);
  }
  $("stats-empty").hidden = s.stamped > 0;

  // Rows per day, last 14 days.
  const days = $("stats-days");
  days.hidden = !s.stamped;
  if (!s.stamped) return;
  const max = Math.max(1, ...s.daily.map((d) => d.rows));
  const bars = $("stats-bars");
  bars.replaceChildren();
  s.daily.forEach((d, i) => {
    const b = document.createElement("div");
    b.className = "day" + (i === s.daily.length - 1 ? " today" : "");
    const tip = `${fmtDay(d.start, true)}: ${d.rows ? rowsText(d.rows) + (s.weighted ? `, ${stitchesText(d.units)}` : "") : "не вязали"}`;
    b.title = tip;
    b.setAttribute("aria-label", tip);
    const fill = document.createElement("span");
    fill.style.height = d.rows ? Math.max(6, (d.rows / max) * 100) + "%" : "0";
    b.append(fill);
    bars.append(b);
  });
  $("stats-max").textContent = `макс. ${rowsText(max)}`;
}

// --- magnifier -----------------------------------------------------------------

function updateLensControls() {
  $("chk-lens").checked = viewer.lens.on;
  $("lens-mag").hidden = !viewer.lens.on;
  for (const b of $("lens-mag").querySelectorAll("button")) {
    b.classList.toggle("on", Number(b.dataset.mag) === viewer.lens.mag);
    b.setAttribute("aria-pressed", String(Number(b.dataset.mag) === viewer.lens.mag));
  }
}
$("chk-lens").addEventListener("change", (e) => {
  viewer.lens.setOn(e.target.checked);
  updateLensControls();
  $("stage").focus({ preventScroll: true });
});
for (const b of $("lens-mag").querySelectorAll("button")) {
  b.addEventListener("click", () => { viewer.lens.setMag(Number(b.dataset.mag)); updateLensControls(); });
}
updateLensControls();

// --- full screen -----------------------------------------------------------------

const root = document.documentElement;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
const fsSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen);
let fsChangedAt = 0;

function toggleFullscreen() {
  if (fsElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  try {
    const r = (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
    if (r && r.catch) r.catch(() => toast("Браузер не разрешил полноэкранный режим"));
  } catch { toast("Браузер не разрешил полноэкранный режим"); }
}

function updateFsButton() {
  const on = !!fsElement();
  const b = $("btn-fs");
  b.title = on ? "Выйти из полноэкранного режима (F)" : "Во весь экран (F)";
  b.setAttribute("aria-label", on ? "Выйти из полноэкранного режима" : "Во весь экран");
  $("fs-enter").hidden = on;
  $("fs-exit").hidden = !on;
}
for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(ev, () => { fsChangedAt = performance.now(); updateFsButton(); });
}
$("btn-fs").hidden = !fsSupported;
$("btn-fs").addEventListener("click", toggleFullscreen);
updateFsButton();

let openToken = 0;
async function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)$/);
  const token = ++openToken;
  if (!m) {
    await flushSaves();
    if (calibrator.active) calibrator.cancel();
    viewer.close();
    viewer.project = null;
    $("viewer").hidden = true;
    await library.show();
    return;
  }
  const id = m[1];
  await flushSaves();
  const [project, files] = await Promise.all([db.getProject(id), db.getFiles(id)]);
  if (token !== openToken) return;
  if (!project || !files) { toast("Схема не найдена"); location.hash = ""; return; }
  library.hide();
  $("viewer").hidden = false;
  $("v-title").textContent = project.name;
  document.title = `${project.name} — Ряд за рядом`;
  project.openedAt = Date.now();
  scheduleSave(project);
  $("knit-panel").hidden = false;
  $("cal-panel").hidden = true;
  try {
    await viewer.open(project, files.pdf);
  } catch (e) {
    console.error(e);
    toast("Не получилось открыть PDF");
    location.hash = "";
    return;
  }
  if (token !== openToken) return;
  updatePanel();
  if (!calibrator.startPending()) {
    if (!project.view) viewer.centerRow(undefined, true, false);
  }
  $("stage").focus({ preventScroll: true });
}
addEventListener("hashchange", route);

// --- viewer controls -------------------------------------------------------------

const backToLibrary = () => {
  document.title = "Ряд за рядом";
  location.hash = "";
};
$("btn-back").addEventListener("click", backToLibrary);
$("btn-zoom-in").addEventListener("click", () => viewer.zoomStep(1));
$("btn-zoom-out").addEventListener("click", () => viewer.zoomStep(-1));
$("btn-fit").addEventListener("click", () => viewer.fit());
$("btn-prev-page").addEventListener("click", () => viewer.gotoPage(viewer.pageIndex - 1));
$("btn-next-page").addEventListener("click", () => viewer.gotoPage(viewer.pageIndex + 1));
$("btn-calibrate").addEventListener("click", () => calibrator.startCurrent());
$("btn-next").addEventListener("click", () => viewer.markNext());
$("btn-undo").addEventListener("click", () => viewer.undoLast());
$("btn-fill-gaps").addEventListener("click", () => viewer.fillGaps());
$("btn-goto").addEventListener("click", () => viewer.centerRow());
$("chk-dim").addEventListener("change", (e) => {
  viewer.setDim(e.target.checked);
  $("stage").focus({ preventScroll: true });
});
// Toolbar and panel buttons never keep keyboard focus, so Space always means
// "row done" and never re-presses the last clicked button.
for (const b of document.querySelectorAll("#viewer button")) {
  b.addEventListener("mousedown", (e) => e.preventDefault());
}

document.addEventListener("keydown", (e) => {
  if ($("dlg").open) return;
  if ($("viewer").hidden || !viewer.project) return;
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" && t.type !== "checkbox" || t.tagName === "TEXTAREA");
  if (e.code === "Escape") {
    if (typing) { t.blur(); return; }
    // Esc that leaves full screen should not also leave the chart.
    if (fsElement() || performance.now() - fsChangedAt < 600) return;
    if (calibrator.active) { if (calibrator.single) calibrator.cancel(); return; }
    backToLibrary();
    return;
  }
  if (typing) return;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.code === "KeyF" && fsSupported) { e.preventDefault(); toggleFullscreen(); return; }
    if (e.code === "KeyL") {
      e.preventDefault();
      viewer.lens.setOn(!viewer.lens.on);
      updateLensControls();
      return;
    }
  }
  if (viewer.handleKey(e)) {
    e.preventDefault();
    updatePanel();
  }
});
// Safari: stop the page itself from zooming on pinch.
document.addEventListener("gesturestart", (e) => e.preventDefault());

// --- drag and drop PDFs ---------------------------------------------------------

let dragDepth = 0;
addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  $("drop").hidden = false;
});
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  if (location.hash) { location.hash = ""; await new Promise((r) => setTimeout(r, 50)); }
  library.addFiles(files);
});

// --- start ------------------------------------------------------------------------

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW", e));
}
window.__knit = { viewer, library, calibrator, db, saveBackup }; // for debugging and tests
route();
