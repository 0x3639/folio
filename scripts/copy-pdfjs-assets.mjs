// Copies pdf.js runtime assets (CJK cmaps, standard fonts, wasm decoders, ICC profiles) into public/.
// quickjs-eval.* runs JavaScript embedded in PDFs, which Folio never does, so it stays out.
import { cpSync, existsSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "node_modules/pdfjs-dist");
const dest = resolve(root, "public/pdfjs");

// Start clean, so files dropped from this list don't linger from earlier builds.
rmSync(dest, { recursive: true, force: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  const from = resolve(src, dir);
  if (existsSync(from)) cpSync(from, resolve(dest, dir), { recursive: true, filter: (file) => !basename(file).startsWith("quickjs-eval") });
}
// Worker-only packages aren't included in Vite's renderer license report.
for (const [pkg, license] of [
  ["@embedpdf/pdfium", "LICENSE"], ["@embedpdf/pdfium", "LICENSE.pdfium"], ["pdf-lib", "LICENSE.md"],
  ["@pdf-lib/standard-fonts", "LICENSE.md"], ["@pdf-lib/upng", "LICENSE"], ["pako", "LICENSE"], ["tslib", "LICENSE.txt"],
]) cpSync(resolve(root, "node_modules", pkg, license), resolve(dest, "editor-licenses", pkg, license));
