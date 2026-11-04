import { PDFDocument, PDFDict, PDFName, PDFHexString, PDFString, PDFNumber, PDFRef, PDFObjectCopier, type PDFPage } from 'pdf-lib';
import { readReviewLayers, writeReviewLayers, layerAppearance, setLayerVisibility } from './reviewLayersPdf';
import { checkPageCount, checkPdfSize } from './pdfInput';
const n = PDFName.of;
const text = (dict: PDFDict, key: string) => {
  const value = dict.lookup(n(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
};
const reviewTypes = new Set(['/Text', '/FreeText', '/Line', '/Square', '/Circle', '/Polygon', '/PolyLine', '/Highlight', '/Underline', '/Squiggly', '/StrikeOut', '/Stamp', '/Caret', '/Ink', '/FileAttachment']);
const isMark = (dict: PDFDict) => reviewTypes.has(dict.get(n('Subtype'))?.toString() ?? '') && !dict.has(n('IRT'));
function annotations(page: PDFPage) {
  const list = page.node.Annots();
  return list ? list.asArray().map((ref, i) => ({ ref, dict: list.lookup(i) })).filter((a): a is { ref: typeof a.ref; dict: PDFDict } => a.dict instanceof PDFDict) : [];
}
function geometry(page: PDFPage) {
  const unit = page.node.lookup(n('UserUnit'));
  return [...Object.values(page.getMediaBox()), ...Object.values(page.getCropBox()), page.getRotation().angle, unit instanceof PDFNumber ? unit.asNumber() : 1];
}
export interface CarrySheet { page: number; count: number; geometry: number[] }
export interface SheetMapping { from: number; to: number }
export const matchingGeometry = (a: CarrySheet, b: CarrySheet) => a.geometry.length === b.geometry.length && a.geometry.every((value, i) => Math.abs(value - b.geometry[i]) < .001);
async function load(bytes: Uint8Array) {
  checkPdfSize(bytes.length);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  checkPageCount(pdf.getPageCount());
  if (pdf.isEncrypted || pdf.catalog.has(n('Perms')) || pdf.getForm().getFields().some(f => f.acroField.getInheritableAttribute(n('FT'))?.toString() === '/Sig')) throw new Error('Use an unsigned, unencrypted PDF for carrying review comments.');
  return pdf;
}
const sheets = (pdf: PDFDocument): CarrySheet[] => pdf.getPages().map((page, index) => ({ page: index, count: annotations(page).filter(a => isMark(a.dict)).length, geometry: geometry(page) }));
export async function inspectCarryPdf(bytes: Uint8Array) { return sheets(await load(bytes)); }

/** Copy annotations onto explicitly matched sheets, leaving both input documents untouched. */
export async function carryReview(sourceBytes: Uint8Array, revisedBytes: Uint8Array, mappings: SheetMapping[], sourceName: string) {
  const source = await load(sourceBytes), target = await load(revisedBytes);
  const oldSheets = sheets(source), newSheets = sheets(target);
  if (!mappings.length) throw new Error('Choose at least one sheet to carry forward.');
  if (new Set(mappings.map(m => m.from)).size !== mappings.length || new Set(mappings.map(m => m.to)).size !== mappings.length) throw new Error('Match each original and revised sheet only once.');
  for (const { from, to } of mappings) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || !oldSheets[from] || !newSheets[to]) throw new Error('A selected sheet no longer exists.');
    if (!matchingGeometry(oldSheets[from], newSheets[to])) throw new Error(`Sheet ${from + 1} and revised sheet ${to + 1} have different size, crop, rotation, or units. Align them before carrying comments.`);
    for (const { dict } of annotations(source.getPage(from))) {
      if (!isMark(dict)) continue;
      const oc = dict.lookup(n('OC'));
      if (oc && (!(oc instanceof PDFDict) || !text(oc, 'FolioLayerId'))) throw new Error(`Sheet ${from + 1} contains a markup on an external PDF layer. Its layer rules cannot yet be carried safely.`);
    }
  }
  const targetLayers = readReviewLayers(target).layers ?? [], sourceLayers = readReviewLayers(source).layers ?? [];
  const layers = [...targetLayers, ...sourceLayers.filter(l => !targetLayers.some(t => t.id === l.id))];
  const layerRefs = writeReviewLayers(target, layers);
  let carried = 0, duplicates = 0;
  const at = Date.now();
  const sourceForm = source.catalog.lookup(n('AcroForm'));
  const sourceDr = sourceForm instanceof PDFDict ? sourceForm.lookup(n('DR')) : undefined;
  const copier = PDFObjectCopier.for(source.context, target.context);
  const copiedDr = sourceDr instanceof PDFDict ? copier.copy(sourceDr) : undefined;
  // Page back-references would otherwise pull the old drawing content into the new file.
  // These are private, freshly loaded objects; the input bytes remain unchanged.
  for (const page of source.getPages()) for (const { dict } of annotations(page)) dict.delete(n('P'));
  for (const { from, to } of mappings) {
    const destination = target.getPage(to);
    const existing = new Set(annotations(destination).map(a => text(a.dict, 'NM')).filter(Boolean));
    // A shared copier retains appearance resources and discussion reference graphs without old pages.
    const copied = annotations(source.getPage(from)).filter(({ dict }) => reviewTypes.has(dict.get(n('Subtype'))?.toString() ?? '') || dict.get(n('Subtype'))?.toString() === '/Popup').map(({ ref }) => {
      const copiedRef = copier.copy(ref);
      return { ref: copiedRef, dict: target.context.lookup(copiedRef) as PDFDict, sourceRef: ref };
    });
    const selected = new Set<string>();
    for (const { ref, dict } of copied) {
      if (!isMark(dict)) continue;
      const id = text(dict, 'NM');
      if (id && existing.has(id)) { duplicates++; continue; }
      if (id) existing.add(id);
      selected.add(ref.toString()); carried++;
      const carriedFrom = { document: sourceName.slice(0, 500), page: from, at };
      const encoded = text(dict, 'FolioReview');
      if (encoded && encoded.length < 1000000) {
        try {
          const record = JSON.parse(encoded);
          if (record.version === 1 && record.mark) { record.mark.page = to; record.meta = { ...record.meta, carriedFrom }; dict.set(n('FolioReview'), PDFHexString.fromText(JSON.stringify(record))); }
        } catch { /* Keep an unrecognized annotation and its appearance intact. */ }
      }
      let metadata = { author: text(dict, 'T'), subject: text(dict, 'Subj'), status: text(dict, 'State') === 'Completed' ? 'Resolved' : text(dict, 'State') === 'Accepted' ? 'Answered' : 'Open' };
      try { metadata = { ...metadata, ...JSON.parse(text(dict, 'FolioReviewMeta') || '{}') }; } catch { /* Native annotations need no Folio metadata. */ }
      dict.set(n('FolioReviewMeta'), PDFHexString.fromText(JSON.stringify({ ...metadata, carriedFrom })));
      // Identical source annotations without a PDF name also need a stable duplicate key.
      if (!id) {
        const sourceRef = copied.find(a => a.ref === ref)!.sourceRef.toString();
        const identity = JSON.stringify([sourceName, from, sourceRef, text(dict, 'Contents'), dict.get(n('Rect'))?.toString(), dict.get(n('Subtype'))?.toString()]);
        const fingerprint = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
        const key = 'folio-carried:' + Array.from(new Uint8Array(fingerprint), b => b.toString(16).padStart(2, '0')).join('');
        if (existing.has(key)) { selected.delete(ref.toString()); carried--; duplicates++; continue; }
        dict.set(n('NM'), PDFHexString.fromText(key)); existing.add(key);
      }
    }
    // Replies may themselves have replies. Include the complete selected discussion.
    let changed = true;
    while (changed) {
      changed = false;
      for (const { ref, dict } of copied) if (!selected.has(ref.toString()) && (selected.has(dict.get(n('IRT'))?.toString() ?? '') || dict.get(n('Subtype'))?.toString() === '/Popup' && selected.has(dict.get(n('Parent'))?.toString() ?? ''))) {
        selected.add(ref.toString()); changed = true;
      }
    }
    for (const { ref, dict } of copied) {
      if (!selected.has(ref.toString())) continue;
      dict.set(n('P'), destination.ref);
      const oc = dict.lookup(n('OC'));
      if (dict.get(n('Subtype'))?.toString() === '/FreeText') {
        const localDr = dict.lookup(n('DR'));
        const resources = localDr instanceof PDFDict ? localDr : copiedDr;
        const fonts = resources instanceof PDFDict ? resources.lookup(n('Font')) : undefined;
        if (fonts instanceof PDFDict) {
          const form = target.catalog.getOrCreateAcroForm().dict;
          let dr = form.lookup(n('DR')); if (!(dr instanceof PDFDict)) { dr = target.context.obj({}); form.set(n('DR'), dr); }
          let targetFonts = (dr as PDFDict).lookup(n('Font')); if (!(targetFonts instanceof PDFDict)) { targetFonts = target.context.obj({}); (dr as PDFDict).set(n('Font'), targetFonts); }
          let da = text(dict, 'DA');
          const fontMap = target.context.obj({});
          for (const [key, value] of fonts.entries()) {
            const next = (targetFonts as PDFDict).has(key) ? n(target.context.addRandomSuffix('CarriedReviewFont', 10)) : key;
            (targetFonts as PDFDict).set(next, value); fontMap.set(next, value);
            da = da.replace(`${key.toString()} `, `${next.toString()} `);
          }
          dict.set(n('DA'), PDFString.of(da)); dict.set(n('DR'), target.context.obj({ Font: fontMap }));
        }
      }
      if (oc instanceof PDFDict) { const layer = layerRefs.get(text(oc, 'FolioLayerId')); if (layer) { dict.set(n('OC'), layer); layerAppearance(target, dict, layer); setLayerVisibility(dict, layers.find(l => l.id === text(oc, 'FolioLayerId'))?.visible !== false); } }
      destination.node.addAnnot(ref instanceof PDFRef ? ref : target.context.register(dict));
    }
  }
  return { bytes: await target.save(), carried, duplicates };
}
