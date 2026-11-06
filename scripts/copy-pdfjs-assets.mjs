// Copies pdf.js runtime assets (CJK cmaps, standard fonts, wasm decoders, ICC profiles) into public/.
// quickjs-eval.* runs JavaScript embedded in PDFs, which Folio never does, so it stays out.
import { cpSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve, dirname, join } from "node:path";
import { createRequire } from 'node:module';

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

// The native signing modules are outside Vite's renderer license report.
const copied = new Set();
function signingLicenses(name, from = join(root, 'package.json')) {
  const require = createRequire(from);
  let manifest;
  try { manifest = require.resolve(`${name}/package.json`); }
  catch {
    let directory = dirname(require.resolve(name));
    while (!existsSync(join(directory, 'package.json')) || JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name !== name) {
      if (directory === dirname(directory)) throw new Error(`Could not locate notices for ${name}`);
      directory = dirname(directory);
    }
    manifest = join(directory, 'package.json');
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')), identity = `${pkg.name}@${pkg.version}`;
  if (copied.has(identity)) return;
  copied.add(identity);
  for (const file of readdirSync(dirname(manifest)).filter(f => /^(license|notice|copying)/i.test(f))) cpSync(join(dirname(manifest), file), join(dest, 'signing-licenses', identity.replaceAll('/', '_'), file));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) signingLicenses(dependency, manifest);
}
for (const name of ['@libpdf/core', 'pkijs', 'asn1js']) signingLicenses(name);
