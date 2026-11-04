import { useEffect, useRef, useState } from 'react';
import { carryReview, inspectCarryPdf, matchingGeometry, type CarrySheet } from './carryReview';
import { readPdfBlob } from './pdfInput';
export function CarryReviewDialog({ sourceName, snapshot, onClose, onOpen }: { sourceName: string; snapshot: () => Promise<Uint8Array>; onClose: () => void; onOpen: (name: string, bytes: Uint8Array) => void }) {
  const [source, setSource] = useState<{ bytes: Uint8Array; sheets: CarrySheet[] }>();
  const [revision, setRevision] = useState<{ name: string; bytes: Uint8Array; sheets: CarrySheet[] }>();
  const [mapping, setMapping] = useState<Record<number, number>>({});
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<typeof carryReview>>>();
  const load = useRef(new AbortController()), alive = useRef(true), applying = useRef(false);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try { const bytes = await snapshot(), sheets = await inspectCarryPdf(bytes); if (alive.current) setSource({ bytes, sheets }); }
      catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not read the review.'); }
    })();
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', escape, true);
    return () => { alive.current = false; load.current.abort(); window.removeEventListener('keydown', escape, true); };
  }, []);
  const pairs = Object.entries(mapping).filter(([, to]) => to >= 0).map(([from, to]) => ({ from: Number(from), to }));
  const duplicate = new Set(pairs.map(p => p.to)).size !== pairs.length;
  const count = pairs.reduce((sum, p) => sum + (source?.sheets[p.from].count ?? 0), 0);
  return <div className="compare-backdrop"><section className="compare-dialog carry-dialog" role="dialog" aria-modal="true" aria-label="Carry comments forward">
    <header><h2>Carry comments forward</h2><button onClick={onClose}>Close transfer</button></header>
    <p>Choose a revised PDF and match its sheets to {sourceName}. This creates a new reviewed copy. Comments, replies, statuses, locks, and review layers travel with the marks.</p>
    <p>Check the drawings in Compare revisions first. Matching page sizes do not guarantee matching drawing positions. Changed size, crop, rotation, or page units require alignment and are blocked here.</p>
    <label>Revised drawing <input aria-label="Revised drawing" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      load.current.abort(); load.current = new AbortController(); const signal = load.current.signal;
      setBusy(true); setError(''); setResult(undefined); setRevision(undefined); setMapping({}); setChecked(false);
      try {
        const bytes = await readPdfBlob(file, signal), sheets = await inspectCarryPdf(bytes);
        if (!signal.aborted) setRevision({ name: file.name, bytes, sheets });
      } catch (err) { if (!signal.aborted) setError(err instanceof Error ? err.message : 'Could not open the revised PDF.'); }
      finally { if (!signal.aborted) setBusy(false); }
    }} /></label>
    <div className="carry-sheet-list">{source?.sheets.filter(s => s.count > 0).map(sheet => <label key={sheet.page}>
      Original sheet {sheet.page + 1} · {sheet.count} mark{sheet.count === 1 ? '' : 's'}
      <select aria-label={`Destination for sheet ${sheet.page + 1}`} disabled={!revision || busy || !!result} value={mapping[sheet.page] ?? -1} onChange={e => { setMapping(m => ({ ...m, [sheet.page]: Number(e.target.value) })); setChecked(false); }}>
        <option value={-1}>Skip this sheet</option>{revision?.sheets.map(next => <option key={next.page} value={next.page} disabled={!matchingGeometry(sheet, next)}>Revised sheet {next.page + 1}{matchingGeometry(sheet, next) ? '' : ' — different page geometry'}</option>)}
      </select>
    </label>)}</div>
    {source && !source.sheets.some(s => s.count) && <p>This document has no review annotations to carry forward.</p>}
    <label><input type="checkbox" aria-label="I checked the sheet matches and drawing alignment" checked={checked} disabled={busy || !!result} onChange={e => setChecked(e.target.checked)} /> I checked the sheet matches and drawing alignment. I will verify carried measurements against the revised scale.</label>
    <p>{pairs.length} sheet pair{pairs.length === 1 ? '' : 's'} · {count} selected mark{count === 1 ? '' : 's'}. Unmatched sheets are skipped; existing revised-page comments stay in place.</p>
    <div className="review-actions"><button disabled={!source || !revision || !pairs.length || !checked || duplicate || busy || !!result} onClick={async () => {
      if (!source || !revision || applying.current) return;
      applying.current = true; setBusy(true); setError('');
      try { const next = await carryReview(source.bytes, revision.bytes, pairs, sourceName); if (alive.current) setResult(next); }
      catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Could not carry the review.'); }
      finally { applying.current = false; if (alive.current) setBusy(false); }
    }}>Create reviewed copy</button>{result && revision && <button onClick={() => onOpen(revision.name.replace(/\.pdf$/i, '') + '-reviewed.pdf', result.bytes)}>Open reviewed copy</button>}</div>
    <p role="status">{error || (duplicate ? 'Choose each revised sheet only once.' : busy ? 'Preparing reviewed copy…' : result ? `${result.carried} marks carried forward; ${result.duplicates} duplicates skipped. Open the copy to verify placement, then save it.` : '')}</p>
  </section></div>;
}
