#!/bin/sh
# Copy the pdf.js build from node_modules into vendor/ (the app ships without a CDN).
set -e
cd "$(dirname "$0")/.."
SRC=node_modules/pdfjs-dist
DST=vendor/pdfjs
rm -rf "$DST"
mkdir -p "$DST"
cp "$SRC/build/pdf.min.mjs" "$SRC/build/pdf.worker.min.mjs" "$SRC/LICENSE" "$DST/"
cp -R "$SRC/standard_fonts" "$SRC/cmaps" "$SRC/wasm" "$SRC/iccs" "$DST/"
node -e "console.log('pdfjs-dist', require('./$SRC/package.json').version)" > "$DST/VERSION"
cat "$DST/VERSION"
