import { PDFArray, PDFDict, PDFHexString, PDFName, PDFString, PDFNumber, PDFBool, PDFRawStream, decodePDFRawStream, type PDFDocument, type PDFRef } from 'pdf-lib';
import type { DrawingData } from './measurements';
import type { ReviewLayer } from './reviewModel';
const n = PDFName.of;
const string = (dict: PDFDict, key: string) => {
  const value = dict.lookup(n(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
};

/** Preserve exported visibility even in readers that ignore annotation optional content. */
export function setLayerVisibility(annotation: PDFDict, visible: boolean) {
  const value = annotation.lookup(n('F'));
  let flags = value instanceof PDFNumber ? value.asNumber() : 4;
  if (annotation.get(n('FolioLayerHidden'))?.toString() === 'true') {
    flags &= ~2; annotation.delete(n('FolioLayerHidden'));
  }
  if (!visible && !(flags & 2)) { flags |= 2; annotation.set(n('FolioLayerHidden'), PDFBool.True); }
  annotation.set(n('F'), PDFNumber.of(flags));
}

/** Some readers ignore an annotation's OC entry, but honor marked content in its appearance. */
export function layerAppearance(pdf: PDFDocument, annotation: PDFDict, layer?: PDFRef) {
  const ap = annotation.lookup(n('AP')); if (!(ap instanceof PDFDict)) return;
  const normal = ap.lookup(n('N'));
  const wrap = (holder: PDFDict, key: PDFName) => {
    let stream = holder.lookup(key);
    if (!(stream instanceof PDFRawStream)) return;
    let original = holder.get(key)!;
    if (stream.dict.has(n('FolioLayerOriginal'))) {
      original = stream.dict.get(n('FolioLayerOriginal'))!;
      stream = pdf.context.lookup(original);
      holder.set(key, original);
    }
    if (!layer || !(stream instanceof PDFRawStream)) return;
    const existingResources = stream.dict.lookup(n('Resources'));
    const resources = existingResources instanceof PDFDict ? existingResources.clone() : pdf.context.obj({});
    const existingProperties = resources.lookup(n('Properties'));
    const properties = existingProperties instanceof PDFDict ? existingProperties.clone() : pdf.context.obj({});
    const propertyName = n(pdf.context.addRandomSuffix('FolioReviewLayer', 10));
    properties.set(propertyName, layer); resources.set(n('Properties'), properties);
    const start = new TextEncoder().encode(`/OC ${propertyName.toString()} BDC\n`), end = new TextEncoder().encode('\nEMC\n');
    const decoded = decodePDFRawStream(stream).decode();
    const contents = new Uint8Array(start.length + decoded.length + end.length);
    contents.set(start); contents.set(decoded, start.length); contents.set(end, start.length + decoded.length);
    const attributes = Object.fromEntries(stream.dict.entries().filter(([key]) => !['Length', 'Filter', 'DecodeParms'].includes(key.decodeText())).map(([key, value]) => [key.decodeText(), value]));
    const wrapped = pdf.context.flateStream(contents, { ...attributes, Resources: resources, FolioLayerOriginal: original });
    holder.set(key, pdf.context.register(wrapped));
  };
  if (normal instanceof PDFDict) for (const key of normal.keys()) wrap(normal, key);
  else wrap(ap, n('N'));
}
export function readReviewLayers(pdf: PDFDocument): Pick<DrawingData, 'layers' | 'layerGroups'> {
  const props = pdf.catalog.lookup(n('OCProperties'));
  if (!(props instanceof PDFDict)) return {};
  const groups = props.lookup(n('OCGs')), defaults = props.lookup(n('D'));
  if (!(groups instanceof PDFArray)) return {};
  const off = defaults instanceof PDFDict ? defaults.lookup(n('OFF')) : undefined;
  const on = defaults instanceof PDFDict ? defaults.lookup(n('ON')) : undefined;
  const baseOff = defaults instanceof PDFDict && defaults.get(n('BaseState'))?.toString() === '/OFF';
  const refs = (value: unknown) => new Set(value instanceof PDFArray ? value.asArray().map(r => r.toString()) : []);
  const offRefs = refs(off), onRefs = refs(on);
  const layers: ReviewLayer[] = [], layerGroups: Record<string, string[]> = {};
  for (let i = 0; i < groups.size(); i++) {
    const group = groups.lookup(i); if (!(group instanceof PDFDict)) continue;
    const id = string(group, 'FolioLayerId'), label = string(group, 'Name');
    if (!id || id.length > 200 || !label || label.length > 200) continue;
    const ref = groups.get(i).toString();
    const visible = onRefs.has(ref) || !offRefs.has(ref) && !baseOff;
    if (!layerGroups[id]) { layers.push({ id, name: label, visible }); layerGroups[id] = []; }
    layerGroups[id].push(ref.replace(/ 0 R$/, 'R'));
  }
  return layers.length ? { layers, layerGroups } : {};
}

/** Standard optional-content groups make review layers usable in other PDF readers. */
export function writeReviewLayers(pdf: PDFDocument, layers: ReviewLayer[] = []): Map<string, PDFRef> {
  const result = new Map<string, PDFRef>();
  if (!layers.length) return result;
  let props = pdf.catalog.lookup(n('OCProperties'));
  if (!(props instanceof PDFDict)) { props = pdf.context.obj({}); pdf.catalog.set(n('OCProperties'), props); }
  const dict = props as PDFDict;
  let groups = dict.lookup(n('OCGs'));
  if (!(groups instanceof PDFArray)) { groups = pdf.context.obj([]); dict.set(n('OCGs'), groups); }
  let defaults = dict.lookup(n('D'));
  if (!(defaults instanceof PDFDict)) { defaults = pdf.context.obj({ BaseState: 'ON' }); dict.set(n('D'), defaults); }
  const d = defaults as PDFDict;
  const array = (key: string): PDFArray => {
    const found = d.lookup(n(key)); if (found instanceof PDFArray) return found;
    const value = pdf.context.obj([]); d.set(n(key), value); return value;
  };
  const on = array('ON'), off = array('OFF'), order = array('Order');
  const remove = (list: PDFArray, ref: PDFRef) => { for (let i = list.size() - 1; i >= 0; i--) if (list.get(i).toString() === ref.toString()) list.remove(i); };
  for (const layer of layers) {
    let ref: PDFRef | undefined;
    for (let i = 0; i < (groups as PDFArray).size(); i++) {
      const group = (groups as PDFArray).lookup(i);
      if (group instanceof PDFDict && string(group, 'FolioLayerId') === layer.id) { ref = (groups as PDFArray).get(i) as PDFRef; break; }
    }
    if (!ref) {
      ref = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFHexString.fromText(layer.name), FolioLayerId: PDFHexString.fromText(layer.id) }));
      (groups as PDFArray).push(ref); order.push(ref);
    } else (pdf.context.lookup(ref) as PDFDict).set(n('Name'), PDFHexString.fromText(layer.name));
    remove(on, ref); remove(off, ref); (layer.visible ? on : off).push(ref);
    result.set(layer.id, ref);
  }
  return result;
}
