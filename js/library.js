// Library screen: the list of charts, adding PDFs, backups.
import * as db from "./db.js";
import { openPdf, detectPage, thumbnail } from "./render.js";
import { progressOf } from "./rows.js";
import { plural } from "./calibrate.js";

const $ = (id) => document.getElementById(id);
const MAX_DETECT_PAGES = 60;

export class Library {
  constructor(hooks) {
    this.hooks = hooks; // {open(id), toast(msg), ask(opts), busy(text|null)}
    this.urls = [];
    $("btn-add").addEventListener("click", () => $("file-pdf").click());
    $("empty").querySelector("[data-action=add]").addEventListener("click", () => $("file-pdf").click());
    $("btn-restore").addEventListener("click", () => $("file-backup").click());
    $("file-pdf").addEventListener("change", (e) => { this.addFiles([...e.target.files]); e.target.value = ""; });
    $("file-backup").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) this.restore(f); });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".card-menu, .card-menu-btn")) this.closeMenus();
    });
    $("persist-note").querySelector(".note-close").addEventListener("click", () => {
      $("persist-note").hidden = true;
      try { localStorage.setItem("knit-rows:persist-note", "hidden"); } catch {}
    });
  }

  async show() {
    $("library").hidden = false;
    await this.render();
    this.updatePersistNote();
  }

  hide() {
    $("library").hidden = true;
    this.closeMenus();
  }

  async render() {
    const projects = await db.listProjects();
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    const list = $("cards");
    list.replaceChildren();
    $("empty").hidden = projects.length > 0;
    for (const p of projects) list.append(await this.card(p));
  }

  async card(p) {
    const li = document.createElement("li");
    li.className = "card";
    const prog = progressOf(p.pages, p.done);
    const calibrated = (p.pages || []).some((x) => x && x.cal && !x.skip);
    const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;

    const open = document.createElement("button");
    open.className = "card-open";
    open.type = "button";
    open.title = "Открыть схему";
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const files = await db.getFiles(p.id);
    if (files && files.thumb) {
      const img = document.createElement("img");
      const url = URL.createObjectURL(files.thumb);
      this.urls.push(url);
      img.src = url;
      img.alt = "";
      thumb.append(img);
    }
    const body = document.createElement("div");
    body.className = "card-body";
    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = p.name;
    const meta = document.createElement("div");
    meta.className = "card-meta";
    if (!calibrated) meta.textContent = "Ряды ещё не размечены";
    else if (prog.total && prog.done === prog.total) {
      meta.innerHTML = '<span class="badge">Готово</span> ';
      meta.append(`${prog.total} ${plural(prog.total, "ряд", "ряда", "рядов")}`);
    } else meta.textContent = `${prog.done} из ${prog.total} ${plural(prog.total, "ряда", "рядов", "рядов")} · ${pct}%`;
    const when = document.createElement("div");
    when.className = "card-meta";
    when.textContent = "Открыта " + ago(p.openedAt || p.createdAt);
    const bar = document.createElement("div");
    bar.className = "progress";
    bar.innerHTML = `<div class="progress-fill" style="width:${pct}%"></div>`;
    body.append(name, meta, when, bar);
    open.append(thumb, body);
    open.addEventListener("click", () => this.hooks.open(p.id));

    const menuBtn = document.createElement("button");
    menuBtn.className = "btn icon card-menu-btn";
    menuBtn.type = "button";
    menuBtn.title = "Действия со схемой";
    menuBtn.setAttribute("aria-label", "Действия со схемой");
    menuBtn.textContent = "⋯";
    menuBtn.style.fontSize = "22px";
    const menu = document.createElement("div");
    menu.className = "card-menu";
    menu.hidden = true;
    const item = (label, fn, cls) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener("click", () => { this.closeMenus(); fn(); });
      menu.append(b);
    };
    item("Открыть", () => this.hooks.open(p.id));
    item("Переименовать", () => this.rename(p));
    item("Сохранить копию в файл", () => this.backup(p));
    item("Удалить", () => this.remove(p), "danger");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = !menu.hidden;
      this.closeMenus();
      menu.hidden = wasOpen;
    });
    li.append(open, menuBtn, menu);
    return li;
  }

  closeMenus() {
    for (const m of document.querySelectorAll(".card-menu")) m.hidden = true;
  }

  async addFiles(files) {
    const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    if (!pdfs.length) { this.hooks.toast("Нужен файл PDF"); return; }
    let lastId = null;
    for (const f of pdfs) {
      try {
        this.hooks.busy(`Читаю «${f.name}»…`);
        lastId = await this.addPdf(f);
      } catch (e) {
        console.error(e);
        this.hooks.toast(`Не получилось открыть «${f.name}»: похоже, это не PDF или файл повреждён`);
      } finally {
        this.hooks.busy(null);
      }
    }
    requestPersist();
    if (lastId && pdfs.length === 1) this.hooks.open(lastId);
    else await this.render();
  }

  async addPdf(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await openPdf(data);
    try {
      const n = pdf.doc.numPages;
      const pages = [];
      for (let i = 0; i < n; i++) {
        let cal = null;
        if (i < MAX_DETECT_PAGES) {
          this.hooks.busy(n > 1 ? `Ищу ряды: страница ${i + 1} из ${n}…` : "Ищу ряды на схеме…");
          try { cal = await detectPage(await pdf.doc.getPage(i + 1)); } catch (e) { console.warn(e); }
        }
        pages.push({ cal, skip: false, confirmed: false });
      }
      this.hooks.busy("Делаю миниатюру…");
      const thumb = await thumbnail(await pdf.doc.getPage(1));
      const now = Date.now();
      const project = {
        id: crypto.randomUUID(),
        name: file.name.replace(/\.pdf$/i, "").replace(/[._]+$/, "").trim() || "Схема",
        fileName: file.name,
        createdAt: now,
        updatedAt: now,
        openedAt: now,
        pageCount: n,
        pages,
        done: [],
        dim: false,
        view: null,
      };
      await db.putProjectWithFiles(project, { pdf: new Blob([file], { type: "application/pdf" }), thumb });
      return project.id;
    } finally {
      pdf.destroy();
    }
  }

  async rename(p) {
    const name = await this.hooks.ask({ title: "Название схемы", input: p.name, okText: "Сохранить" });
    if (name == null) return;
    const fresh = await db.getProject(p.id);
    fresh.name = name.trim() || fresh.name;
    await db.putProject(fresh);
    await this.render();
  }

  async remove(p) {
    const ok = await this.hooks.ask({
      title: `Удалить «${p.name}»?`,
      text: "Схема и все отметки будут удалены из этого браузера. Если есть сохранённая копия, её можно будет восстановить.",
      okText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    await db.deleteProject(p.id);
    this.hooks.toast("Схема удалена");
    await this.render();
  }

  async backup(p) {
    await saveBackup(p.id, p.name);
    this.hooks.toast("Копия сохранена в «Загрузки»");
  }

  async restore(file) {
    try {
      this.hooks.busy("Восстанавливаю копию…");
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error("Это не файл копии"); }
      const exists = data && data.project && (await db.projectExists(data.project.id));
      let replace = false;
      if (exists) {
        this.hooks.busy(null);
        replace = await this.hooks.ask({
          title: "Эта схема уже есть",
          text: `Заменить отметки схемы «${data.project.name}» теми, что в копии? Иначе копия добавится отдельной схемой.`,
          okText: "Заменить",
          cancelText: "Добавить отдельно",
        });
        this.hooks.busy("Восстанавливаю копию…");
      }
      const p = await db.importBackup(new Blob([JSON.stringify(data)]), { replace: !!replace });
      this.hooks.toast(`Восстановлено: «${p.name}»`);
      await this.render();
    } catch (e) {
      this.hooks.toast(e.message || "Не получилось восстановить копию");
    } finally {
      this.hooks.busy(null);
    }
  }

  async updatePersistNote() {
    const note = $("persist-note");
    let hidden = false;
    try { hidden = localStorage.getItem("knit-rows:persist-note") === "hidden"; } catch {}
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const any = (await db.listProjects()).length > 0;
    note.hidden = hidden || persisted || !any;
    const ua = navigator.userAgent;
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    $("persist-hint").textContent = standalone
      ? ""
      : safari
        ? "Добавьте приложение в Dock (Safari → меню «Файл» → «Добавить в Dock»): так Safari не удалит его данные, даже если вы долго его не открывали."
        : "Установите его как приложение (значок установки справа в адресной строке) — так браузер не удалит данные.";
  }
}

export async function saveBackup(id, name) {
  const blob = await db.exportBackup(id);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name} — копия ${date}.knitrows.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
}

function ago(ts) {
  if (!ts) return "давно";
  const d = new Date(ts);
  const now = new Date();
  const day = 864e5;
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / day);
  if (diff <= 0) return "сегодня";
  if (diff === 1) return "вчера";
  if (diff < 7) return `${diff} ${plural(diff, "день", "дня", "дней")} назад`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
