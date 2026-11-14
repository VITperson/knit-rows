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
   moves on. A click on a row means "knitted up to here": that row and every
   row before it are marked; a click on the last marked row takes it back, a
   click on an earlier marked row goes back to it. `Shift`+click marks or
   unmarks that one row only. `⌘Z` / `Backspace` undoes. Rows left unmarked
   below the last knitted one are listed in the panel with a button to mark
   them. "Приглушить остальное" dims everything except the current row.
4. **Zoom and move** — pinch on the trackpad or the mouse wheel to zoom,
   drag or two-finger scroll to move, `+` / `−`, `0` for the whole page,
   `C` to jump to the current row. `F` (or the button at the top right) —
   full screen; while it is on, the screen does not dim or go to sleep
   (Screen Wake Lock, where the browser supports it). `P` (or the panel button next to it) hides the side panel;
   the progress and the "row done" button then sit in a small box over the
   chart. The choice is remembered in this browser.
5. **Stitches in a row** — "Считать петли в ряду" counts the stitches of the
   current row (the drawn cells of that row, so a shawl's first row has 5,
   not the width of the grid). Click a stitch — knitted up to it (click it
   again to take it back); `←` / `→` move the marker a stitch, with `Shift`
   ten. The row's direction comes from the side its number is printed on;
   the arrow button in the panel flips it for all odd or all even rows.
6. **Magnifier** — "Лупа" or `L`: a round lens under the pointer, ×2 / ×4 /
   ×8 of the current zoom.
7. **Statistics** — from the first row marked with this version on: rows
   today and this week, speed, time left in the current row and in the
   chart, and an estimated finish date. Speed and the forecast are in
   stitches when every row's stitches are known (a triangle's rows differ a
   lot), otherwise in rows. Pauses over 90 minutes count as breaks.

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
  marked on both. `doneAt` keeps when each row was marked (for statistics).
- Stitches (`js/rows.js`): a grid also has `cols` (from the stitch numbers,
  or square cells) and `start` (which side odd and even rows begin, from
  where the row numbers stand). `spans` — the first and last drawn cell of
  every row — are read from the rendered page and cached with the chart.
- Statistics are pure functions in `js/stats.js`.
- Compatibility: charts saved by an older version have none of these fields;
  they are added on opening and nothing existing is changed. The IndexedDB
  name and version stay the same.

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
