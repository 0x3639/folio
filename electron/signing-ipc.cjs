const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { readRegular, checkDiskPath } = require('./document-files.cjs');

// Private keys never enter the page, preferences, logs, or a temporary file.
exports.register = function register(handle, getWindow, dialog) {
  let identity = null, busy = false;
  const clear = () => {
    if (identity) { clearTimeout(identity.timer); identity.bytes?.fill(0); identity = null; }
  };
  const signing = () => import('./pdf-signing.mjs');
  handle('folio:signing-choose-id', async () => {
    if (busy) throw new Error('Signing is in progress.');
    clear();
    const pick = await dialog.showOpenDialog(getWindow(), { title: 'Choose digital ID', properties: ['openFile'], filters: [{ name: 'Digital ID', extensions: ['p12', 'pfx'] }] });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const bytes = await readRegular(pick.filePaths[0], 5 * 1024 * 1024);
    const token = randomUUID();
    identity = { token, bytes, signer: null, timer: setTimeout(clear, 10 * 60 * 1000) };
    identity.timer.unref();
    return { token, name: path.basename(pick.filePaths[0]) };
  });
  const current = token => {
    if (!identity || identity.token !== token) throw new Error('Choose your digital ID again; the signing session expired.');
    return identity;
  };
  handle('folio:signing-unlock', async (_event, token, password) => {
    if (busy) throw new Error('Signing is in progress.');
    const selected = current(token);
    const { signer, details } = await (await signing()).unlockCertificate(selected.bytes, password);
    if (identity !== selected) throw new Error('The signing session changed.');
    selected.signer = signer;
    return details;
  });
  handle('folio:signing-clear', (_event, token) => { if (identity?.token === token && !busy) clear(); });
  handle('folio:signing-inspect', async (_event, bytes) => (await signing()).inspectSignatures(bytes));
  handle('folio:signing-save', async (_event, request) => {
    if (busy) throw new Error('Signing is already in progress.');
    const selected = current(request?.identity);
    if (!selected.signer) throw new Error('Unlock your digital ID first.');
    busy = true;
    let temporary;
    try {
      const { bytes, verification } = await (await signing()).signPdf(request.bytes, selected.signer, request);
      const base = typeof request.name === 'string' ? path.basename(request.name).replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) : 'document';
      const destination = await dialog.showSaveDialog(getWindow(), { title: request.lock ? 'Save signed and locked PDF' : 'Save digitally signed PDF', defaultPath: `${base} (${request.lock ? 'signed and locked' : 'signed'}).pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (destination.canceled || !destination.filePath) return null;
      checkDiskPath(destination.filePath);
      temporary = path.join(path.dirname(destination.filePath), `.folio-sign-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, destination.filePath);
      temporary = null;
      clear();
      return { name: path.basename(destination.filePath), bytes, verification };
    } finally {
      if (temporary) await fs.unlink(temporary).catch(() => {});
      busy = false;
    }
  });
  getWindow()?.once('closed', clear);
};
