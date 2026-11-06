import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { init } from '@embedpdf/pdfium';
import { unlockCertificate, signPdf, inspectSignatures } from '../electron/pdf-signing.mjs';

export function makeIdentity(folder) {
  const key = path.join(folder, 'key.pem'), cert = path.join(folder, 'cert.pem'), p12 = path.join(folder, 'reviewer.p12');
  const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=Folio Test Reviewer/O=Test Only');
  openssl('pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', 'pass:folio-test-only', '-keypbe', 'AES-256-CBC', '-certpbe', 'AES-256-CBC', '-macalg', 'sha256');
  return p12;
}

export async function checkDigitalSignatures() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'folio-digital-sign-'));
  const output = path.resolve('release/smoke'); mkdirSync(output, { recursive: true });
  try {
    const p12 = makeIdentity(temporary), p12Bytes = readFileSync(p12);
    await assert.rejects(unlockCertificate(p12Bytes, 'incorrect'), /Could not unlock/);
    const { signer, details } = await unlockCertificate(p12Bytes, 'folio-test-only');
    assert.equal(details.name, 'Folio Test Reviewer');
    const source = await PDFDocument.create();
    source.addPage([612, 792]).drawText('Digital signature verification fixture', { x: 40, y: 720 });
    // Keep page 2 blank so rendering checks can only pass on the signature itself.
    source.addPage([612, 792]);
    const field = source.getForm().createTextField('Review reference'); field.setText('Drawing 42'); field.addToPage(source.getPage(0), { x: 40, y: 650, width: 200, height: 25 });
    const original = await source.save();
    const options = { page: 1, rect: [60, 80, 300, 145], reason: 'Reviewed drawing', timestamp: false, lock: true };
    const locked = await signPdf(original, signer, options);
    assert.equal(locked.verification.locked, true);
    assert.equal(locked.verification.signatures[0].integrity, true);
    assert.equal(locked.verification.signatures[0].coversCurrentFile, true);
    writeFileSync(path.join(output, 'digital-signed-locked.pdf'), locked.bytes);
    const parsed = await PDFDocument.load(locked.bytes);
    const cert = parsed.catalog.lookup(PDFName.of('Perms')).lookup(PDFName.of('DocMDP'));
    assert.equal(cert.lookup(PDFName.of('Reference')).lookup(0).lookup(PDFName.of('TransformParams')).lookup(PDFName.of('P')).asNumber(), 1);
    assert.equal(parsed.getForm().getTextField('Review reference').getText(), 'Drawing 42');
    assert.ok(parsed.getPage(1).node.Annots().size() > 0, 'signature is on the selected sheet');
    await assert.rejects(signPdf(locked.bytes, signer, options), /already certified/);
    const modified = Buffer.from(locked.bytes); modified[modified.indexOf(Buffer.from('Reviewed drawing'))] = 88;
    assert.equal((await inspectSignatures(modified)).signatures[0].integrity, false, 'alteration is detected');
    // A valid CMS signature over embedded, unrelated text must never verify as a PDF signature.
    const unrelated = path.join(temporary, 'unrelated.txt'), attached = path.join(temporary, 'attached.der');
    writeFileSync(unrelated, 'This is not the signed PDF.');
    execFileSync('openssl', ['cms', '-sign', '-nodetach', '-binary', '-in', unrelated, '-signer', path.join(temporary, 'cert.pem'), '-inkey', path.join(temporary, 'key.pem'), '-outform', 'DER', '-out', attached], { stdio: 'pipe' });
    const signedRange = cert.lookup(PDFName.of('ByteRange')).asArray().map(n => n.asNumber());
    const substituted = Buffer.from(locked.bytes), attachedHex = readFileSync(attached).toString('hex');
    const gapLength = signedRange[2] - signedRange[1];
    assert.ok(attachedHex.length < gapLength - 2);
    substituted.write(`<${attachedHex.padEnd(gapLength - 2, '0')}>`, signedRange[1], 'ascii');
    const rejected = (await inspectSignatures(substituted)).signatures[0];
    assert.equal(rejected.integrity, false);
    assert.match(rejected.error, /detached signature/);
    assert.equal((await inspectSignatures(Buffer.concat([locked.bytes, Buffer.from('\n% unsigned edit\n')]))).unsignedChanges, true);
    const approved = await signPdf(original, signer, { ...options, lock: false });
    const twice = await signPdf(approved.bytes, signer, { ...options, lock: false, page: 0, rect: [60, 80, 300, 145] });
    assert.equal(twice.verification.signatures.length, 2);
    assert.ok(twice.verification.signatures.every(s => s.integrity));
    assert.ok(Buffer.from(twice.bytes.subarray(0, approved.bytes.length)).equals(Buffer.from(approved.bytes)));
    await assert.rejects(signPdf(approved.bytes, signer, options), /unsigned PDF/);
    writeFileSync(path.join(output, 'digital-signed-twice.pdf'), twice.bytes);
    const withoutAppearance = await signPdf(original, signer, { ...options, rect: null });
    assert.ok(withoutAppearance.verification.signatures[0].integrity, 'invisible signatures verify');
    const rotatedSource = await PDFDocument.load(original);
    rotatedSource.getPage(1).setRotation(degrees(90));
    rotatedSource.getPage(1).setCropBox(10, 20, 590, 750);
    const rotated = await signPdf(await rotatedSource.save(), signer, { ...options, rect: [60, 80, 125, 320] });
    writeFileSync(path.join(output, 'digital-signed-rotated.pdf'), rotated.bytes);
    const engine = await init({ wasmBinary: readFileSync(new URL('../node_modules/@embedpdf/pdfium/dist/pdfium.wasm', import.meta.url)) });
    engine.PDFiumExt_Init();
    for (const [label, bytes, count, permission] of [['locked', locked.bytes, 1, 1], ['twice', twice.bytes, 2, 0], ['rotated', rotated.bytes, 1, 1]]) {
      const ptr = engine.pdfium.wasmExports.malloc(bytes.length); engine.pdfium.HEAPU8.set(bytes, ptr);
      const doc = engine.FPDF_LoadMemDocument(ptr, bytes.length, ''); assert.ok(doc);
      assert.equal(engine.FPDF_GetSignatureCount(doc), count);
      assert.equal(engine.FPDFSignatureObj_GetDocMDPPermission(engine.FPDF_GetSignatureObject(doc, 0)), permission);
      const page = engine.FPDF_LoadPage(doc, 1), bitmap = engine.FPDFBitmap_Create(612, 792, 1);
      const formInfo = engine.PDFiumExt_OpenFormFillInfo(), formHandle = engine.PDFiumExt_InitFormFillEnvironment(doc, formInfo);
      engine.FORM_OnAfterLoadPage(page, formHandle);
      engine.FPDFBitmap_FillRect(bitmap, 0, 0, 612, 792, 0xffffffff);
      engine.FPDF_RenderPageBitmap(bitmap, page, 0, 0, 612, 792, 0, 1);
      engine.FPDF_FFLDraw(formHandle, bitmap, page, 0, 0, 612, 792, 0, 1);
      const start = engine.FPDFBitmap_GetBuffer(bitmap), pixels = engine.pdfium.HEAPU8.subarray(start, start + engine.FPDFBitmap_GetStride(bitmap) * 792);
      let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (Math.min(...pixels.subarray(i, i + 3)) < 200) ink++;
      assert.ok(ink > 700, 'signature appearance renders in PDFium');
      engine.FORM_OnBeforeClosePage(page, formHandle); engine.FPDFBitmap_Destroy(bitmap); engine.FPDF_ClosePage(page);
      engine.PDFiumExt_ExitFormFillEnvironment(formHandle); engine.PDFiumExt_CloseFormFillInfo(formInfo);
      engine.FPDF_CloseDocument(doc); engine.pdfium.wasmExports.free(ptr);
      console.log(`PASS PDFium reads ${label} signature fields and certification permissions`);
    }
    const fetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
      await assert.rejects(signPdf(original, signer, { ...options, timestamp: true }), /503|timestamp|Timestamp/);
    } finally { globalThis.fetch = fetch; }
    if (process.env.FOLIO_TEST_TIMESTAMP === '1') {
      const timestamped = await signPdf(original, signer, { ...options, timestamp: true });
      assert.equal(timestamped.verification.signatures[0].timestamp, true);
      writeFileSync(path.join(output, 'digital-signed-timestamped.pdf'), timestamped.bytes);
      console.log('PASS live DigiCert timestamp is embedded in a valid signature');
    }
    // OpenSSL verifies CMS independently of the signing/verification implementation.
    for (const [label, data] of [['locked', locked.bytes], ['twice', twice.bytes]]) {
      const doc = await PDFDocument.load(data);
      const fields = doc.getForm().getFields().filter(f => f.constructor.name === 'PDFSignature');
      for (const [index, f] of fields.entries()) {
        const sig = f.acroField.dict.lookup(PDFName.of('V'));
        const range = sig.lookup(PDFName.of('ByteRange')).asArray().map(n => n.asNumber());
        const cms = sig.lookup(PDFName.of('Contents')).asBytes();
        const content = path.join(temporary, 'content.bin'), signature = path.join(temporary, 'signature.der');
        writeFileSync(content, Buffer.concat([data.subarray(0, range[1]), data.subarray(range[2], range[2] + range[3])]));
        writeFileSync(signature, cms);
        execFileSync('openssl', ['cms', '-verify', '-binary', '-inform', 'DER', '-in', signature, '-content', content, '-noverify', '-out', path.join(temporary, 'verified.bin')], { stdio: 'pipe' });
        console.log(`PASS OpenSSL verifies ${label} signature ${index + 1}`);
      }
    }
    if (process.env.FOLIO_PDFSIG === '1') {
      for (const file of ['digital-signed-locked.pdf', 'digital-signed-twice.pdf']) {
        const report = execFileSync('pdfsig', [path.join(output, file)], { encoding: 'utf8' });
        assert.match(report, /Signature is Valid/);
        assert.doesNotMatch(report, /Signature is Invalid|Digest Mismatch/);
        console.log(`PASS Poppler validates ${file}`);
      }
    }
    console.log('PASS digital signing, certification lock, wrong password, tamper detection, form preservation and incremental signatures');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] === import.meta.filename) await checkDigitalSignatures();
