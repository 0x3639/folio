import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { PDFDocument, PDFName, PDFDict, degrees } from 'pdf-lib';
import { init } from '@embedpdf/pdfium';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
const engine = await init({ wasmBinary: readFileSync(new URL('../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)) });
engine.PDFiumExt_Init();
function render(bytes, pageIndex, printing = false) {
  const ptr = engine.pdfium.wasmExports.malloc(bytes.length);
  engine.pdfium.HEAPU8.set(bytes, ptr);
  let doc, page, bitmap;
  try {
    doc = engine.FPDF_LoadMemDocument(ptr, bytes.length, ''); assert.ok(doc, 'PDFium opens the exported PDF');
    page = engine.FPDF_LoadPage(doc, pageIndex); assert.ok(page);
    const width = 600, height = 600;
    bitmap = engine.FPDFBitmap_Create(width, height, 1);
    engine.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    // FPDF_ANNOT and optionally FPDF_PRINTING exercise the normal annotation/print paths.
    engine.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 1 | (printing ? 0x800 : 0));
    const start = engine.FPDFBitmap_GetBuffer(bitmap), length = engine.FPDFBitmap_GetStride(bitmap) * height;
    return engine.pdfium.HEAPU8.slice(start, start + length);
  } finally {
    if (bitmap) engine.FPDFBitmap_Destroy(bitmap);
    if (page) engine.FPDF_ClosePage(page);
    if (doc) engine.FPDF_CloseDocument(doc);
    engine.pdfium.wasmExports.free(ptr);
  }
}
const ink = pixels => { let count = 0; for (let i = 0; i < pixels.length; i += 4) if (Math.min(...pixels.subarray(i, i + 3)) < 230) count++; return count; };
const difference = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if ([0, 1, 2].some(c => Math.abs(a[i + c] - b[i + c]) > 12)) count++; return count; };
try {
  const { defaultStyle, reviewKinds } = await server.ssrLoadModule('/src/reviewModel.ts');
  const { carryReview } = await server.ssrLoadModule('/src/carryReview.ts');
  const { exportDrawingPdf } = await server.ssrLoadModule('/src/drawingPdf.ts');
  const source = await PDFDocument.create();
  const review = reviewKinds.map((kind, page) => {
    const p = source.addPage([400, 400]);
    if (kind === 'Oval') p.setRotation(degrees(90));
    if (kind === 'Rectangle') p.setCropBox(10, 10, 380, 380);
    const points = kind === 'Callout' ? [[50, 70], [120, 230], [150, 250]] : kind === 'Cloud callout' ? [[40, 80], [130, 160], [170, 250]] : kind === 'Polygon' ? [[50, 70], [220, 110], [150, 220]] : [[50, 70], [220, 220]];
    return { id: kind, page, kind, points, text: 'Review dimension', style: { ...defaultStyle, fontSize: 16, opacity: .65, dash: 'dashed' }, createdAt: 1 };
  });
  const measurements = ['Length', 'Area', 'Perimeter', 'Count'].map((kind, i) => {
    source.addPage([400, 400]);
    return { id: kind, kind, page: review.length + i, points: kind === 'Length' ? [[50, 100], [250, 100]] : [[50, 100], [250, 100], [200, 230]], scale: { unit: 'ft', unitsPerPoint: .1 } };
  });
  const bytes = await source.save(), data = { scales: {}, measurements, review };
  const editable = await exportDrawingPdf(bytes, data), flattened = await exportDrawingPdf(bytes, data, null, true);
  const standardOnly = await PDFDocument.load(editable);
  for (const page of standardOnly.getPages()) {
    const list = page.node.Annots();
    for (let i = 0; list && i < list.size(); i++) {
      const dict = list.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const appearance = dict.lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
      const fonts = appearance.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'));
      if (fonts instanceof PDFDict) for (const [, ref] of fonts.entries()) assert.ok(standardOnly.context.lookup(ref) instanceof PDFDict, 'appearance font references point to actual font objects, without reader fallback');
      for (const key of dict.keys()) if (key.decodeText().startsWith('Folio')) dict.delete(key);
      if (dict.get(PDFName.of('Subtype')).toString() === '/FreeText') {
        const da = dict.lookup(PDFName.of('DA')).decodeText(), font = /^\/(\S+)/.exec(da)[1];
        assert.ok(standardOnly.catalog.getOrCreateAcroForm().dict.lookup(PDFName.of('DR')).lookup(PDFName.of('Font')).has(PDFName.of(font)), 'default text fonts resolve through standard PDF resources');
      }
    }
  }
  const stripped = await standardOnly.save();
  mkdirSync('release/smoke', { recursive: true });
  writeFileSync('release/smoke/standard-viewer-editable.pdf', editable);
  writeFileSync('release/smoke/standard-viewer-flattened.pdf', flattened);
  for (let i = 0; i < source.getPageCount(); i++) {
    const a = render(editable, i), b = render(flattened, i), c = render(stripped, i), print = render(editable, i, true);
    const label = [...reviewKinds, ...measurements.map(m => m.kind)][i];
    assert.ok(ink(a) > 40, `${label} renders visible marks in PDFium`);
    assert.ok(difference(a, b) < 600, `${label}: editable and flattened appearances agree`);
    assert.equal(difference(a, c), 0, `${label} needs no Folio metadata to render`);
    assert.ok(difference(a, print) < 600, `${label} prints consistently`);
  }
  const hidden = await exportDrawingPdf(bytes, { ...data, layers: [{ id: 'hidden', name: 'Hidden review', visible: false }], reviewMeta: Object.fromEntries([...review, ...measurements].map(m => [m.id, { layer: 'hidden' }])) });
  writeFileSync('release/smoke/standard-viewer-hidden.pdf', hidden);
  assert.equal(ink(render(hidden, 0)), 0, 'standard PDF layer defaults hide annotations in PDFium');
  assert.equal(ink(render(hidden, 0, true)), 0, 'hidden review layers do not print');
  const unicodeData = { scales: {}, measurements: [], review: [{ ...review[0], text: 'Διάσταση — размер' }] };
  const unicodeFont = new Uint8Array(readFileSync('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
  const unicodePdf = await exportDrawingPdf(bytes, unicodeData, null, false, unicodeFont);
  const unicodeFinal = await exportDrawingPdf(bytes, unicodeData, null, true, unicodeFont);
  assert.ok(ink(render(unicodePdf, 0)) > 40);
  assert.ok(difference(render(unicodePdf, 0), render(unicodeFinal, 0)) < 600, 'embedded Unicode fonts render consistently');
  writeFileSync('release/smoke/standard-viewer-unicode.pdf', unicodePdf);
  writeFileSync('release/smoke/standard-viewer-unicode-final.pdf', unicodeFinal);
  const carried = await carryReview(editable, bytes, [{ from: 0, to: 1 }], 'old.pdf');
  assert.ok(difference(render(editable, 0), render(carried.bytes, 1)) < 600, 'transferred appearances render correctly in a standard viewer');
  const hiddenCarry = await carryReview(hidden, bytes, [{ from: 0, to: 1 }], 'old.pdf');
  assert.equal(ink(render(hiddenCarry.bytes, 1)), 0, 'transferred layer appearances use the new document layer configuration');
  const carriedPdf = await PDFDocument.load(carried.bytes), carriedAnnot = carriedPdf.getPage(1).node.Annots().lookup(0);
  const carriedFont = /^\/(\S+)/.exec(carriedAnnot.lookup(PDFName.of('DA')).decodeText())[1];
  assert.ok(carriedPdf.catalog.getOrCreateAcroForm().dict.lookup(PDFName.of('DR')).lookup(PDFName.of('Font')).has(PDFName.of(carriedFont)), 'transferred default text fonts remain editable in standard viewers');
  console.log(`PASS PDFium renders and prints ${source.getPageCount()} markup/measurement types, rotated/cropped pages, flattened copies, standard font references and layer visibility without Folio metadata`);
} finally { await server.close(); }
