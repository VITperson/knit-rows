# Ряд за рядом — knitting row tracker

A small web app for following a knitting chart from a PDF: open the chart,
mark each row as knitted, always see where you stopped.

**Open:** https://vitperson.github.io/knit-rows/

Nothing to install, no account. Charts and marks are stored only in the
browser on this computer (IndexedDB) and never leave it; the app also works
offline.

## Using it

1. **Add a chart** — "Добавить схему", or drop a PDF onto the window.
2. **Rows** — the app looks for the row numbers printed beside the grid
   (Stitch Fiddle and most chart editors print them) and frames the grid.
   Zoom into the top and bottom of the chart and check that the green lines
   sit on the grid lines, then press "Всё верно". If nothing is found (a scan,
   for example), drag a frame around the grid and type the number of rows.
   The frame edges can be dragged. A page without rows (a legend) can be
   skipped. Multi-page charts are set up page by page.
3. **Knitting** — `Space` / `Enter` marks the current row as knitted and
   moves on; click a row to mark or unmark it; `Shift`+click marks every row
   up to that one; `⌘Z` / `Backspace` undoes. "Приглушить остальное" dims
   everything except the current row.
4. **Zoom and move** — pinch on the trackpad or the mouse wheel to zoom,
   drag or two-finger scroll to move, `+` / `−`, `0` for the whole page,
   `C` to jump to the current row.

### Keep the data safe

Browsers may clear site data. Install the app (Safari: File → Add to Dock;
Chrome: the install icon in the address bar) and now and then save a copy:
card menu "⋯" → "Сохранить копию в файл". A copy is one `.knitrows.json`
file with the PDF and the marks; "Восстановить из копии" brings it back.

## How it works

- Plain HTML + ES modules, no build step. PDF rendering by
  [pdf.js](https://mozilla.github.io/pdf.js/) (vendored in `vendor/pdfjs`).
- The page is rendered once into a bitmap that moves with CSS transforms;
  when zoomed in further, the visible part is re-rendered at screen
  resolution after the view settles.
- Row detection (`js/rows.js`): numeric labels from the PDF text layer are
  fitted to a line `position = c + pitch × number` (outliers dropped); the
  stitch numbers along the top/bottom give the grid width. A grid is stored
  per page as `{rect, rows, firstRow, bottomUp}` in page units.
- Marks are stored by row number per chart, so a row repeated on two pages is
  marked on both.

## Development

```sh
npm install          # pdfjs-dist for tests and vendoring
npm run vendor       # copy pdf.js into vendor/ (after changing its version)
npm test             # unit tests (row geometry and detection)
npm run serve        # http://localhost:8765
```

`samples/` (git-ignored) may hold real charts for the detection test.
When changing app files, bump `CACHE` in `sw.js` so installed copies refresh
their offline cache.
