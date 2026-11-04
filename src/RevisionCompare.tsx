import { useEffect, useRef, useState } from 'react';
import { loadPdf, type PDFDocumentProxy } from './pdf';
import { readPdfBlob } from './pdfInput';
import type { Point } from './measurements';
import { alignRevision } from './drawingGeometry';
export function RevisionCompare({ snapshot, initialPage, onClose }: { snapshot: () => Promise<Uint8Array>; initialPage: number; onClose: () => void }) {
  const [base, setBase] = useState<PDFDocumentProxy | null>(null), [revision, setRevision] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('Choose a revised PDF');
  const [leftPage, setLeftPage] = useState(initialPage), [rightPage, setRightPage] = useState(1);
  const [mode, setMode] = useState('Side by side');
  const [images, setImages] = useState<{ left: string; right: string; red: string; blue: string; width: number; height: number; rightWidth: number; rightHeight: number } | null>(null);
  const [transform, setTransform] = useState([1, 0, 0, 1, 0, 0]);
  const [view, setView] = useState({ zoom: .55, x: 0, y: 0 });
  const [aligning, setAligning] = useState(false), [references, setReferences] = useState<{ left: Point[]; right: Point[] }>({ left: [], right: [] });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const documents = useRef<PDFDocumentProxy[]>([]), load = useRef(new AbortController());
  const drag = useRef<{ x: number; y: number; start: typeof view } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try { const pdf = await loadPdf(await snapshot(), abort.signal); documents.current.push(pdf); if (!abort.signal.aborted) setBase(pdf); }
      catch (e) { if (!abort.signal.aborted) setError(String(e)); }
    })();
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); } };
    window.addEventListener('keydown', escape, true);
    return () => { abort.abort(); load.current.abort(); documents.current.forEach(p => { void p.loadingTask.destroy(); }); window.removeEventListener('keydown', escape, true); };
  }, []);
  useEffect(() => {
    setTransform([1, 0, 0, 1, 0, 0]); setReferences({ left: [], right: [] }); setAligning(false);
  }, [leftPage, rightPage, revision]);
  useEffect(() => {
    if (!base || !revision) return;
    let cancelled = false;
    const tasks: { cancel: () => void }[] = [];
    setBusy(true); setError('');
    void (async () => {
      const old = await base.getPage(leftPage), next = await revision.getPage(rightPage);
      const dimensions = old.getViewport({ scale: 1 });
      const factor = Math.min(2, 1600 / Math.max(dimensions.width, dimensions.height));
      const render = async (page: typeof old) => {
        const viewport = page.getViewport({ scale: factor });
        if (viewport.width * viewport.height > 16000000) throw new Error('This sheet is too large for comparison. Choose a smaller sheet.');
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const task = page.render({ canvas, viewport }); tasks.push(task); if (cancelled) task.cancel();
        await task.promise; return canvas;
      };
      const left = await render(old), right = await render(next);
      const tint = (canvas: HTMLCanvasElement, red: boolean) => {
        const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
        const ctx = output.getContext('2d')!; ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, output.width, output.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const darkness = 255 - (pixels.data[i] * .299 + pixels.data[i + 1] * .587 + pixels.data[i + 2] * .114);
          pixels.data[i] = red ? 220 : 0; pixels.data[i + 1] = red ? 40 : 135; pixels.data[i + 2] = red ? 40 : 220; pixels.data[i + 3] = darkness;
        }
        ctx.putImageData(pixels, 0, 0); return output.toDataURL();
      };
      if (!cancelled) setImages({ left: left.toDataURL(), right: right.toDataURL(), red: tint(left, true), blue: tint(right, false), width: left.width, height: left.height, rightWidth: right.width, rightHeight: right.height });
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not render the comparison.'); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; tasks.forEach(t => t.cancel()); };
  }, [base, revision, leftPage, rightPage]);
  const pane = (side: 'left' | 'right' | 'overlay') => <div className="compare-pane" aria-label={side === 'left' ? 'Original drawing' : side === 'right' ? 'Revised drawing' : 'Drawing overlay'}
    onWheel={e => { e.preventDefault(); setView(v => ({ ...v, zoom: Math.max(.1, Math.min(6, v.zoom * Math.exp(-e.deltaY / 500))) })); }}
    onPointerDown={e => {
      if (e.button !== 0) return;
      if (aligning && side !== 'overlay') {
        const box = e.currentTarget.getBoundingClientRect();
        const point: Point = [(e.clientX - box.left - view.x) / view.zoom, (e.clientY - box.top - view.y) / view.zoom];
        if (side === 'left' && references.left.length < 2) setReferences(r => ({ ...r, left: [...r.left, point] }));
        else if (side === 'right' && references.left.length === 2 && references.right.length < 2) {
          const right = [...references.right, point]; setReferences(r => ({ ...r, right }));
          if (right.length === 2) { try { setTransform(alignRevision(references.left, right)); setAligning(false); setMode('Overlay'); } catch (e) { setError((e as Error).message); setReferences({ left: [], right: [] }); } }
        }
        return;
      }
      drag.current = { x: e.clientX, y: e.clientY, start: view }; e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={e => { if (drag.current) setView({ ...drag.current.start, x: drag.current.start.x + e.clientX - drag.current.x, y: drag.current.start.y + e.clientY - drag.current.y }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    {images && <div className="compare-image-space" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, width: images.width, height: images.height }}>
      {side !== 'right' && <img draggable={false} src={side === 'overlay' ? images.red : images.left} alt="Original sheet" width={images.width} height={images.height} />}
      {side !== 'left' && <img draggable={false} src={side === 'overlay' ? images.blue : images.right} alt="Revised sheet" style={{ transform: `matrix(${transform.join(',')})`, mixBlendMode: side === 'overlay' ? 'multiply' : undefined }} width={images.rightWidth} height={images.rightHeight} />}
      {aligning && side !== 'overlay' && references[side].map(([x, y], i) => <span key={i} className="compare-reference" style={{ left: x, top: y }}>{i + 1}</span>)}
    </div>}
  </div>;
  return <div className="compare-backdrop"><section className="compare-dialog" role="dialog" aria-modal="true" aria-label="Compare revisions">
    <header><h2>Compare revisions</h2><button onClick={onClose}>Close comparison</button></header>
    <div className="compare-controls"><label>Revised PDF <input aria-label="Revised PDF" type="file" accept="application/pdf,.pdf" onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      load.current.abort(); load.current = new AbortController(); const signal = load.current.signal;
      setError(''); setBusy(true);
      try { const pdf = await loadPdf(await readPdfBlob(file, signal), signal); documents.current.push(pdf); if (signal.aborted) return; setRevision(pdf); setFileName(file.name); setRightPage(1); setImages(null); }
      catch (err) { if (!signal.aborted) setError(err instanceof Error ? err.message : 'Could not open the revision.'); } finally { if (!signal.aborted) setBusy(false); }
    }} /></label><span>{fileName}</span>
      <label>Original sheet <input aria-label="Original sheet" type="number" min="1" max={base?.numPages || 1} value={leftPage} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n > 0 && n <= (base?.numPages || 1)) setLeftPage(n); }} /></label>
      <label>Revised sheet <input aria-label="Revised sheet" type="number" min="1" max={revision?.numPages || 1} value={rightPage} onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n > 0 && n <= (revision?.numPages || 1)) setRightPage(n); }} /></label>
      <label>Comparison view <select aria-label="Comparison view" value={mode} onChange={e => setMode(e.target.value)}><option>Side by side</option><option>Overlay</option></select></label>
      <button disabled={!images} onClick={() => { setTransform([1, 0, 0, 1, 0, 0]); setMode('Side by side'); setReferences({ left: [], right: [] }); setAligning(true); }}>Align two points</button>
      <button onClick={() => { setView({ zoom: .55, x: 0, y: 0 }); setTransform([1, 0, 0, 1, 0, 0]); setAligning(false); }}>Reset view</button>
      <label>Zoom <input aria-label="Zoom" type="range" min="0.1" max="3" step="0.05" value={view.zoom} onChange={e => setView(v => ({ ...v, zoom: Number(e.target.value) }))} /></label>
    </div>
    <p role="status">{error || (busy ? 'Rendering sheets…' : aligning ? references.left.length < 2 ? 'Click two matching reference points on the original sheet.' : 'Click the same two points, in the same order, on the revised sheet.' : 'Drag to pan; zoom stays synchronized. Overlay: original is red, revised is blue; matching lines overlap. Compare matching sheet numbers and verify alignment.')}</p>
    <div className="compare-panes">{mode === 'Overlay' ? pane('overlay') : <>{pane('left')}{pane('right')}</>}</div>
  </section></div>;
}
