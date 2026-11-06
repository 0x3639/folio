import { X509Certificate, randomUUID } from 'node:crypto';
import { PDF, P12Signer, PdfArray, PdfDict, PdfName, PdfNumber, PdfString, HttpTimestampAuthority } from '@libpdf/core';
import { fromBER } from 'asn1js';
import { ContentInfo, SignedData, TSTInfo } from 'pkijs';

const numberArray = values => new PdfArray(values.map(PdfNumber.of));
const MAX_PDF = 300 * 1024 * 1024;
function requireSignedAttributes(cms, contentType) {
  if (cms.signerInfos.length !== 1) throw new Error('Expected one CMS signer.');
  const attributes = cms.signerInfos[0].signedAttrs?.attributes ?? [];
  const types = attributes.filter(a => a.type === '1.2.840.113549.1.9.3');
  const digests = attributes.filter(a => a.type === '1.2.840.113549.1.9.4');
  if (types.length !== 1 || types[0].values.length !== 1 || types[0].values[0].valueBlock.toString() !== contentType || digests.length !== 1 || digests[0].values.length !== 1) throw new Error('Invalid CMS signed attributes.');
}
function timestampAuthority() {
  // DigiCert publishes an HTTP RFC 3161 endpoint. Only a digest is sent; the
  // response is signed. Verify the response signature and imprint before embedding.
  const service = new HttpTimestampAuthority('http://timestamp.digicert.com', { timeout: 30000,
    fetch: async (url, options) => {
      const response = await globalThis.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) return response;
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 1024 * 1024) throw new Error('Timestamp response is too large.'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      return new Response(Buffer.concat(chunks), { status: response.status });
    } });
  return { async timestamp(digest, algorithm) {
    const token = await service.timestamp(digest, algorithm);
    const parsed = fromBER(token.slice().buffer);
    const cms = new SignedData({ schema: new ContentInfo({ schema: parsed.result }).content });
    if (cms.encapContentInfo.eContentType !== '1.2.840.113549.1.9.16.1.4') throw new Error('Timestamp response has the wrong content type.');
    requireSignedAttributes(cms, cms.encapContentInfo.eContentType);
    const info = new TSTInfo({ schema: fromBER(cms.encapContentInfo.eContent.getValue()).result });
    if (info.messageImprint.hashAlgorithm.algorithmId !== '2.16.840.1.101.3.4.2.1' || !Buffer.from(info.messageImprint.hashedMessage.getValue()).equals(Buffer.from(digest))) throw new Error('Timestamp does not match this signature.');
    // PKI.js checks TSTInfo against input data when supplied. Here the caller
    // already supplied a digest, so verify CMS over the encapsulated TSTInfo.
    const type = cms.encapContentInfo.eContentType;
    cms.encapContentInfo.eContentType = '1.2.840.113549.1.7.1';
    const valid = await cms.verify({ signer: 0, checkChain: false });
    cms.encapContentInfo.eContentType = type;
    if (!valid) throw new Error('Timestamp signature could not be verified.');
    return token;
  } };
}
export function pdfBytes(value) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > MAX_PDF) throw new Error('Choose a PDF smaller than 300 MB.');
  return value;
}
export function certificateDetails(bytes) {
  const cert = new X509Certificate(bytes);
  return { name: /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1] || cert.subject,
    subject: cert.subject, issuer: cert.issuer, fingerprint: cert.fingerprint256,
    validFrom: cert.validFrom, validTo: cert.validTo };
}
export async function unlockCertificate(bytes, password) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 5 * 1024 * 1024 || typeof password !== 'string' || password.length > 1024) throw new Error('Invalid digital ID.');
  let signer;
  try { signer = await P12Signer.create(bytes, password, { buildChain: false }); }
  catch { throw new Error('Could not unlock the digital ID. Check the password and use a .p12 or .pfx file containing a private key.'); }
  const details = certificateDetails(signer.certificate);
  if (Date.now() < Date.parse(details.validFrom) || Date.now() > Date.parse(details.validTo)) throw new Error('This certificate is expired or is not valid yet. Choose a current digital ID.');
  return { signer, details };
}

// Integrity is distinct from trust: this never claims to validate a CA chain, revocation, or TSA trust.
export async function inspectSignatures(input) {
  const bytes = pdfBytes(input), pdf = await PDF.load(bytes);
  const resolve = ref => pdf.getObject(ref), catalog = pdf.getCatalog();
  const certification = catalog.getDict('Perms', resolve)?.getDict('DocMDP', resolve);
  const references = certification?.getArray('Reference', resolve)?.toArray() ?? [];
  const permission = references.map(ref => ref instanceof PdfDict ? ref : resolve(ref))
    .find(ref => ref instanceof PdfDict && ref.getName('TransformMethod')?.value === 'DocMDP')?.getDict('TransformParams', resolve)?.getNumber('P')?.value;
  const signatures = [];
  for (const field of pdf.getForm()?.getSignatureFields() ?? []) {
    if (!field.isSigned()) continue;
    const entry = { field: field.name, name: '', integrity: false, coversCurrentFile: false, signedLength: 0, timestamp: false, error: '' };
    try {
      const dict = field.getSignatureDict();
      const filter = dict?.getName('SubFilter')?.value;
      if (!['ETSI.CAdES.detached', 'adbe.pkcs7.detached'].includes(filter)) throw new Error('This signature format is not verified by Folio. Use Acrobat to validate it.');
      const range = dict.getArray('ByteRange')?.toArray().map(n => n.value), contents = dict.getString('Contents')?.bytes;
      if (!range || range.length !== 4 || range.some(n => !Number.isSafeInteger(n) || n < 0) || range[0] !== 0 || range[1] >= range[2] || range[2] + range[3] > bytes.length || !contents) throw new Error('Invalid signature byte ranges.');
      const gap = Buffer.from(bytes.subarray(range[1], range[2])).toString('ascii');
      if (!/^<[\da-fA-F\s]+>$/.test(gap) || !Buffer.from(gap.slice(1, -1).replace(/\s/g, ''), 'hex').equals(Buffer.from(contents))) throw new Error('Signature does not cover the expected document bytes.');
      const decoded = fromBER(contents.slice().buffer);
      if (decoded.offset < 0 || contents.subarray(decoded.offset).some(b => b !== 0)) throw new Error('Invalid signature contents.');
      const cms = new SignedData({ schema: new ContentInfo({ schema: decoded.result }).content });
      if (cms.encapContentInfo.eContent || cms.encapContentInfo.eContentType !== '1.2.840.113549.1.7.1') throw new Error('Expected a detached signature over the PDF.');
      requireSignedAttributes(cms, cms.encapContentInfo.eContentType);
      const data = Buffer.concat([bytes.subarray(0, range[1]), bytes.subarray(range[2], range[2] + range[3])]);
      const result = await cms.verify({ signer: 0, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), checkChain: false, extendedMode: true });
      entry.integrity = result.signatureVerified === true;
      if (result.signerCertificate) entry.name = certificateDetails(new Uint8Array(result.signerCertificate.toSchema().toBER(false))).name;
      entry.signedLength = range[2] + range[3];
      entry.coversCurrentFile = entry.signedLength === bytes.length;
      entry.timestamp = !!cms.signerInfos[0]?.unsignedAttrs?.attributes.some(a => a.type === '1.2.840.113549.1.9.16.2.14');
      if (!entry.integrity) entry.error = 'The signed content or signature has changed.';
    } catch (error) { entry.error = error.message || 'Could not verify this signature.'; }
    signatures.push(entry);
  }
  return { signatures, locked: permission === 1, certified: !!certification,
    unsignedChanges: signatures.length > 0 && !signatures.some(s => s.coversCurrentFile), trust: 'not-checked' };
}

export async function signPdf(input, signer, options = {}) {
  const bytes = pdfBytes(input), before = await inspectSignatures(bytes);
  if (before.certified) throw new Error('This PDF is already certified. Folio will preserve it unchanged.');
  if (before.signatures.some(s => !s.integrity) || before.unsignedChanges) throw new Error('Existing signatures could not be verified against this document. Resolve this in a signature-validation viewer before signing.');
  if (options.lock && before.signatures.length) throw new Error('Sign and lock requires an unsigned PDF. You can add an approval signature without replacing existing signatures.');
  const pdf = await PDF.load(bytes);
  if (pdf.isEncrypted) throw new Error('Signing encrypted PDFs is not supported. Use an unsigned, unencrypted original.');
  if (typeof options.lock !== 'boolean' || typeof options.timestamp !== 'boolean' || typeof options.reason !== 'string' || options.reason.length > 500) throw new Error('Invalid signing options.');
  const page = pdf.getPage(options.page);
  if (!page) throw new Error('Choose a page in this PDF.');
  const rect = options.rect;
  if (rect !== null && (!Array.isArray(rect) || rect.length !== 4 || rect.some(n => !Number.isFinite(n) || Math.abs(n) > 1e7) || rect[2] <= rect[0] || rect[3] <= rect[1])) throw new Error('Invalid signature position.');
  const details = certificateDetails(signer.certificate), time = new Date();
  if (time < new Date(details.validFrom) || time > new Date(details.validTo)) throw new Error('The signing certificate is not currently valid.');
  const name = `FolioSignature_${randomUUID()}`;
  const form = pdf.getOrCreateForm(), field = form.createSignatureField(name), fieldDict = field.getDict();
  // The pinned signing engine creates its signature dictionary immediately before saving.
  // Add the standard permission transform and widget appearance at that save boundary,
  // BEFORE it hashes any bytes. Never modify a signed result or rewrite prior revisions.
  const save = pdf.save.bind(pdf);
  let prepared = false;
  pdf.save = async settings => {
    if (!prepared) {
      prepared = true;
      const signature = field.getSignatureDict(), signatureRef = fieldDict.getRef('V');
      if (!signature || !signatureRef) throw new Error('Signing engine did not prepare a signature.');
      signature.set('Name', PdfString.fromString(details.name));
      if (options.lock) {
        for (const entry of form.getFields()) {
          const dict = entry.getDict();
          dict.set('Ff', PdfNumber.of((dict.getNumber('Ff')?.value ?? 0) | 1));
        }
        const params = PdfDict.of({ Type: PdfName.of('TransformParams'), P: PdfNumber.of(1), V: PdfName.of('1.2') });
        signature.set('Reference', new PdfArray([PdfDict.of({ Type: PdfName.of('SigRef'), TransformMethod: PdfName.of('DocMDP'), TransformParams: params })]));
        pdf.getCatalog().set('Perms', PdfDict.of({ DocMDP: signatureRef }));
        fieldDict.set('Lock', PdfDict.of({ Type: PdfName.of('SigFieldLock'), Action: PdfName.of('All'), P: PdfNumber.of(1) }));
      }
      fieldDict.set('P', page.ref);
      fieldDict.set('F', PdfNumber.of(132));
      fieldDict.set('Ff', PdfNumber.of(1));
      fieldDict.set('Rect', numberArray(rect ?? [0, 0, 0, 0]));
      let visibleStamp;
      if (rect) {
        const rotated = page.rotation === 90 || page.rotation === 270;
        const width = rotated ? rect[3] - rect[1] : rect[2] - rect[0], height = rotated ? rect[2] - rect[0] : rect[3] - rect[1];
        const font = pdf.createDict({ Type: PdfName.of('Font'), Subtype: PdfName.of('Type1'), BaseFont: PdfName.of('Helvetica') });
        const text = value => value.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
        const lines = ['Digitally signed', details.name.slice(0, 42), time.toISOString(), options.lock ? 'Certified: no changes permitted' : 'Approval signature'];
        const stream = `q 1 1 1 rg 0 0 ${width} ${height} re f 0.15 0.3 0.5 RG 1 w 0.5 0.5 ${width - 1} ${height - 1} re S 0 0 0 rg BT /F1 9 Tf 6 ${height - 14} Td 12 TL ${lines.map((line, i) => `${i ? 'T* ' : ''}(${text(line)}) Tj`).join(' ')} ET Q`;
        const matrix = page.rotation === 90 ? [0, 1, -1, 0, height, 0] : page.rotation === 180 ? [-1, 0, 0, -1, width, height] : page.rotation === 270 ? [0, -1, 1, 0, 0, width] : [1, 0, 0, 1, 0, 0];
        const appearance = pdf.createStream({ Type: PdfName.of('XObject'), Subtype: PdfName.of('Form'), BBox: numberArray([0, 0, rect[2] - rect[0], rect[3] - rect[1]]), Resources: PdfDict.of({ Font: PdfDict.of({ F1: font }) }) }, new TextEncoder().encode(`q ${matrix.join(' ')} cm ${stream} Q`));
        // PDFKit omits signature-widget appearances on rotated sheets. A standard
        // locked Stamp carries the visible appearance; the transparent signature
        // widget retains its location and validation behavior. Both are signed.
        visibleStamp = pdf.createDict({ Type: PdfName.of('Annot'), Subtype: PdfName.of('Stamp'), Name: PdfName.of('Approved'),
          Rect: numberArray(rect), P: page.ref, F: PdfNumber.of(708), NM: PdfString.fromString(`${name}_appearance`),
          Contents: PdfString.fromString(`Digitally signed by ${details.name}. Validate using the document's digital signatures.`), AP: PdfDict.of({ N: appearance }) });
        const transparent = pdf.createStream({ Type: PdfName.of('XObject'), Subtype: PdfName.of('Form'), BBox: numberArray([0, 0, rect[2] - rect[0], rect[3] - rect[1]]), Resources: new PdfDict() }, new Uint8Array());
        fieldDict.set('AP', PdfDict.of({ N: transparent }));
      }
      const fieldRef = pdf.context.getRef(fieldDict);
      if (!fieldRef) throw new Error('Signature field has no reference.');
      // The signing engine may attach its invisible widget to page 1. Move it cleanly.
      for (const p of pdf.getPages()) {
        const annots = p.dict.getArray('Annots', ref => pdf.getObject(ref));
        if (annots) for (let i = annots.length - 1; i >= 0; i--) if (annots.at(i)?.toString() === fieldRef.toString()) annots.remove(i);
      }
      let annots = page.dict.getArray('Annots', ref => pdf.getObject(ref));
      if (!annots) { annots = new PdfArray(); page.dict.set('Annots', annots); }
      if (visibleStamp) annots.push(visibleStamp);
      annots.push(fieldRef);
      const acro = pdf.getCatalog().getDict('AcroForm', ref => pdf.getObject(ref));
      acro.set('SigFlags', PdfNumber.of(3)); acro.delete('NeedAppearances');
    }
    return save(settings);
  };
  const result = await pdf.sign({ signer, fieldName: name, reason: options.reason, signingTime: time,
    subFilter: 'ETSI.CAdES.detached', digestAlgorithm: 'SHA-256', estimatedSize: 32768,
    level: options.timestamp ? 'B-T' : 'B-B',
    timestampAuthority: options.timestamp ? timestampAuthority() : undefined });
  if (result.warnings.length) throw new Error('Signing reported a PDF compatibility warning. No signed copy was saved.');
  if (before.signatures.length && !Buffer.from(result.bytes.subarray(0, bytes.length)).equals(Buffer.from(bytes))) throw new Error('Signing would change an earlier revision. No copy was saved.');
  const verified = await inspectSignatures(result.bytes);
  if (verified.signatures.length !== before.signatures.length + 1 || verified.signatures.some(s => !s.integrity) || verified.unsignedChanges || verified.locked !== options.lock) throw new Error('The signed PDF did not pass verification. No copy was saved.');
  return { bytes: result.bytes, verification: verified };
}
