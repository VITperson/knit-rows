// App shell: routing between the library and a chart, panels, keys, saving.
import * as db from "./db.js";
import { Library, saveBackup } from "./library.js";
import { Viewer } from "./viewer.js";
import { Calibrator, plural } from "./calibrate.js";

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
}

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
    if (calibrator.active) { if (calibrator.single) calibrator.cancel(); return; }
    backToLibrary();
    return;
  }
  if (typing) return;
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
