import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EventBus, PDFViewer } from './viewer';
import type { MarkupController, MarkupState } from './markup';
import { emptyDrawing, measurementLabel, isSimpleOutline, type Point } from './measurements';
import { bounds, defaultStyle, markVisible, metaFor, movePoints, readToolPresets, reviewGeometry, reviewKinds, reviewRows, starterTools, type ReviewKind, type ReviewMark, type ReviewMeta, type ReviewStyle } from './reviewModel';
import { usePageOverlays } from './pageOverlays';
import { drawingEndpoints, snapPoint } from './drawingSnap';
import { keys } from './platform';
interface Props { viewer: PDFViewer; bus: EventBus; state: MarkupState; controller: MarkupController; active: boolean; onClose: () => void; onExport: (format: 'csv' | 'pdf') => void; onCompare: () => void; onCarry: () => void; onFlatten: () => void }
export function ReviewWorkspace({ viewer, bus, state, controller, active, onClose, onExport, onCompare, onCarry, onFlatten }: Props) {
  const data = state.drawing ?? emptyDrawing(), review = data.review ?? [], rows = reviewRows(data, [...state.marks, ...(state.pdfMarks ?? [])], measurementLabel);
  const overlays = usePageOverlays(viewer, bus);
  const [tool, setTool] = useState<ReviewKind | 'Select'>('Select');
  const [style, setStyle] = useState<ReviewStyle>({ ...defaultStyle });
  const [note, setNote] = useState('');
  const [author, setAuthor] = useState(() => { try { return localStorage.getItem('folio:review-author') || ''; } catch { return ''; } });
  const [discipline, setDiscipline] = useState('');
  const [layerName, setLayerName] = useState(''), [activeLayer, setActiveLayer] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState<{ page: number; points: Point[] } | null>(null);
  const [filter, setFilter] = useState(''), [status, setStatus] = useState('All'), [disciplineFilter, setDisciplineFilter] = useState('All');
  const [reply, setReply] = useState(''), [message, setMessage] = useState('');
  const [snap, setSnap] = useState(true);
  const [tools, setTools] = useState(readToolPresets);
  const [armedPreset, setArmedPreset] = useState<import('./reviewModel').ToolPreset | null>(null);
  const [presetName, setPresetName] = useState('');
  const [vertex, setVertex] = useState(0);
  const [dx, setDx] = useState(0), [dy, setDy] = useState(0);
  const endpoints = useRef(new Map<number, Point[]>());
  const gesture = useRef<{ page: number; start: Point; original: typeof data; ids: string[]; vertex?: number; moved: boolean } | null>(null);
  const [preview, setPreview] = useState<typeof data | null>(null);
  const currentData = preview ?? data;
  const chosen = rows.filter(r => selected.includes(r.id));
  const first = review.find(m => m.id === selected[0]);
  const measure = data.measurements.find(m => m.id === selected[0]);
  const selectedPoints = first?.points ?? measure?.points;
  const external = chosen.some(r => r.source === 'pdf');
  const locked = chosen.some(r => r.meta.locked);
  const page = viewer.currentPageNumber - 1;
  useEffect(() => {
    if (!active || !viewer.pdfDocument) return;
    void controller.loadPdfMarks(viewer.pdfDocument).catch(() => setMessage('Some PDF annotations could not be listed.'));
    void drawingEndpoints(viewer.pdfDocument, page).then(points => endpoints.current.set(page, points));
  }, [active, viewer, page]);
  useEffect(() => { setDraft(null); setPreview(null); gesture.current = null; }, [tool, active]);
  useEffect(() => { setVertex(0); }, [selected.join(',')]);
  const change = (next: typeof data) => controller.setDrawing(next);
  const metadata = (patch: Partial<ReviewMeta>) => {
    change({ ...data, reviewMeta: { ...data.reviewMeta, ...Object.fromEntries(selected.map(id => [id, { ...metaFor(data, id), ...patch }])) } });
  };
  const applyStyle = (patch: Partial<ReviewStyle>) => {
    setStyle(s => ({ ...s, ...patch }));
    if (!selected.length || locked) return;
    change({ ...data, review: review.map(m => selected.includes(m.id) ? { ...m, style: { ...m.style, ...patch } } : m) });
    chosen.filter(r => r.source === 'annotation').forEach(r => { void controller.styleMark(r.id, patch); });
  };
  const select = (id: string, additive = false) => {
    const group = metaFor(data, id).group;
    const ids = group ? rows.filter(r => r.meta.group === group).map(r => r.id) : [id];
    setSelected(additive ? selected.includes(id) ? selected.filter(v => !ids.includes(v)) : [...new Set([...selected, ...ids])] : ids);
    const mark = review.find(m => m.id === id);
    if (mark) { setStyle(mark.style); setNote(mark.text); }
  };
  const move = (source: typeof data, ids: string[], x: number, y: number) => ({ ...source,
    review: (source.review ?? []).map(m => ids.includes(m.id) && !metaFor(source, m.id).locked ? { ...m, points: movePoints(m.points, x, y) } : m),
    measurements: source.measurements.map(m => ids.includes(m.id) && !metaFor(source, m.id).locked ? { ...m, points: movePoints(m.points, x, y) } : m) });
  const editVertex = (source: typeof data, id: string, index: number, point: Point) => ({ ...source,
    review: (source.review ?? []).map(m => m.id === id ? { ...m, points: m.points.map((p, i) => i === index ? point : p) } : m),
    measurements: source.measurements.map(m => m.id === id ? { ...m, points: m.points.map((p, i) => i === index ? point : p) } : m) });
  const validGeometry = (next: typeof data) => next.measurements.every(m => !['Area', 'Perimeter'].includes(m.kind) || isSimpleOutline(m.points));
  const commitGeometry = (next: typeof data) => { if (validGeometry(next)) change(next); else setMessage('That edit crosses an outline. The previous points were kept.'); };
  const remove = () => {
    if (external) { setMessage("Original PDF annotations stay in the source file. Review their status or add a linked comment."); return; }
    if (locked) { setMessage('Unlock the selected marks before deleting.'); return; }
    chosen.filter(r => r.source === 'annotation').forEach(r => controller.remove(r.id));
    change({ ...data, review: review.filter(m => !selected.includes(m.id)), measurements: data.measurements.filter(m => !selected.includes(m.id)) }); setSelected([]);
  };
  const duplicate = () => {
    if (locked || external) return;
    const ids = new Map(selected.map(id => [id, crypto.randomUUID()]));
    const groups = new Map<string, string>();
    const reviewMeta = { ...data.reviewMeta };
    for (const [id, copy] of ids) { const meta = metaFor(data, id); if (meta.group && !groups.has(meta.group)) groups.set(meta.group, crypto.randomUUID()); reviewMeta[copy] = { ...meta, group: meta.group ? groups.get(meta.group) : undefined }; }
    change({ ...data, reviewMeta, review: [...review, ...review.filter(m => ids.has(m.id)).map(m => ({ ...m, id: ids.get(m.id)!, points: movePoints(m.points, 12, -12), createdAt: Date.now() }))],
      measurements: [...data.measurements, ...data.measurements.filter(m => ids.has(m.id)).map(m => ({ ...m, id: ids.get(m.id)!, points: movePoints(m.points, 12, -12) }))] });
    chosen.filter(r => r.source === 'annotation').forEach(r => { void controller.moveMark(r.id, 12, -12, true); });
    setSelected([...ids.values()]);
  };
  const finish = (pending = draft) => {
    if (!pending || tool === 'Select') return;
    if (tool === 'Polygon' && (pending.points.length < 3 || !isSimpleOutline(pending.points))) { setMessage('Use at least three corners with no crossing edges.'); return; }
    if (['Callout', 'Cloud callout', 'Text', 'Stamp'].includes(tool) && !note.trim()) { setMessage('Enter the note or stamp text first.'); return; }
    const points = pending.points;
    if (tool === 'Callout' && points.length === 2) points.splice(1, 0, [points[1][0] - 15, points[1][1] - 8]);
    const id = crypto.randomUUID();
    const mark: ReviewMark = { id, page: pending.page, kind: tool, points, text: note, style: { ...style }, createdAt: Date.now() };
    change({ ...data, review: [...review, mark], reviewMeta: { ...data.reviewMeta, [id]: { ...metaFor(data, id), author, discipline, layer: activeLayer || undefined } } });
    setDraft(null); setSelected([id]); setMessage(`${tool} added.`);
  };
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
      if (e.key === 'Escape') { setDraft(null); setPreview(null); gesture.current = null; setSelected([]); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); remove(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); controller.undoDrawing(e.shiftKey); }
      else if (e.key === 'Enter' && tool === 'Polygon') { e.preventDefault(); finish(); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  const filtered = rows.filter(r => (status === 'All' || r.meta.status === status || status === 'Unresolved' && r.meta.status !== 'Resolved') && (disciplineFilter === 'All' || r.meta.discipline === disciplineFilter) && `${r.text} ${r.kind} ${r.meta.author} ${r.meta.subject} ${r.page + 1}`.toLowerCase().includes(filter.toLowerCase()));
  return <>
    {overlays.map(({ index, host, viewport, style: position }) => {
      const screen = (p: Point) => viewport.convertToViewportPoint(...p) as Point;
      const pointer = (e: React.PointerEvent<SVGSVGElement>): Point => {
        const box = e.currentTarget.getBoundingClientRect();
        const raw = viewport.convertToPdfPoint((e.clientX - box.left) / box.width * viewport.width, (e.clientY - box.top) / box.height * viewport.height) as Point;
        const candidates = snap ? [...(endpoints.current.get(index) ?? []), ...review.filter(m => m.page === index && markVisible(data, m.id) && !selected.includes(m.id)).flatMap(m => m.points), ...data.measurements.filter(m => m.page === index && markVisible(data, m.id) && !selected.includes(m.id)).flatMap(m => m.points)] : [];
        return snapPoint(raw, candidates, 8 / viewport.scale, draft?.points.at(-1), e.shiftKey).point;
      };
      const paintMark = (mark: ReviewMark, pending = false) => {
        const geometry = reviewGeometry(mark), s = mark.style;
        const screenBounds = bounds([screen([geometry.rect[0], geometry.rect[1]]), screen([geometry.rect[2], geometry.rect[3]])]);
        return <g key={mark.id} data-review-id={mark.id} opacity={pending ? .55 : s.opacity} className={selected.includes(mark.id) ? 'review-selected' : ''}>
          {geometry.paths.map((path, i) => {
            const p = path.points.map(screen); const d = p.map((p, j) => `${j ? 'L' : 'M'} ${p.join(' ')}`).join(' ') + (path.closed ? ' Z' : '');
            return <path key={i} d={d} fill={path.fill || 'none'} stroke={s.color} strokeWidth={s.width * viewport.scale} strokeDasharray={s.dash === 'solid' ? undefined : (s.dash === 'dashed' ? [6, 3] : [1, 3]).map(n => n * viewport.scale).join(' ')} />;
          })}
          {geometry.lines.map((line, i) => { const [x, y] = screen(line.point); return <text key={i} x={x} y={y} fill={s.color} transform={`rotate(${viewport.rotation}, ${x}, ${y})`} fontSize={s.fontSize * viewport.scale} fontFamily={s.font === 'serif' ? 'serif' : s.font === 'mono' ? 'monospace' : 'Arial, sans-serif'}>{line.text}</text>; })}
          {active && selected.includes(mark.id) && <rect className="review-selection-box" x={screenBounds[0]} y={screenBounds[1]} width={screenBounds[2] - screenBounds[0]} height={screenBounds[3] - screenBounds[1]} />}
        </g>;
      };
      return createPortal(<svg className={`review-overlay ${active ? 'review-active' : ''}`} style={position} viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-label={`Review marks on page ${index + 1}`}
        onClick={e => { if (active) e.stopPropagation(); }}
        onPointerDown={e => {
          if (!active || e.button !== 0 || !e.isPrimary) return;
          e.preventDefault(); e.stopPropagation();
          const point = pointer(e);
          if (tool !== 'Select') {
            if (armedPreset?.points) { finish({ page: index, points: movePoints(armedPreset.points, point[0], point[1]) }); return; }
            const next = { page: index, points: [...(draft?.page === index ? draft.points : []), point] };
            setDraft(next);
            if (tool !== 'Polygon' && next.points.length === (tool === 'Cloud callout' ? 3 : 2)) finish(next);
            return;
          }
          const target = (e.target as Element).closest('[data-review-id]');
          const id = target?.getAttribute('data-review-id');
          if (!id) { setSelected([]); return; }
          const vertexAttr = (e.target as Element).getAttribute('data-vertex');
          const group = metaFor(data, id).group;
          const ids = selected.includes(id) ? selected : group ? rows.filter(r => r.meta.group === group).map(r => r.id) : [id];
          select(id, e.shiftKey);
          if (ids.some(id => metaFor(data, id).locked) || e.shiftKey) return;
          gesture.current = { page: index, start: point, original: data, ids, vertex: vertexAttr === null ? undefined : Number(vertexAttr), moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => {
          const g = gesture.current; if (!g || g.page !== index) return;
          const point = pointer(e), x = point[0] - g.start[0], y = point[1] - g.start[1];
          g.moved = g.moved || Math.hypot(x, y) > .1;
          setPreview(g.vertex === undefined ? move(g.original, g.ids, x, y) : editVertex(g.original, g.ids[0], g.vertex, point));
        }}
        onPointerUp={e => {
          const g = gesture.current; if (!g) return;
          const point = pointer(e), x = point[0] - g.start[0], y = point[1] - g.start[1];
          if (g.moved) {
            commitGeometry(g.vertex === undefined ? move(g.original, g.ids, x, y) : editVertex(g.original, g.ids[0], g.vertex, point));
            if (g.vertex === undefined) rows.filter(r => g.ids.includes(r.id) && r.source === 'annotation').forEach(r => { void controller.moveMark(r.id, x, y); });
          }
          gesture.current = null; setPreview(null); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }} onPointerCancel={() => { gesture.current = null; setPreview(null); }} onLostPointerCapture={() => { gesture.current = null; setPreview(null); }}>
        {(currentData.review ?? []).filter(m => m.page === index && markVisible(currentData, m.id)).map(m => paintMark(m))}
        {active && currentData.measurements.filter(m => m.page === index && markVisible(currentData, m.id)).map(m => <g key={m.id} data-review-id={m.id}><polyline points={m.points.map(screen).map(p => p.join(',')).join(' ')} fill="none" stroke="transparent" strokeWidth={14} /><text x={screen(m.points[0])[0]} y={screen(m.points[0])[1]} fill="transparent" fontSize={14}>{measurementLabel(m)}</text></g>)}
        {active && selected.length === 1 && !locked && markVisible(currentData, selected[0]) && (currentData.review?.find(m => m.id === selected[0]) ?? currentData.measurements.find(m => m.id === selected[0]))?.points.map((p, i) => { const [cx, cy] = screen(p); return <circle key={i} data-review-id={selected[0]} data-vertex={i} cx={cx} cy={cy} r={5} className="review-vertex" />; })}
        {active && draft?.page === index && draft.points.length >= 2 && tool !== 'Select' && paintMark({ id: 'draft', page: index, points: draft.points, kind: tool, text: note, style, createdAt: 0 }, true)}
        {active && draft?.page === index && draft.points.map((p, i) => { const [cx, cy] = screen(p); return <circle key={i} cx={cx} cy={cy} r={4} fill={style.color} />; })}
      </svg>, host, String(index));
    })}
    {active && <aside className="review-panel" aria-label="Drawing review">
      <header><strong>Drawing review</strong><button onClick={onClose}>Done</button></header>
      <div className="review-actions"><button onClick={() => controller.undoDrawing()} title={keys('Undo review edit (Ctrl+Z)')}>Undo</button><button onClick={() => controller.undoDrawing(true)}>Redo</button><button onClick={onCompare}>Compare revisions</button><button onClick={onCarry}>Carry comments forward…</button></div>
      <label>Review tool <select aria-label="Review tool" value={tool} onChange={e => { setTool(e.target.value as typeof tool); setArmedPreset(null); setSelected([]); setMessage(''); }}><option>Select</option>{reviewKinds.map(k => <option key={k}>{k}</option>)}</select></label>
      <p className="review-hint">{armedPreset?.points && tool !== 'Select' ? `Click once to place ${armedPreset.name}.` : tool === 'Select' ? 'Select a mark to edit. Shift-click for multiple marks. Drag handles to adjust points.' : tool === 'Cloud callout' ? 'Click opposite cloud corners, then the note location. The cloud and note move together.' : tool === 'Callout' ? 'Click the arrow tip, then the note location.' : tool === 'Polygon' ? 'Click corners, then Finish. Hold Shift for 45° angles.' : 'Click two opposite corners or endpoints. Hold Shift for 45° angles.'}</p>
      {tool !== 'Select' && <div className="review-actions"><button disabled={!draft} onClick={() => setDraft(draft && draft.points.length > 1 ? { ...draft, points: draft.points.slice(0, -1) } : null)}>Undo point</button><button disabled={!draft} onClick={() => setDraft(null)}>Cancel drawing</button>{tool === 'Polygon' && <button onClick={() => finish()}>Finish</button>}</div>}
      <label>Note or stamp text <textarea aria-label="Note or stamp text" value={note} maxLength={10000} onChange={e => { setNote(e.target.value); if (first && !locked) change({ ...data, review: review.map(m => m.id === first.id ? { ...m, text: e.target.value } : m) }); }} /></label>
      <div className="review-fields"><label>Author <input aria-label="Author" value={author} onChange={e => { setAuthor(e.target.value); try { localStorage.setItem('folio:review-author', e.target.value); } catch { /* Optional preference. */ } }} /></label><label>Discipline <input aria-label="Discipline" value={discipline} onChange={e => setDiscipline(e.target.value)} placeholder="Architectural" /></label></div>
      <label><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} /> Snap to vector endpoints</label>
      <details open><summary>Markup layers</summary>
        <div className="review-fields"><label>New layer <input aria-label="New layer" maxLength={80} value={layerName} onChange={e => setLayerName(e.target.value)} /></label><button disabled={!layerName.trim() || (data.layers?.length ?? 0) >= 100} onClick={() => {
          const id = crypto.randomUUID(); change({ ...data, layers: [...(data.layers ?? []), { id, name: layerName.trim(), visible: true }] }); setActiveLayer(id); setLayerName('');
        }}>Add layer</button></div>
        <label>Layer for new marks <select aria-label="Layer for new marks" value={activeLayer} onChange={e => setActiveLayer(e.target.value)}><option value="">Unassigned</option>{(data.layers ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        {(data.layers ?? []).map(layer => <div className="review-fields" key={layer.id}>
          <label><input type="checkbox" aria-label={`Show layer ${layer.name}`} checked={layer.visible} onChange={e => { change({ ...data, layers: data.layers?.map(l => l.id === layer.id ? { ...l, visible: e.target.checked } : l) }); setSelected([]); }} /> Show</label>
          <input aria-label={`Layer name ${layer.name}`} maxLength={80} value={layer.name} onChange={e => { if (e.target.value.trim()) change({ ...data, layers: data.layers?.map(l => l.id === layer.id ? { ...l, name: e.target.value } : l) }); }} />
        </div>)}
        <p className="review-hint">Hidden layers stay editable in Folio and are omitted from flattened copies. Show a layer here before sharing its visible marks. Assign measurements using the markup list.</p>
      </details>
      <details open><summary>Properties</summary><fieldset disabled={locked || external}>
        <div className="review-fields"><label>Stroke <input aria-label="Stroke" type="color" value={style.color} onChange={e => applyStyle({ color: e.target.value })} /></label><label>Fill <input aria-label="Fill" type="color" value={style.fill === 'none' ? '#ffffff' : style.fill} onChange={e => applyStyle({ fill: e.target.value })} /></label><button onClick={() => applyStyle({ fill: 'none' })}>No fill</button></div>
        <div className="review-fields"><label>Line weight <input aria-label="Line weight" type="number" min="0.1" max="20" step="0.5" value={style.width} onChange={e => { const width = Number(e.target.value); if (width >= .1 && width <= 20) applyStyle({ width }); }} /></label><label>Line style <select aria-label="Line style" value={style.dash} onChange={e => applyStyle({ dash: e.target.value as ReviewStyle['dash'] })}>{['solid', 'dashed', 'dotted'].map(v => <option key={v}>{v}</option>)}</select></label><label>Opacity <input aria-label="Opacity" type="range" min="0.05" max="1" step="0.05" value={style.opacity} onChange={e => applyStyle({ opacity: Number(e.target.value) })} /></label></div>
        <div className="review-fields"><label>Font <select aria-label="Font" value={style.font} onChange={e => applyStyle({ font: e.target.value as ReviewStyle['font'] })}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label><label>Text size <input aria-label="Text size" type="number" min="6" max="96" value={style.fontSize} onChange={e => { const fontSize = Number(e.target.value); if (fontSize >= 6 && fontSize <= 96) applyStyle({ fontSize }); }} /></label></div>
        <label><input type="checkbox" checked={style.arrow} onChange={e => applyStyle({ arrow: e.target.checked })} /> Arrowhead</label>
      </fieldset></details>
      {chosen.length > 0 && <details open><summary>{chosen.length} selected</summary>{external && <p>Original PDF annotation: status, subject, replies, and reviewer fields can be tracked here. Use a new callout to propose a change to its content.</p>}
        <div className="review-actions"><button disabled={locked || external} onClick={duplicate}>Duplicate</button><button disabled={locked || external || selected.length < 2 || new Set(chosen.map(r => r.page)).size > 1} onClick={() => metadata({ group: crypto.randomUUID() })}>Group</button><button disabled={locked || external} onClick={() => metadata({ group: undefined })}>Ungroup</button><button onClick={() => metadata({ locked: !locked })}>{locked ? 'Unlock' : 'Lock'}</button><button disabled={locked || external} onClick={remove}>Delete</button></div>
        <label>Selected layer <select aria-label="Selected layer" disabled={external || locked} value={chosen[0].meta.layer ?? ''} onChange={e => metadata({ layer: e.target.value || undefined })}><option value="">Unassigned</option>{(data.layers ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        {chosen[0].meta.carriedFrom && <p>Carried from {chosen[0].meta.carriedFrom.document}, sheet {chosen[0].meta.carriedFrom.page + 1}. Check placement and any measurement scale against this revision.</p>}
        <label>Subject <input aria-label="Subject" value={chosen[0].meta.subject} onChange={e => metadata({ subject: e.target.value })} /></label>
        <label>Review status <select aria-label="Review status" value={chosen[0].meta.status} onChange={e => metadata({ status: e.target.value as ReviewMeta['status'] })}>{['Open', 'Answered', 'Resolved'].map(v => <option key={v}>{v}</option>)}</select></label>
        <button onClick={() => metadata({ author, discipline })}>Apply author and discipline</button>
        <div className="review-fields"><label>Move X (PDF points) <input aria-label="Move X (PDF points)" type="number" value={dx} onChange={e => setDx(Number(e.target.value))} /></label><label>Move Y (PDF points) <input aria-label="Move Y (PDF points)" type="number" value={dy} onChange={e => setDy(Number(e.target.value))} /></label><button disabled={locked || external || !Number.isFinite(dx + dy)} onClick={() => { change(move(data, selected, dx, dy)); chosen.filter(r => r.source === 'annotation').forEach(r => { void controller.moveMark(r.id, dx, dy); }); }}>Move</button></div>
        {selected.length === 1 && selectedPoints && <fieldset disabled={locked || external}><legend>Vertex coordinates (PDF points)</legend><label>Vertex <select aria-label="Vertex" value={vertex} onChange={e => setVertex(Number(e.target.value))}>{selectedPoints.map((_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>{[0, 1].map(axis => <label key={axis}>{axis ? 'Y' : 'X'}<input type="number" step="0.1" value={Number((selectedPoints[vertex]?.[axis] ?? 0).toFixed(3))} onChange={e => { const n = Number(e.target.value); if (!Number.isFinite(n) || Math.abs(n) > 1e7) return; const point = [...selectedPoints[vertex]] as Point; point[axis] = n; commitGeometry(editVertex(data, selected[0], vertex, point)); }} /></label>)}</fieldset>}
        <ul className="review-replies">{chosen[0].meta.replies.map((r, i) => <li key={i}><strong>{r.author || 'Reviewer'}</strong> · {new Date(r.at).toLocaleString()}<p>{r.text}</p></li>)}</ul>
        <label>Reply <textarea aria-label="Reply" value={reply} onChange={e => setReply(e.target.value)} /></label><button disabled={!reply.trim()} onClick={() => { change({ ...data, reviewMeta: { ...data.reviewMeta, ...Object.fromEntries(selected.map(id => [id, { ...metaFor(data, id), replies: [...metaFor(data, id).replies, { text: reply.trim(), author, at: Date.now() }] }])) } }); setReply(''); }}>Add reply</button>
      </details>}
      <details><summary>Reusable tools</summary><label>Saved tool <select aria-label="Saved tool" defaultValue="" onChange={e => { const preset = tools.find(p => p.id === e.target.value); if (!preset) return; setTool(preset.kind); setArmedPreset(preset); setStyle(preset.style); setNote(preset.text); setDiscipline(preset.discipline); setSelected([]); }}><option value="" disabled>Choose a tool…</option>{tools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Tool name <input aria-label="Tool name" value={presetName} onChange={e => setPresetName(e.target.value)} /></label><button disabled={!presetName.trim() || tool === 'Select' && !first} onClick={() => {
          const preset = { points: first ? movePoints(first.points, -first.points[0][0], -first.points[0][1]) : undefined, id: crypto.randomUUID(), name: presetName.trim(), kind: first?.kind ?? tool as ReviewKind, text: note, style, discipline };
          const next = [...tools, preset];
          try { localStorage.setItem('folio:review-tools', JSON.stringify(next.filter(p => !starterTools.some(s => s.id === p.id)))); setTools(next); setPresetName(''); setMessage('Tool saved for other documents.'); } catch { setMessage('Could not save the tool on this computer.'); }
        }}>Save current tool</button>
        {tools.filter(p => !starterTools.some(s => s.id === p.id)).map(p => <div key={p.id}>{p.name}<button aria-label={`Remove tool ${p.name}`} onClick={() => { const next = tools.filter(t => t.id !== p.id); try { localStorage.setItem('folio:review-tools', JSON.stringify(next.filter(p => !starterTools.some(s => s.id === p.id)))); setTools(next); } catch { setMessage('Could not remove the tool.'); } }}>Remove</button></div>)}
      </details>
      <details open><summary>Markup list ({rows.length})</summary>
        <label>Search markups <input aria-label="Search markups" type="search" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <div className="review-fields"><label>Filter status <select aria-label="Filter status" value={status} onChange={e => setStatus(e.target.value)}>{['All', 'Unresolved', 'Open', 'Answered', 'Resolved'].map(s => <option key={s}>{s}</option>)}</select></label><label>Filter discipline <select aria-label="Filter discipline" value={disciplineFilter} onChange={e => setDisciplineFilter(e.target.value)}>{['All', ...new Set(rows.map(r => r.meta.discipline).filter(Boolean))].map(d => <option key={d}>{d}</option>)}</select></label></div>
        <ul className="review-list">{filtered.map(row => <li key={row.id} className={selected.includes(row.id) ? 'selected' : ''}><input type="checkbox" aria-label={`Select ${row.kind} on sheet ${row.page + 1}`} checked={selected.includes(row.id)} onChange={() => select(row.id, true)} /><button onClick={() => { setTool('Select'); select(row.id); if (row.source === 'annotation') controller.reveal(row.id); else {
            const r = review.find(m => m.id === row.id), m = data.measurements.find(m => m.id === row.id);
            const rect = r ? reviewGeometry(r).rect : m ? bounds(m.points) : state.pdfMarks?.find(m => m.id === row.id)?.data.rect as number[] | undefined;
            viewer.scrollPageIntoView({ pageNumber: row.page + 1, destArray: rect ? [null, { name: 'XYZ' }, rect[0], rect[3] + 40, null] : undefined });
          } }}><strong>Sheet {row.page + 1} · {row.kind} · {row.meta.status}</strong><span>{row.meta.subject || row.text || 'No comment'}</span><small>{[row.meta.author, row.meta.discipline, data.layers?.find(l => l.id === row.meta.layer)?.name, !markVisible(data, row.id) ? 'Hidden' : '', row.meta.carriedFrom ? 'Carried forward — verify' : '', row.meta.locked ? 'Locked' : ''].filter(Boolean).join(' · ')}</small></button></li>)}</ul>
        <div className="review-actions"><button onClick={() => onExport('csv')}>Export CSV</button><button onClick={() => onExport('pdf')}>Review report</button><button onClick={onFlatten}>Save flattened copy…</button></div>
      </details>
      <p role="status">{message}</p>
    </aside>}
  </>;
}
