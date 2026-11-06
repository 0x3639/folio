import { useEffect, useRef, useState } from 'react';
import { Modal } from './Dialogs';
import { loadPdf, type PDFDocumentProxy } from './pdf';
import type { PageViewport } from 'pdfjs-dist';

export function DigitalSignatureDialog({ pdf, name, pageNumber, signed, getBytes, onSaved, onClose }: {
  pdf: PDFDocumentProxy; name: string; pageNumber: number; signed: boolean;
  getBytes: () => Promise<Uint8Array>; onSaved: (name: string, bytes: Uint8Array) => void; onClose: () => void;
}) {
  const api = window.folioDesktop?.signing;
  const [identity, setIdentity] = useState<{ token: string; name: string } | null>(null);
  const identityRef = useRef<string | null>(null);
  const [password, setPassword] = useState(''), [certificate, setCertificate] = useState<DigitalCertificate | null>(null);
  const [reason, setReason] = useState('Reviewed and approved'), [lock, setLock] = useState(!signed), [timestamp, setTimestamp] = useState(false);
  const [visible, setVisible] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [verification, setVerification] = useState<SignatureVerification | null>(null);
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; viewport: PageViewport } | null>(null);
  const [position, setPosition] = useState<[number, number] | null>(null);
  const snapshot = useRef<Uint8Array | null>(null);
  useEffect(() => () => { if (identityRef.current) void api?.clear(identityRef.current); }, [api]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let previewPdf: PDFDocumentProxy | undefined;
    void (async () => {
      const bytes = await getBytes();
      if (cancelled) return;
      snapshot.current = bytes;
      if (api && signed) {
        const checked = await api.inspect(bytes);
        if (!cancelled) setVerification(checked);
      }
      previewPdf = await loadPdf(bytes.slice(), controller.signal);
      if (cancelled) { void previewPdf.loadingTask.destroy(); return; }
      const page = await previewPdf.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas'), scaled = page.getViewport({ scale: Math.min(1, 460 / viewport.width) });
      canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
      await page.render({ canvas, viewport: scaled }).promise;
      if (!cancelled) {
        setPreview({ url: canvas.toDataURL(), width: viewport.width, height: viewport.height, viewport });
        setPosition([Math.min(30, viewport.width / 10), Math.max(0, viewport.height - 95)]);
      }
    })().catch(() => { if (!cancelled) setError('Could not prepare this PDF for signing.'); });
    return () => { cancelled = true; controller.abort(); snapshot.current = null; void previewPdf?.loadingTask.destroy().catch(() => {}); };
  }, [pdf, pageNumber, api, signed]);
  const width = preview ? Math.min(240, preview.width) : 240, height = preview ? Math.min(65, preview.height) : 65;
  const blocked = !!verification && (verification.certified || verification.unsignedChanges || verification.signatures.some(s => !s.integrity));
  const choose = async () => {
    setBusy(true); setError(''); setCertificate(null); setPassword('');
    try { const picked = await api!.chooseIdentity(); setIdentity(picked); identityRef.current = picked?.token ?? null; }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const unlock = async () => {
    setBusy(true); setError('');
    try { setCertificate(await api!.unlock(identity!.token, password)); setPassword(''); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!api || !identity || !certificate || !preview || !position || !snapshot.current) return;
    setBusy(true); setError('');
    try {
      const a = preview.viewport.convertToPdfPoint(...position), b = preview.viewport.convertToPdfPoint(position[0] + width, position[1] + height);
      const rect = visible ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] : null;
      const result = await api.save({ identity: identity.token, bytes: snapshot.current, name, page: pageNumber - 1, rect, reason, lock, timestamp });
      if (result) { onSaved(result.name, new Uint8Array(result.bytes)); onClose(); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title="Digitally sign PDF" onClose={() => { if (!busy) onClose(); }}>
    <div className="digital-signature-dialog">
      <p>Sign with a certificate stored in a digital ID file. Save a separate signed copy after reviewing the details below.</p>
      {!api && <p role="alert">Digital signing is available in the Folio desktop app.</p>}
      {verification && <section className="digital-verification" aria-label="Existing digital signatures">
        <strong>{verification.locked ? 'Certified: no changes permitted' : 'Existing signatures'}</strong>
        {verification.signatures.map(s => <p key={s.field}>{s.name || s.field}: {s.integrity ? 'Signed revision is intact' : s.error}</p>)}
        {verification.unsignedChanges && <p>Changes were added after the last signature. Validate them in Acrobat before signing.</p>}
        <p>Certificate trust, revocation, and timestamp trust are not checked here. Validate these in Acrobat or another signature-validation viewer.</p>
      </section>}
      <fieldset disabled={!api || busy || blocked} className="digital-signature-fields">
        <section><h3>1. Choose your digital ID</h3>
          <button className="btn" onClick={() => void choose()}>Choose .p12 or .pfx file</button>
          {identity && <p>{identity.name}</p>}
          {identity && !certificate && <><label>Digital ID password<input type="password" aria-label="Digital ID password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void unlock(); }} /></label><button className="btn" onClick={() => void unlock()}>Unlock digital ID</button></>}
          {certificate && <div className="digital-certificate"><strong>{certificate.name}</strong><p>Valid until {new Date(certificate.validTo).toLocaleDateString()}</p><details><summary>Certificate details</summary><p>Issuer: {certificate.issuer}</p><p>SHA-256 fingerprint: {certificate.fingerprint}</p></details></div>}
          <p className="form-hint">Your private key and password stay on this computer and are not saved by Folio. Recipients must trust the certificate to verify your identity.</p>
          {!identity && <p className="form-hint">Use a digital ID exported from Acrobat or supplied by your certificate provider.</p>}
        </section>
        <section><h3>2. Review signing options</h3>
          <label>Reason<input aria-label="Signing reason" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <label><input type="checkbox" aria-label="Lock PDF after signing" checked={lock} disabled={signed} onChange={e => setLock(e.target.checked)} /> Lock PDF after signing</label>
          <p className="form-hint">{signed ? 'Certification locking requires an unsigned original. Add an approval signature here while preserving earlier signatures.' : lock ? 'Certifies the PDF with no changes permitted, including further signatures. Finish all edits first.' : 'Adds an approval signature. Other signers can sign later; changes to signed content are detectable.'}</p>
          <label><input type="checkbox" checked={timestamp} onChange={e => setTimestamp(e.target.checked)} /> Request a timestamp from DigiCert</label>
          <p className="form-hint">{timestamp ? 'Sends only a signature digest to timestamp.digicert.com. Signing stops if the service is unavailable.' : 'Without a timestamp service, signing time comes from this computer’s clock.'}</p>
          <label><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} /> Show a signature on page {pageNumber}</label>
        </section>
        {visible && <section><h3>3. Check the position</h3><p>Click the page to place the signature. Arrow keys adjust its position.</p>
          {preview && position && <div className="digital-signature-preview" role="button" tabIndex={0} aria-label="Digital signature placement" style={{ aspectRatio: preview.width / preview.height }}
            onClick={e => { const bounds = e.currentTarget.getBoundingClientRect(); setPosition([Math.max(0, Math.min(preview.width - width, (e.clientX - bounds.left) / bounds.width * preview.width - width / 2)), Math.max(0, Math.min(preview.height - height, (e.clientY - bounds.top) / bounds.height * preview.height - height / 2))]); }}
            onKeyDown={e => { const delta: Record<string, [number, number]> = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }; if (delta[e.key]) { e.preventDefault(); setPosition([Math.max(0, Math.min(preview.width - width, position[0] + delta[e.key][0])), Math.max(0, Math.min(preview.height - height, position[1] + delta[e.key][1]))]); } }}>
            <img src={preview.url} alt={`Page ${pageNumber}`} /><span style={{ left: position[0] / preview.width * 100 + '%', top: position[1] / preview.height * 100 + '%', width: width / preview.width * 100 + '%', height: height / preview.height * 100 + '%' }}>Digitally signed<br />{certificate?.name || 'Your certificate name'}</span>
          </div>}
        </section>}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      {blocked && <p>Folio preserves this signed PDF unchanged. Use its unsigned original to create a new certified version.</p>}
      <div className="form-actions"><button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn primary" disabled={!api || busy || blocked || !certificate || !preview || (signed && !verification)} onClick={() => void save()}>{busy ? 'Working…' : lock ? 'Sign and lock PDF' : 'Digitally sign PDF'}</button></div>
    </div>
  </Modal>;
}
