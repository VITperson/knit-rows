// IndexedDB storage: everything stays in this browser.
//   projects: { id, name, fileName, createdAt, updatedAt, openedAt, pageCount,
//               pages: [{cal, skip}], done: [rowNumbers], view, dim }
//   files:    { id, pdf: Blob, thumb: Blob }

const DB_NAME = "knit-rows";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
  });
}

const req2p = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function listProjects() {
  const all = await tx(["projects"], "readonly", (t) => req2p(t.objectStore("projects").getAll()));
  return all.sort((a, b) => (b.openedAt || b.createdAt) - (a.openedAt || a.createdAt));
}

export function getProject(id) {
  return tx(["projects"], "readonly", (t) => req2p(t.objectStore("projects").get(id)));
}

export function putProject(p) {
  return tx(["projects"], "readwrite", (t) => { t.objectStore("projects").put(p); });
}

export function getFiles(id) {
  return tx(["files"], "readonly", (t) => req2p(t.objectStore("files").get(id)));
}

export function putProjectWithFiles(p, files) {
  return tx(["projects", "files"], "readwrite", (t) => {
    t.objectStore("projects").put(p);
    t.objectStore("files").put({ id: p.id, ...files });
  });
}

export function deleteProject(id) {
  return tx(["projects", "files"], "readwrite", (t) => {
    t.objectStore("projects").delete(id);
    t.objectStore("files").delete(id);
  });
}

// --- backup file --------------------------------------------------------------

const FORMAT = "knit-rows-backup";

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type });
}

export async function exportBackup(id) {
  const [p, f] = await Promise.all([getProject(id), getFiles(id)]);
  if (!p || !f) throw new Error("Схема не найдена");
  const data = {
    format: FORMAT,
    version: 1,
    savedAt: new Date().toISOString(),
    project: p,
    pdf: await blobToBase64(f.pdf),
    thumb: f.thumb ? await blobToBase64(f.thumb) : null,
  };
  return new Blob([JSON.stringify(data)], { type: "application/json" });
}

// Restores a backup. If a scheme with the same id exists, the backup replaces
// it only when `replace` is true; otherwise it is added as a copy.
export async function importBackup(file, { replace = false } = {}) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("Это не файл копии"); }
  if (!data || data.format !== FORMAT || !data.project || !data.pdf) throw new Error("Это не файл копии «Ряд за рядом»");
  const p = data.project;
  const existing = await getProject(p.id);
  if (existing && !replace) {
    p.id = crypto.randomUUID();
    p.name = `${p.name} (копия)`;
  }
  p.openedAt = Date.now();
  await putProjectWithFiles(p, {
    pdf: base64ToBlob(data.pdf, "application/pdf"),
    thumb: data.thumb ? base64ToBlob(data.thumb, "image/png") : null,
  });
  return p;
}

export async function projectExists(id) {
  return !!(await getProject(id));
}
