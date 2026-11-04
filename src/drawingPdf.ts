import { PDFDocument, PDFName, PDFHexString, PDFString, PDFDict, PDFArray, PDFStream, PDFNumber, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import type { PDFPage, PDFFont } from 'pdf-lib';
import type { StoredMark } from './recent';
import { emptyDrawing, measurementLabel, type DrawingData, type Measurement, type Point } from './measurements';
import { defaultStyle, metaFor, reviewGeometry, wrapReviewText, validateReviewMark, type ReviewMark, type ReviewMeta, type ReviewRow } from './reviewModel';
const name = PDFName.of;
const text = (value: string) => PDFHexString.fromText(value);
const rgbValues = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const color = (hex: string) => rgb(...rgbValues(hex));
const readText = (dict: PDFDict, key: string) => {
  const value = dict.lookup(name(key));
  return value instanceof PDFHexString || value instanceof PDFString ? value.decodeText() : '';
};
const arrayNumbers = (dict: PDFDict, key: string) => {
  const a = dict.lookup(name(key));
  if (!(a instanceof PDFArray)) return [];
  return a.asArray().map(n => n instanceof PDFNumber ? n.asNumber() : NaN);
};
function validMeta(value: unknown): ReviewMeta {
  const v = value as ReviewMeta;
  return { author: typeof v?.author === 'string' ? v.author.slice(0, 200) : '', discipline: typeof v?.discipline === 'string' ? v.discipline.slice(0, 200) : '', subject: typeof v?.subject === 'string' ? v.subject.slice(0, 200) : '', status: ['Open', 'Answered', 'Resolved'].includes(v?.status) ? v.status : 'Open', locked: v?.locked === true,
    group: typeof v?.group === 'string' ? v.group.slice(0, 200) : undefined,
    replies: Array.isArray(v?.replies) ? v.replies.filter(r => r && typeof r.text === 'string' && typeof r.author === 'string' && Number.isFinite(r.at)).slice(0, 1000).map(r => ({ text: r.text.slice(0, 10000), author: r.author.slice(0, 200), at: r.at })) : [] };
}
function validMeasurement(m: Measurement, pages: number) {
  return m && typeof m.id === 'string' && m.id.length < 200 && Number.isInteger(m.page) && m.page >= 0 && m.page < pages && ['Length', 'Area', 'Perimeter', 'Count'].includes(m.kind) && Array.isArray(m.points) && m.points.length >= (m.kind === 'Count' ? 1 : m.kind === 'Length' ? 2 : 3) && m.points.length <= 5000 && m.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) < 1e7)) && m.scale && Number.isFinite(m.scale.unitsPerPoint) && m.scale.unitsPerPoint > 0 && ['ft', 'in', 'm', 'cm', 'mm'].includes(m.scale.unit);
}
async function fontsFor(pdf: PDFDocument, values: string[], fontBytes?: Uint8Array): Promise<Record<string, PDFFont>> {
  const sans = await pdf.embedFont(StandardFonts.Helvetica), serif = await pdf.embedFont(StandardFonts.TimesRoman), mono = await pdf.embedFont(StandardFonts.Courier);
  try { values.forEach(t => sans.encodeText(t)); return { sans, serif, mono }; } catch { /* Embed the bundled Unicode font when the standard fonts cannot represent a note. */ }
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  pdf.registerFontkit(fontkit);
  const bytes = fontBytes ?? new Uint8Array(await (await fetch(`${import.meta.env.BASE_URL}pdfjs/standard_fonts/LiberationSans-Regular.ttf`)).arrayBuffer());
  const unicode = await pdf.embedFont(bytes, { subset: true });
  const supported = new Set(unicode.getCharacterSet());
  if (values.some(t => [...t].some(c => c !== '\n' && c !== '\r' && !supported.has(c.codePointAt(0)!)))) throw new Error('The PDF font does not support some characters in your notes. Please use another spelling before exporting.');
  return { sans: unicode, serif: unicode, mono: unicode };
}
function measurementMark(m: Measurement): ReviewMark {
  return { id: m.id, page: m.page, kind: m.kind === 'Length' ? 'Line' : 'Polygon', points: m.points, text: measurementLabel(m), createdAt: 0, style: { ...defaultStyle, color: '#2f6fed', arrow: false, fontSize: 10 } };
}
function paint(page: PDFPage, mark: ReviewMark, fonts: Record<string, PDFFont>, measurement?: Measurement) {
  const s = mark.style, c = color(s.color), font = fonts[s.font];
  const geometry = reviewGeometry(mark);
  if (measurement) {
    geometry.lines = [{ point: measurement.points[0], text: measurementLabel(measurement) }];
    if (measurement.kind === 'Count') {
      geometry.paths = [];
      for (const [x, y] of measurement.points) page.drawCircle({ x, y, size: 3, borderColor: c, borderWidth: s.width });
    }
  }
  for (const path of geometry.paths) {
    if (!path.points.length) continue;
    const svg = path.points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${-y}`).join(' ') + (path.closed ? ' Z' : '');
    page.drawSvgPath(svg, { x: 0, y: 0, borderColor: c, borderWidth: s.width,
      borderDashArray: s.dash === 'solid' ? undefined : s.dash === 'dashed' ? [6, 3] : [1, 3],
      color: path.fill && path.fill !== 'none' ? color(path.fill) : undefined, opacity: s.opacity, borderOpacity: s.opacity });
  }
  for (const line of geometry.lines) page.drawText(line.text, { x: line.point[0], y: line.point[1], size: s.fontSize, font, color: c, opacity: s.opacity });
  let rect = geometry.rect;
  if (measurement) {
    const xs = measurement.points.map(p => p[0]), ys = measurement.points.map(p => p[1]);
    const labelWidth = font.widthOfTextAtSize(measurementLabel(measurement), s.fontSize);
    rect = [Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs, measurement.points[0][0] + labelWidth) + 4, Math.max(...ys, measurement.points[0][1] + s.fontSize) + 4];
  }
  return rect;
}

/** Native annotations carry appearances for other readers and structured records for Folio. */
export async function exportDrawingPdf(bytes: Uint8Array, data: DrawingData, order?: number[] | null, flatten = false, fontBytes?: Uint8Array, legacyMarks: StoredMark[] = []) {
  if (!data.measurements.length && !data.review?.length && !Object.keys(data.scales).length && !Object.keys(data.reviewMeta ?? {}).length && !flatten) return bytes;
  const pdf = await PDFDocument.load(bytes);
  const scratch = await PDFDocument.create();
  const fonts = await fontsFor(scratch, [...(data.review ?? []).map(m => m.text), ...data.measurements.map(measurementLabel)], fontBytes);
  const all = [...(data.review ?? []).map(mark => ({ mark, measurement: undefined as Measurement | undefined })), ...data.measurements.map(measurement => ({ mark: measurementMark(measurement), measurement }))];
  for (const { mark, measurement } of all) {
    const index = order?.length ? order.indexOf(mark.page + 1) : mark.page;
    if (index < 0 || index >= pdf.getPageCount()) continue;
    const target = pdf.getPage(index), appearance = scratch.addPage([target.getWidth(), target.getHeight()]);
    const rect = paint(appearance, mark, fonts, measurement);
    const form = await pdf.embedPage(appearance, { left: rect[0], bottom: rect[1], right: rect[2], top: rect[3] });
    await form.embed();
    const meta = metaFor(data, mark.id);
    const subtype = measurement ? (measurement.kind === 'Length' ? 'Line' : measurement.kind === 'Count' ? 'Ink' : 'Polygon')
      : ['Callout', 'Cloud callout', 'Text'].includes(mark.kind) ? 'FreeText' : mark.kind === 'Stamp' ? 'Stamp' : mark.kind === 'Rectangle' ? 'Square' : mark.kind === 'Oval' ? 'Circle' : ['Line', 'Arrow'].includes(mark.kind) ? 'Line' : 'Polygon';
    const exportedMark = { ...(measurement ?? mark), page: index };
    const props: NonNullable<Parameters<typeof pdf.context.formXObject>[1]> = { Type: 'Annot', Subtype: subtype, Rect: rect, AP: { N: form.ref }, F: meta.locked ? 132 : 4, NM: text(mark.id), T: text(meta.author), Subj: text(meta.subject || mark.kind), Contents: text(measurement ? measurementLabel(measurement) : mark.text), C: rgbValues(mark.style.color), CA: mark.style.opacity,
      BS: { W: mark.style.width, S: mark.style.dash === 'solid' ? 'S' : 'D', D: mark.style.dash === 'dotted' ? [1, 3] : [6, 3] },
      FolioReview: text(JSON.stringify({ version: 1, type: measurement ? 'measurement' : 'review', mark: exportedMark, meta, rect })) };
    if (mark.style.fill !== 'none') props.IC = rgbValues(mark.style.fill);
    if (subtype === 'Line') { props.L = mark.points.slice(0, 2).flat(); props.LE = ['None', mark.style.arrow ? 'OpenArrow' : 'None'].map(name); }
    if (subtype === 'Polygon') props.Vertices = (mark.kind === 'Cloud' ? reviewGeometry(mark).paths[0].points : mark.points).flat();
    if (subtype === 'Ink') props.InkList = mark.points.map(([x, y]) => [x - 2, y, x + 2, y]);
    if (subtype === 'FreeText') {
      props.DA = PDFString.of(`/${mark.style.font === 'serif' ? 'TiRo' : mark.style.font === 'mono' ? 'Cour' : 'Helv'} ${mark.style.fontSize} Tf ${rgbValues(mark.style.color).join(' ')} rg`);
      props.Q = 0;
      if (mark.kind.includes('callout') || mark.kind === 'Callout') { props.IT = name('FreeTextCallout'); props.CL = mark.points.flat(); }
    }
    if (measurement && measurement.kind !== 'Count') props.Measure = {
      Type: 'Measure', Subtype: 'RL', R: text(`1 pt = ${measurement.scale.unitsPerPoint} ${measurement.scale.unit}`),
      X: [{ Type: 'NumberFormat', U: text(measurement.scale.unit), C: measurement.scale.unitsPerPoint }],
      D: [{ Type: 'NumberFormat', U: text(measurement.scale.unit), C: measurement.scale.unitsPerPoint }],
      A: [{ Type: 'NumberFormat', U: text(measurement.scale.unit + '²'), C: measurement.scale.unitsPerPoint ** 2 }],
    };
    const annotation = pdf.context.obj(props);
    const annotationRef = pdf.context.register(annotation);
    target.node.addAnnot(annotationRef);
    for (const reply of meta.replies) target.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [rect[0], rect[1], rect[0] + 20, rect[1] + 20], IRT: annotationRef, RT: 'R', F: 4, T: text(reply.author), Contents: text(reply.text), FolioReply: true })));
    annotation.set(name('StateModel'), PDFString.of('Review'));
    annotation.set(name('State'), PDFString.of(meta.status === 'Resolved' ? 'Completed' : meta.status === 'Answered' ? 'Accepted' : 'None'));
  }
  for (const [page, scale] of Object.entries(data.scales)) {
    const index = order?.length ? order.indexOf(Number(page) + 1) : Number(page);
    if (index >= 0 && index < pdf.getPageCount()) pdf.getPage(index).node.set(name('FolioPageScale'), text(JSON.stringify(scale)));
  }
  for (const [index, page] of pdf.getPages().entries()) {
    const annotations = page.node.Annots(); if (!annotations) continue;
    const sourceIndex = order?.length ? order[index] - 1 : index;
    const matched = new Set<string>();
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const ref = annotations.get(i), dict = annotations.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const id = `pdf:${sourceIndex}:${ref.toString().replace(/ (\d+) R$/, (_, generation) => generation === '0' ? 'R' : `R${generation}`)}`;
      let meta = data.reviewMeta?.[id];
      if (!meta && !dict.has(name('FolioReview'))) {
        const rect = arrayNumbers(dict, 'Rect'), subtype = dict.get(name('Subtype'))?.toString();
        const legacy = legacyMarks.find(mark => {
          if (mark.page !== sourceIndex || matched.has(mark.id) || !data.reviewMeta?.[mark.id]) return false;
          if (subtype !== (mark.type === 'ink' ? '/Ink' : mark.type === 'freetext' ? '/FreeText' : '/Highlight')) return false;
          const saved = mark.data.rect as number[] | undefined;
          if (!saved || rect.length !== 4 || !rect.every((n, i) => Math.abs(n - saved[i]) < .05)) return false;
          return mark.type !== 'freetext' || readText(dict, 'Contents') === mark.text;
        });
        if (legacy) { matched.add(legacy.id); meta = data.reviewMeta?.[legacy.id]; }
      }
      if (meta) {
        dict.set(name('FolioReviewMeta'), text(JSON.stringify(meta))); dict.set(name('Subj'), text(meta.subject)); if (meta.author) dict.set(name('T'), text(meta.author));
        const flags = dict.lookup(name('F')); const previousFlags = flags instanceof PDFNumber ? flags.asNumber() : 4;
        if (typeof meta.locked === 'boolean') dict.set(name('F'), PDFNumber.of(meta.locked ? previousFlags | 128 : previousFlags & ~128));
        dict.set(name('StateModel'), PDFString.of('Review')); dict.set(name('State'), PDFString.of(meta.status === 'Resolved' ? 'Completed' : meta.status === 'Answered' ? 'Accepted' : 'None'));
      }
    }
  }
  if (flatten) flattenAnnotations(pdf);
  return pdf.save();
}

/** Detach only recognized, validated Folio records; leave all other annotations intact. */
export async function importDrawingPdf(bytes: Uint8Array): Promise<{ bytes: Uint8Array; drawing?: DrawingData }> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pdf.isEncrypted) return { bytes };
  const data = emptyDrawing(); data.review = []; data.reviewMeta = {};
  let changed = false;
  const ids = new Set<string>();
  for (const [pageIndex, page] of pdf.getPages().entries()) {
    try {
      const scale = JSON.parse(readText(page.node, 'FolioPageScale'));
      if (Number.isFinite(scale?.unitsPerPoint) && scale.unitsPerPoint > 0 && ['ft', 'in', 'm', 'cm', 'mm'].includes(scale.unit)) { data.scales[pageIndex] = scale; changed = true; }
    } catch { /* Ordinary pages have no saved scale. */ }
    const annotations = page.node.Annots();
    if (!annotations) continue;
    const recognizedRefs = new Map<string, string>();
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const dict = annotations.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      if (dict.get(name('FolioReply'))?.toString() === 'true' && dict.has(name('IRT'))) continue;
      const nativeMeta = readText(dict, 'FolioReviewMeta');
      if (nativeMeta && nativeMeta.length < 1000000) {
        try {
          const id = `pdf:${pageIndex}:${annotations.get(i).toString().replace(/ (\d+) R$/, (_, generation) => generation === '0' ? 'R' : `R${generation}`)}`;
          data.reviewMeta[id] = validMeta(JSON.parse(nativeMeta)); changed = true;
        } catch { /* Keep malformed third-party metadata untouched. */ }
      }
      const encoded = readText(dict, 'FolioReview');
      if (!encoded || encoded.length > 1000000) continue;
      try {
        const record = JSON.parse(encoded), mark = record.mark;
        mark.page = pageIndex;
        if (record.version !== 1 || ids.has(mark.id) || !(record.type === 'review' ? validateReviewMark(mark, pdf.getPageCount()) : record.type === 'measurement' && validMeasurement(mark, pdf.getPageCount()))) continue;
        // Respect moves/resizes and text changes made by another PDF reader.
        const rect = arrayNumbers(dict, 'Rect'), old = record.rect;
        if (rect.length === 4 && rect.every(Number.isFinite) && Array.isArray(old) && old.length === 4 && old.every(Number.isFinite) && old[2] > old[0] && old[3] > old[1]) {
          mark.points = mark.points.map(([x, y]: Point) => [rect[0] + (x - old[0]) * (rect[2] - rect[0]) / (old[2] - old[0]), rect[1] + (y - old[1]) * (rect[3] - rect[1]) / (old[3] - old[1])]);
        }
        if (record.type === 'review') { mark.text = readText(dict, 'Contents'); if (!validateReviewMark(mark, pdf.getPageCount())) continue; data.review.push(mark); }
        else { if (!validMeasurement(mark, pdf.getPageCount())) continue; data.measurements.push(mark); }
        const meta = validMeta(record.meta);
        const state = readText(dict, 'State');
        if (state === 'Completed') meta.status = 'Resolved'; else if (state === 'Accepted') meta.status = 'Answered'; else if (state === 'None') meta.status = 'Open';
        const flags = dict.lookup(name('F')); if (flags instanceof PDFNumber) meta.locked = !!(flags.asNumber() & 128);
        const author = readText(dict, 'T'); if (author) meta.author = author;
        data.reviewMeta[mark.id] = meta;
        ids.add(mark.id); recognizedRefs.set(annotations.get(i).toString(), mark.id); annotations.remove(i); changed = true;
      } catch { /* Invalid metadata must never remove the visible PDF annotation. */ }
    }
    // Replies are detached only after their parent has been restored successfully.
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const dict = annotations.lookup(i);
      if (!(dict instanceof PDFDict) || dict.get(name('Subtype'))?.toString() !== '/Text') continue;
      const parent = recognizedRefs.get(dict.get(name('IRT'))?.toString() ?? '');
      if (!parent) continue;
      const reply = readText(dict, 'Contents'), author = readText(dict, 'T'), meta = data.reviewMeta[parent];
      if (reply && !meta.replies.some(r => r.text === reply && r.author === author)) meta.replies.push({ text: reply.slice(0, 10000), author: author.slice(0, 200), at: Date.now() });
      annotations.remove(i);
    }
  }
  if (!changed) return { bytes };
  return { bytes: await pdf.save(), drawing: data };
}

export function flattenAnnotations(pdf: PDFDocument) {
  if (pdf.catalog.has(name('AcroForm'))) pdf.getForm().flatten({ updateFieldAppearances: false });
  for (const page of pdf.getPages()) {
    const annotations = page.node.Annots(); if (!annotations) continue;
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const dict = annotations.lookup(i); if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.get(name('Subtype'))?.toString();
      if (subtype === '/Link') continue;
      if (subtype === '/Popup' || subtype === '/Text' && dict.has(name('IRT'))) { annotations.remove(i); continue; }
      const ap = dict.lookup(name('AP'));
      let stream = ap instanceof PDFDict ? ap.lookup(name('N')) : undefined;
      if (stream instanceof PDFDict) stream = stream.lookup(dict.get(name('AS')) as PDFName);
      if (!(stream instanceof PDFStream)) throw new Error('An annotation has no printable appearance. Save an editable copy instead.');
      const rect = arrayNumbers(dict, 'Rect'), bbox = arrayNumbers(stream.dict, 'BBox');
      const matrix = arrayNumbers(stream.dict, 'Matrix'); const m = matrix.length === 6 ? matrix : [1, 0, 0, 1, 0, 0];
      if (rect.length !== 4 || bbox.length !== 4) throw new Error('An annotation has invalid bounds. Save an editable copy instead.');
      const corners = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const l = Math.min(...corners.map(p => p[0])), b = Math.min(...corners.map(p => p[1])), w = Math.max(...corners.map(p => p[0])) - l, h = Math.max(...corners.map(p => p[1])) - b;
      if (w <= 0 || h <= 0) throw new Error('An annotation has invalid bounds.');
      const x = (rect[2] - rect[0]) / w, y = (rect[3] - rect[1]) / h;
      const key = page.node.newXObject('Review', pdf.context.register(stream));
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(x, 0, 0, y, rect[0] - l * x, rect[1] - b * y), drawObject(key), popGraphicsState());
      annotations.remove(i);
    }
    page.node.delete(name('FolioPageScale'));
  }
}
export async function reviewReport(rows: ReviewRow[], title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = await fontsFor(pdf, [title, ...rows.flatMap(r => [r.text, r.meta.author, r.meta.discipline, r.meta.subject, ...r.meta.replies.map(p => p.text + p.author)])]);
  let page = pdf.addPage([612, 792]), y = 750;
  const write = (value: string, size = 10) => {
    // Use the same word wrap as on-page callouts, with room for long review comments.
    for (const line of wrapReviewText(value, 520, size)) {
      if (y < 45) { page = pdf.addPage([612, 792]); y = 750; }
      page.drawText(line, { x: 46, y, size, font: fonts.sans }); y -= size * 1.4;
    }
  };
  write(title, 18); y -= 10;
  write(`${rows.length} review items • ${new Date().toLocaleDateString()}`); y -= 16;
  for (const row of rows) {
    write(`Sheet ${row.page + 1} — ${row.kind} — ${row.meta.status}`, 12);
    if (row.meta.subject) write(row.meta.subject, 12);
    write([row.meta.author, row.meta.discipline].filter(Boolean).join(' / '));
    write(row.text);
    for (const reply of row.meta.replies) write(`${reply.author || 'Reviewer'}: ${reply.text}`);
    y -= 16;
  }
  return pdf.save();
}
