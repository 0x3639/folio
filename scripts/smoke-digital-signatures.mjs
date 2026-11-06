import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { makeIdentity } from './test-digital-signatures.mjs';
import { inspectSignatures } from '../electron/pdf-signing.mjs';

export async function checkDigitalSigning(app, page, output) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'folio-signing-ui-'));
  const file = path.join(output, 'digitally-signed-ui.pdf');
  try {
    const p12 = makeIdentity(temporary), source = await PDFDocument.create();
    source.addPage([700, 700]).drawText('Drawing ready for approval', { x: 50, y: 630 });
    const field = source.getForm().createTextField('Project'); field.setText('Project 42'); field.addToPage(source.getPage(0), { x: 50, y: 580, width: 200, height: 25 });
    await app.evaluate(({ BrowserWindow, dialog }, { bytes, p12, file }) => {
      globalThis.signingOldOpen = dialog.showOpenDialog; globalThis.signingOldSave = dialog.showSaveDialog;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p12] });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      BrowserWindow.getAllWindows()[0].webContents.send('folio:open-file', { name: 'digital-signing.pdf', data: Buffer.from(bytes) });
    }, { bytes: Array.from(await source.save()), p12, file });
    await page.getByRole('tab', { name: 'digital-signing.pdf', selected: true, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Markup', exact: true }).click();
    const tools = page.getByRole('complementary', { name: 'Drawing tools' });
    await tools.getByRole('button', { name: 'Comment', exact: true }).click();
    const overlay = await page.locator('.review-overlay.review-active').first().boundingBox();
    await page.mouse.click(overlay.x + overlay.width * .6, overlay.y + overlay.height * .4);
    const composer = page.getByRole('form', { name: 'Comment editor' });
    await composer.getByLabel('Comment', { exact: true }).fill('Approved beam clearance');
    await composer.getByRole('button', { name: 'Add comment', exact: true }).click();
    await tools.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByRole('button', { name: 'Digitally sign or lock PDF', exact: true }).click();
    const signing = page.getByRole('dialog', { name: 'Digitally sign PDF', exact: true });
    await signing.getByRole('button', { name: 'Choose .p12 or .pfx file', exact: true }).click();
    await signing.getByLabel('Digital ID password').fill('incorrect');
    await signing.getByRole('button', { name: 'Unlock digital ID', exact: true }).click();
    await signing.getByRole('alert').filter({ hasText: 'Could not unlock' }).waitFor();
    await signing.getByLabel('Digital ID password').fill('folio-test-only');
    await signing.getByRole('button', { name: 'Unlock digital ID', exact: true }).click();
    await signing.getByText('Folio Test Reviewer', { exact: true }).waitFor();
    await signing.getByRole('button', { name: 'Digital signature placement', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'digital-sign-dialog.png') });
    await signing.getByRole('button', { name: 'Sign and lock PDF', exact: true }).click();
    await page.getByRole('tab', { name: 'digitally-signed-ui.pdf', selected: true, exact: true }).waitFor();
    await page.locator('.signed-document-banner').waitFor();
    await page.locator('.textLayer span:not(.markedContent)').first().waitFor();
    const bytes = readFileSync(file), verified = await inspectSignatures(bytes);
    assert.equal(verified.locked, true); assert.equal(verified.signatures[0].integrity, true);
    const parsed = await PDFDocument.load(bytes);
    assert.ok(parsed.getPage(0).node.Annots().asArray().some(ref => parsed.context.lookup(ref).lookup(PDFName.of('Contents'))?.decodeText().includes('Approved beam clearance')), 'unsaved review comment is included in the signed revision');
    assert.equal(await page.locator('.annotationLayer input:not([disabled])').count(), 0, 'signed form fields cannot be changed');
    await page.getByRole('button', { name: 'Draw', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Draw', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: 'Signature details', exact: true }).click();
    await signing.getByText('Certified: no changes permitted', { exact: true }).waitFor();
    await signing.getByText(/Signed revision is intact/).waitFor();
    assert.equal(await signing.getByRole('button', { name: 'Digitally sign PDF', exact: true }).isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'digital-sign-verified.png') });
    await signing.getByRole('button', { name: 'Cancel', exact: true }).click();
    const saved = path.join(output, 'digital-signed-copy.pdf');
    await app.evaluate(({ session }, saved) => { globalThis.signingCopy = new Promise(resolve => session.defaultSession.once('will-download', (_e, item) => { item.setSavePath(saved); item.once('done', (_event, result) => resolve(result)); })); }, saved);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    assert.equal(await app.evaluate(() => globalThis.signingCopy), 'completed');
    assert.ok(bytes.equals(readFileSync(saved)), 'saving a signed PDF preserves every byte');
    console.log('PASS digital signing UI, password retry, unsaved markup inclusion, certificate details, locked form/editor protection and byte-identical save');
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.signingOldOpen; dialog.showSaveDialog = globalThis.signingOldSave; });
    rmSync(temporary, { recursive: true, force: true });
  }
}
