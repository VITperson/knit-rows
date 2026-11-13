// PDF loading and rendering through pdf.js.
import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";
import { labelPoints, detectCalibration } from "./rows.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.mjs";

// Canvas limits: Safari refuses canvases above 16.7M pixels.
const MAX_BASE_PIXELS = 14_000_000;
const MAX_BASE_SIDE = 8192;

export async function openPdf(data) {
  const task = pdfjs.getDocument({
    data,
    standardFontDataUrl: VENDOR + "standard_fonts/",
    cMapUrl: VENDOR + "cmaps/",
    cMapPacked: true,
    wasmUrl: VENDOR + "wasm/",
    iccUrl: VENDOR + "iccs/",
    verbosity: 0,
  });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

// Page size in page units (viewport at scale 1, rotation applied).
export function pageSize(page) {
  const vp = page.getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

export async function detectPage(page) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return detectCalibration(labelPoints(tc.items, vp.transform), vp.width, vp.height);
}

export function baseScaleFor(size) {
  const byArea = Math.sqrt(MAX_BASE_PIXELS / (size.width * size.height));
  const bySide = MAX_BASE_SIDE / Math.max(size.width, size.height);
  return Math.max(0.5, Math.min(byArea, bySide, 8));
}

// Renders a whole page into a new canvas at `scale` canvas pixels per page unit.
export function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const task = page.render({ canvas, viewport, background: "#ffffff" });
  return { canvas, task, promise: task.promise.then(() => canvas) };
}

// Renders the part of a page that is visible on screen.
// scale: canvas pixels per page unit; (dx, dy): canvas pixel position of the
// page origin; width/height: canvas size.
export function renderRegion(page, scale, dx, dy, width, height) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const task = page.render({
    canvas,
    viewport,
    transform: [1, 0, 0, 1, dx, dy],
    background: "#ffffff",
  });
  return { canvas, task, promise: task.promise.then(() => canvas) };
}

export async function thumbnail(page, width = 480) {
  const size = pageSize(page);
  const scale = width / size.width;
  const { promise } = renderPage(page, scale);
  const canvas = await promise;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function isCancel(err) {
  return err && (err.name === "RenderingCancelledException" || /cancel/i.test(err.message || ""));
}
