import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EventBus, PDFViewer } from './viewer';
import type { MarkupController, MarkupState } from './markup';
import { emptyDrawing, measurementLabel, isSimpleOutline, type Point } from './measurements';
import { bounds, defaultStyle, markVisible, metaFor, movePoints, readToolPresets, reviewGeometry, reviewRows, starterTools, type ReviewKind, type ReviewMark, type ReviewMeta, type ReviewStyle } from './reviewModel';
import { usePageOverlays } from './pageOverlays';
import { drawingEndpoints, snapPoint } from './drawingSnap';
import { keys } from './platform';
import { ReviewStylePanel } from './ReviewStylePanel';
const reviewPanels: [ReviewPanel, string][] = [['style', 'Style'], ['details', 'Review details'], ['layers', 'Layers'], ['comments', 'Comments'], ['arrange', 'Arrange'], ['tools', 'Tool chest']];
import { ReviewToolbar, type DrawingTool, type ReviewPanel, type MeasureTool } from './ReviewToolbar';
interface Props { viewer: PDFViewer; bus: EventBus; state: MarkupState; controller: MarkupController; active: boolean; toolbarVisible: boolean; otherTool: string; onActivate: () => Promise<boolean>; onMeasure: (tool: MeasureTool) => void; onNative: (tool: 'highlight' | 'ink' | 'sign') => void; onSave: () => void; onClose: () => void; onExport: (format: 'csv' | 'pdf') => void; onCompare: () => void; onCarry: () => void; onFlatten: () => void }
export function ReviewWorkspace({ viewer, bus, state, controller, active, toolbarVisible, otherTool, onActivate, onMeasure, onNative, onSave, onClose, onExport, onCompare, onCarry, onFlatten }: Props) {
  const data = state.drawing ?? emptyDrawing(), review = data.review ?? [], rows = reviewRows(data, [...state.marks, ...(state.pdfMarks ?? [])], measurementLabel);
  const overlays = usePageOverlays(viewer, bus);
  const [tool, setTool] = useState<DrawingTool>('Select');
  const [panel, setPanel] = useState<ReviewPanel | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [composer, setComposer] = useState<ReviewMark | null>(null);
  const [commentText, setCommentText] = useState('');
  const [hover, setHover] = useState<Point | null>(null);
  const creation = useRef<{ page: number; start: Point; moved: boolean } | null>(null);
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
  useEffect(() => { setDraft(null); setPreview(null); setHover(null); creation.current = null; gesture.current = null; if (!active) { setComposer(null); setPanel(null); } }, [tool, active]);
  useEffect(() => { setVertex(0); }, [selected.join(',')]);
  useEffect(() => { if (first) { setStyle(first.style); setNote(first.text); } }, [first]);
  useEffect(() => { if (panelRef.current) panelRef.current.scrollTop = 0; }, [panel]);
  const choose = async (next: DrawingTool) => {
    if (!active && !await onActivate()) return;
    setTool(next); if (next === 'Comment') setStyle(s => ({ ...s, color: '#333333', fill: '#fff4b8' })); setArmedPreset(null); setSelected([]); setNote(''); setMessage(''); setDraft(null); setComposer(null); setHover(null); setPanel(null);
  };
  const openPanel = async (next: ReviewPanel) => {
    if (!active && !await onActivate()) return;
    if (next === 'comments' || !active) setTool('Select');
    setPanel(next);
  };
  const change = (next: typeof data) => controller.setDrawing(next);
  const metadata = (patch: Partial<ReviewMeta>) => {
    change({ ...data, reviewMeta: { ...data.reviewMeta, ...Object.fromEntries(selected.map(id => [id, { ...metaFor(data, id), ...patch }])) } });
  };
  const applyStyle = (patch: Partial<ReviewStyle>) => {
    setStyle(s => ({ ...s, ...patch }));
    if (!chosen.length || locked || external || chosen.some(r => r.source === 'measurement')) return;
    change({ ...data, review: review.map(m => selected.includes(m.id) ? { ...m, style: { ...m.style, ...patch } } : m) });
    chosen.filter(r => r.source === 'annotation').forEach(r => { void controller.styleMark(r.id, patch); });
  };
  const select = (id: string, additive = false) => {
    if (panel === 'comments' && panelRef.current) panelRef.current.scrollTop = 0;
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
  const saveMark = (mark: ReviewMark) => {
    const exists = review.some(m => m.id === mark.id);
    change({ ...data, review: exists ? review.map(m => m.id === mark.id ? mark : m) : [...review, mark],
      reviewMeta: { ...data.reviewMeta, [mark.id]: exists ? metaFor(data, mark.id) : { ...metaFor(data, mark.id), author, discipline, layer: activeLayer || undefined } } });
    setDraft(null); setHover(null); setSelected([mark.id]); setNote(mark.text); setMessage(`${mark.kind === 'Text' ? 'Comment' : mark.kind} added.`);
    if (!panel) setTool('Select');
  };
  const finish = (pending = draft) => {
    if (!pending || tool === 'Select') return;
    if (tool === 'Polygon' && (pending.points.length < 3 || !isSimpleOutline(pending.points))) { setMessage('Use at least three corners with no crossing edges.'); return; }
    const points = [...pending.points];
    if (tool === 'Callout' && points.length === 2) points.splice(1, 0, [points[1][0] - 15, points[1][1] - 8]);
    const mark: ReviewMark = { id: crypto.randomUUID(), page: pending.page, kind: tool === 'Comment' ? 'Text' : tool, points, text: note, style: { ...style }, createdAt: Date.now() };
    if (['Callout', 'Cloud callout', 'Text', 'Stamp'].includes(mark.kind) && !note.trim()) {
      setComposer(mark); setCommentText(''); setDraft(null); setHover(null); setPanel(null); return;
    }
    saveMark(mark);
  };
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
      if (e.key === 'Escape') { setTool('Select'); setComposer(null); setHover(null); creation.current = null; setDraft(null); setPreview(null); gesture.current = null; setSelected([]); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); remove(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); controller.undoDrawing(e.shiftKey); }
      else if (e.key === 'Enter' && tool === 'Polygon') { e.preventDefault(); finish(); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  });
  const filtered = rows.filter(r => (status === 'All' || r.meta.status === status || status === 'Unresolved' && r.meta.status !== 'Resolved') && (disciplineFilter === 'All' || r.meta.discipline === disciplineFilter) && `${r.text} ${r.kind} ${r.meta.author} ${r.meta.subject} ${r.page + 1}`.toLowerCase().includes(filter.toLowerCase()));
  const hint = !active ? otherTool === 'highlight' ? 'Select text on the drawing to highlight it.' : otherTool === 'ink' ? 'Drag on the drawing to draw freehand.' : otherTool === 'Select' ? 'Choose a markup tool to continue reviewing.' : 'Use the measurement panel to set the scale and finish your measurement.'
    : composer ? 'Type your comment, then choose Add comment.' : armedPreset?.points && tool !== 'Select' ? `Click once to place ${armedPreset.name}.`
    : tool === 'Select' ? 'Choose Comment to add a note, or select an existing mark to edit it.'
    : tool === 'Comment' ? 'Click anywhere on the drawing, then type your comment.'
    : tool === 'Callout' ? 'Drag from the arrow tip to the note location, then type. Two clicks also work.'
    : tool === 'Cloud callout' ? 'Choose opposite cloud corners, then click where you want the note.'
    : tool === 'Polygon' ? 'Click each corner, then Finish polygon or press Enter.'
    : ['Text', 'Stamp'].includes(tool) ? 'Drag a box on the drawing, then type your text.'
    : 'Drag on the drawing, or click two endpoints. Hold Shift for 45° angles.';
  const hasSelection = chosen.length > 0;
  const scope = hasSelection ? `${chosen.length} selected · ${chosen.length === 1 ? chosen[0].kind + ' · Sheet ' + (chosen[0].page + 1) : 'changes apply to all selected marks'}` : tool === 'Select' ? 'Defaults for new marks' : `New ${tool.toLowerCase()}`;
  const textEditor = (!hasSelection || first) && <label>{chosen.length > 1 ? 'Text of first selected markup' : 'Comment or stamp text'} <textarea aria-label="Note or stamp text" disabled={locked || external} value={note} maxLength={10000} onChange={e => {
    setNote(e.target.value); if (first && !locked) change({ ...data, review: review.map(m => m.id === first.id ? { ...m, text: e.target.value } : m) });
  }} /></label>;
  const reviewStatus = hasSelection && <><label>Review status <select aria-label="Review status" value={chosen[0].meta.status} onChange={e => metadata({ status: e.target.value as ReviewMeta['status'] })}>{['Open', 'Answered', 'Resolved'].map(v => <option key={v}>{v}</option>)}</select></label></>;
  const selectedLayer = hasSelection && <><label>Selected layer <select aria-label="Selected layer" disabled={external || locked} value={chosen[0].meta.layer ?? ''} onChange={e => metadata({ layer: e.target.value || undefined })}><option value="">Unassigned</option>{(data.layers ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label></>;
  const provenance = hasSelection && <>{chosen[0].meta.carriedFrom && <p>Carried from {chosen[0].meta.carriedFrom.document}, sheet {chosen[0].meta.carriedFrom.page + 1}. Check placement and any measurement scale against this revision.</p>}</>;
  const selectionActions = hasSelection && <><div className="review-actions"><button disabled={locked || external} onClick={duplicate}>Duplicate</button><button disabled={locked || external || selected.length < 2 || new Set(chosen.map(r => r.page)).size > 1} onClick={() => metadata({ group: crypto.randomUUID() })}>Group</button><button disabled={locked || external} onClick={() => metadata({ group: undefined })}>Ungroup</button><button onClick={() => metadata({ locked: !locked })}>{locked ? 'Unlock' : 'Lock'}</button><button disabled={locked || external} onClick={remove}>Delete</button></div></>;
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
          if (!active || composer || e.button !== 0 || !e.isPrimary) return;
          e.preventDefault(); e.stopPropagation();
          const point = pointer(e);
          if (tool !== 'Select') {
            if (tool === 'Comment') {
              const [left, bottom, right, top] = viewport.viewBox, width = Math.min(180, right - left), height = Math.min(64, top - bottom);
              const x = Math.max(left, Math.min(point[0], right - width)), y = Math.min(top, Math.max(point[1], bottom + height));
              finish({ page: index, points: [[x, y], [x + width, y - height]] }); return;
            }
            if (armedPreset?.points) { finish({ page: index, points: movePoints(armedPreset.points, point[0], point[1]) }); return; }
            const next = { page: index, points: [...(draft?.page === index ? draft.points : []), point] };
            setDraft(next); setHover(null);
            if (next.points.length === 1 && tool !== 'Polygon') { creation.current = { page: index, start: point, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); }
            if (tool !== 'Polygon' && next.points.length === (tool === 'Cloud callout' ? 3 : 2)) finish(next);
            return;
          }
          const target = (e.target as Element).closest('[data-review-id]');
          const id = target?.getAttribute('data-review-id');
          if (!id) { setSelected([]); return; }
          const vertexAttr = (e.target as Element).getAttribute('data-vertex');
          const group = metaFor(data, id).group;
          const ids = selected.includes(id) ? selected : group ? rows.filter(r => r.meta.group === group).map(r => r.id) : [id];
          select(id, e.shiftKey); if (!panel) setPanel('comments');
          if (ids.some(id => metaFor(data, id).locked) || e.shiftKey) return;
          gesture.current = { page: index, start: point, original: data, ids, vertex: vertexAttr === null ? undefined : Number(vertexAttr), moved: false };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onDoubleClick={e => {
          const id = (e.target as Element).closest('[data-review-id]')?.getAttribute('data-review-id');
          const mark = review.find(m => m.id === id);
          if (active && tool === 'Select' && mark?.text && !metaFor(data, mark.id).locked) { setComposer(mark); setCommentText(mark.text); setPanel(null); }
        }}
        onPointerMove={e => {
          if (active && !composer && tool !== 'Select' && draft?.page === index) {
            const point = pointer(e); setHover(point);
            if (creation.current) creation.current.moved ||= Math.hypot(point[0] - creation.current.start[0], point[1] - creation.current.start[1]) * viewport.scale > 4;
            return;
          }
          const g = gesture.current; if (!g || g.page !== index) return;
          const point = pointer(e), x = point[0] - g.start[0], y = point[1] - g.start[1];
          g.moved = g.moved || Math.hypot(x, y) > .1;
          setPreview(g.vertex === undefined ? move(g.original, g.ids, x, y) : editVertex(g.original, g.ids[0], g.vertex, point));
        }}
        onPointerUp={e => {
          const c = creation.current;
          if (c) {
            creation.current = null;
            if (c.moved) { const next = { page: index, points: [c.start, pointer(e)] }; if (tool === 'Cloud callout') setDraft(next); else finish(next); }
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            return;
          }
          const g = gesture.current; if (!g) return;
          const point = pointer(e), x = point[0] - g.start[0], y = point[1] - g.start[1];
          if (g.moved) {
            commitGeometry(g.vertex === undefined ? move(g.original, g.ids, x, y) : editVertex(g.original, g.ids[0], g.vertex, point));
            if (g.vertex === undefined) rows.filter(r => g.ids.includes(r.id) && r.source === 'annotation').forEach(r => { void controller.moveMark(r.id, x, y); });
          }
          gesture.current = null; setPreview(null); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }} onPointerCancel={() => { creation.current = null; setDraft(null); setHover(null); gesture.current = null; setPreview(null); }} onLostPointerCapture={() => { creation.current = null; gesture.current = null; setPreview(null); }}>
        {(currentData.review ?? []).filter(m => m.page === index && markVisible(currentData, m.id)).map(m => paintMark(m))}
        {active && currentData.measurements.filter(m => m.page === index && markVisible(currentData, m.id)).map(m => <g key={m.id} data-review-id={m.id}><polyline points={m.points.map(screen).map(p => p.join(',')).join(' ')} fill="none" stroke="transparent" strokeWidth={14} /><text x={screen(m.points[0])[0]} y={screen(m.points[0])[1]} fill="transparent" fontSize={14}>{measurementLabel(m)}</text></g>)}
        {active && selected.length === 1 && !locked && markVisible(currentData, selected[0]) && (currentData.review?.find(m => m.id === selected[0]) ?? currentData.measurements.find(m => m.id === selected[0]))?.points.map((p, i) => { const [cx, cy] = screen(p); return <circle key={i} data-review-id={selected[0]} data-vertex={i} cx={cx} cy={cy} r={5} className="review-vertex" />; })}
        {active && draft?.page === index && (draft.points.length >= 2 || hover) && tool !== 'Select' && paintMark({ id: 'draft', page: index, points: tool === 'Callout' && hover ? [draft.points[0], [hover[0] - 15, hover[1] - 8], hover] : hover ? [...draft.points, hover] : draft.points, kind: tool === 'Comment' ? 'Text' : tool, text: note || 'Your comment', style, createdAt: 0 }, true)}
        {active && composer?.page === index && paintMark({ ...composer, text: commentText || 'Your comment' }, true)}
        {active && draft?.page === index && draft.points.map((p, i) => { const [cx, cy] = screen(p); return <circle key={i} cx={cx} cy={cy} r={4} fill={style.color} />; })}
      </svg>, host, String(index));
    })}
    {toolbarVisible && <ReviewToolbar tool={active ? tool : otherTool} hint={hint} message={message} count={rows.length} drawing={!!draft}
      onTool={choose} onMeasure={onMeasure} onNative={onNative} onPanel={openPanel}
      onUndo={redo => { if (!active && ['ink', 'highlight', 'Select'].includes(otherTool)) bus.dispatch('editingaction', { source: null, name: redo ? 'redo' : 'undo' }); else controller.undoDrawing(redo); }} onCancel={() => { setDraft(null); setHover(null); }} onFinish={() => finish()}
      onCompare={onCompare} onCarry={onCarry} onExport={onExport} onFlatten={onFlatten} onSave={onSave} onClose={onClose} />}
    {active && composer && <form className="review-composer" aria-label="Comment editor" onSubmit={e => { e.preventDefault(); if (commentText.trim()) { saveMark({ ...composer, text: commentText.trim() }); setComposer(null); } }}
      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); setComposer(null); setTool('Select'); } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.currentTarget.requestSubmit(); } }}>
      <header><strong>{review.some(m => m.id === composer.id) ? 'Edit comment' : 'Add a comment'}</strong><span>Sheet {composer.page + 1}</span></header>
      <label htmlFor="drawing-comment">Comment</label><textarea id="drawing-comment" autoFocus value={commentText} maxLength={10000} placeholder="What needs attention?" onChange={e => setCommentText(e.target.value)} />
      <div className="review-actions"><button type="button" onClick={() => { setComposer(null); setTool('Select'); }}>Cancel</button><button type="submit" className="primary" disabled={!commentText.trim()}>{review.some(m => m.id === composer.id) ? 'Save comment' : 'Add comment'}</button></div>
      <small>{keys('Ctrl+Enter')} to save · Escape to cancel</small>
    </form>}
    {active && panel && <aside ref={panelRef} className={`review-panel review-panel-${panel}`} aria-label="Drawing review">
      <header><strong>{reviewPanels.find(([id]) => id === panel)?.[1]}</strong><button onClick={() => setPanel(null)}>Done</button></header>
      <nav className="review-panel-nav" aria-label="Review panels">{reviewPanels.map(([id, label]) => <button key={id} aria-pressed={panel === id} onClick={() => openPanel(id)}>{label}</button>)}</nav>
      <p className="review-panel-scope">{scope}</p>
      {panel === 'style' && <>
        <p className="review-hint">Change how the markup looks. {hasSelection ? 'Changes appear on the selected marks immediately.' : 'Choose a tool and set its style before drawing.'}</p>
        {locked && <p>Unlock the selection in Arrange to change its style.</p>}
        {(external || chosen.some(r => r.source === 'measurement')) && <p>This selection’s appearance cannot be changed here. Review details and comments are available separately.</p>}
        <ReviewStylePanel style={first?.style ?? style} onChange={applyStyle} disabled={locked || external || chosen.some(r => r.source === 'measurement')} />
      </>}
      {panel === 'details' && <section aria-label="Review details">
        <p className="review-hint">{hasSelection ? 'Track who reviewed this markup, its status, and its layer.' : 'Set the reviewer and layer for new marks. Select a markup to change its subject or status.'}</p>
        {hasSelection && <><label>Subject <input aria-label="Subject" value={chosen[0].meta.subject} onChange={e => metadata({ subject: e.target.value })} /></label></>}
        <label>Author <input aria-label="Author" value={hasSelection ? chosen[0].meta.author : author} onChange={e => {
          if (hasSelection) metadata({ author: e.target.value });
          else { setAuthor(e.target.value); try { localStorage.setItem('folio:review-author', e.target.value); } catch { /* Optional preference. */ } }
        }} /></label>
        <label>Discipline <input aria-label="Discipline" value={hasSelection ? chosen[0].meta.discipline : discipline} onChange={e => { if (hasSelection) metadata({ discipline: e.target.value }); else setDiscipline(e.target.value); }} placeholder="Architectural" /></label>
        {reviewStatus}{selectedLayer}
        {!hasSelection && <label>Layer for new marks <select aria-label="Layer for new marks" value={activeLayer} onChange={e => setActiveLayer(e.target.value)}><option value="">Unassigned</option>{(data.layers ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
        {provenance}
      </section>}
      {panel === 'layers' && <>{selectedLayer}<section aria-label="Markup layers">
        <div className="review-fields"><label>New layer <input aria-label="New layer" maxLength={80} value={layerName} onChange={e => setLayerName(e.target.value)} /></label><button disabled={!layerName.trim() || (data.layers?.length ?? 0) >= 100} onClick={() => {
          const id = crypto.randomUUID(); change({ ...data, layers: [...(data.layers ?? []), { id, name: layerName.trim(), visible: true }] }); setActiveLayer(id); setLayerName('');
        }}>Add layer</button></div>
        <label>Layer for new marks <select aria-label="Layer for new marks" value={activeLayer} onChange={e => setActiveLayer(e.target.value)}><option value="">Unassigned</option>{(data.layers ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        {(data.layers ?? []).map(layer => <div className="review-fields" key={layer.id}>
          <label><input type="checkbox" aria-label={`Show layer ${layer.name}`} checked={layer.visible} onChange={e => { change({ ...data, layers: data.layers?.map(l => l.id === layer.id ? { ...l, visible: e.target.checked } : l) }); setSelected([]); }} /> Show</label>
          <input aria-label={`Layer name ${layer.name}`} maxLength={80} value={layer.name} onChange={e => { if (e.target.value.trim()) change({ ...data, layers: data.layers?.map(l => l.id === layer.id ? { ...l, name: e.target.value } : l) }); }} />
        </div>)}
        <p className="review-hint">Hidden layers stay editable in Folio and are omitted from flattened copies. Show a layer here before sharing its visible marks. Assign measurements using the markup list.</p>
      </section></>}
      {panel === 'arrange' && <section aria-label="Arrange marks">
        <p className="review-hint">Select marks to move, duplicate, group, or lock them. Shift-click to select more than one.</p>
        <label><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} /> Snap to vector endpoints</label>
        {selectionActions}
        {hasSelection && <><div className="review-fields"><label>Move X (PDF points) <input aria-label="Move X (PDF points)" type="number" value={dx} onChange={e => setDx(Number(e.target.value))} /></label><label>Move Y (PDF points) <input aria-label="Move Y (PDF points)" type="number" value={dy} onChange={e => setDy(Number(e.target.value))} /></label><button disabled={locked || external || !Number.isFinite(dx + dy)} onClick={() => { change(move(data, selected, dx, dy)); chosen.filter(r => r.source === 'annotation').forEach(r => { void controller.moveMark(r.id, dx, dy); }); }}>Move</button></div>
        {selected.length === 1 && selectedPoints && <fieldset className="review-advanced" disabled={locked || external}><legend>Vertex coordinates (PDF points)</legend><label>Vertex <select aria-label="Vertex" value={vertex} onChange={e => setVertex(Number(e.target.value))}>{selectedPoints.map((_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>{[0, 1].map(axis => <label key={axis}>{axis ? 'Y' : 'X'}<input type="number" step="0.1" value={Number((selectedPoints[vertex]?.[axis] ?? 0).toFixed(3))} onChange={e => { const n = Number(e.target.value); if (!Number.isFinite(n) || Math.abs(n) > 1e7) return; const point = [...selectedPoints[vertex]] as Point; point[axis] = n; commitGeometry(editVertex(data, selected[0], vertex, point)); }} /></label>)}</fieldset>}</>}
      </section>}
      {panel === 'tools' && <><p className="review-hint">Save a selected markup’s geometry and appearance, or the current tool’s style, to reuse later.</p><section aria-label="Reusable tools"><label>Saved tool <select aria-label="Saved tool" defaultValue="" onChange={e => { const preset = tools.find(p => p.id === e.target.value); if (!preset) return; setTool(preset.kind); setArmedPreset(preset); setStyle(preset.style); setNote(preset.text); setDiscipline(preset.discipline); setSelected([]); }}><option value="" disabled>Choose a tool…</option>{tools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Tool name <input aria-label="Tool name" value={presetName} onChange={e => setPresetName(e.target.value)} /></label><button disabled={!presetName.trim() || tool === 'Select' && !first} onClick={() => {
          const preset = { points: first ? movePoints(first.points, -first.points[0][0], -first.points[0][1]) : undefined, id: crypto.randomUUID(), name: presetName.trim(), kind: first?.kind ?? (tool === 'Comment' ? 'Text' : tool) as ReviewKind, text: note, style, discipline: chosen[0]?.meta.discipline ?? discipline };
          const next = [...tools, preset];
          try { localStorage.setItem('folio:review-tools', JSON.stringify(next.filter(p => !starterTools.some(s => s.id === p.id)))); setTools(next); setPresetName(''); setMessage('Tool saved for other documents.'); } catch { setMessage('Could not save the tool on this computer.'); }
        }}>Save current tool</button>
        {tools.filter(p => !starterTools.some(s => s.id === p.id)).map(p => <div key={p.id}>{p.name}<button aria-label={`Remove tool ${p.name}`} onClick={() => { const next = tools.filter(t => t.id !== p.id); try { localStorage.setItem('folio:review-tools', JSON.stringify(next.filter(p => !starterTools.some(s => s.id === p.id)))); setTools(next); } catch { setMessage('Could not remove the tool.'); } }}>Remove</button></div>)}
      </section></>}
      {panel === 'comments' && <>
        <button onClick={() => choose('Comment')}>Add a comment</button>
        {hasSelection && <section className="review-comment-thread" aria-label="Selected comment">
          {textEditor}{reviewStatus}
          {external && <p>Original PDF annotation: add replies or track its status here. Add a callout to propose changes to its content.</p>}
          <ul className="review-replies">{chosen[0].meta.replies.map((r, i) => <li key={i}><strong>{r.author || 'Reviewer'}</strong> · {new Date(r.at).toLocaleString()}<p>{r.text}</p></li>)}</ul>
        <label>Reply <textarea aria-label="Reply" value={reply} onChange={e => setReply(e.target.value)} /></label><button disabled={!reply.trim()} onClick={() => { change({ ...data, reviewMeta: { ...data.reviewMeta, ...Object.fromEntries(selected.map(id => [id, { ...metaFor(data, id), replies: [...metaFor(data, id).replies, { text: reply.trim(), author, at: Date.now() }] }])) } }); setReply(''); }}>Add reply</button>
        </section>}
        <section aria-label="Markup list"><h3>Markup list ({rows.length})</h3>
        <label>Search markups <input aria-label="Search markups" type="search" value={filter} onChange={e => setFilter(e.target.value)} /></label>
        <div className="review-fields"><label>Filter status <select aria-label="Filter status" value={status} onChange={e => setStatus(e.target.value)}>{['All', 'Unresolved', 'Open', 'Answered', 'Resolved'].map(s => <option key={s}>{s}</option>)}</select></label><label>Filter discipline <select aria-label="Filter discipline" value={disciplineFilter} onChange={e => setDisciplineFilter(e.target.value)}>{['All', ...new Set(rows.map(r => r.meta.discipline).filter(Boolean))].map(d => <option key={d}>{d}</option>)}</select></label></div>
        <ul className="review-list">{filtered.map(row => <li key={row.id} className={selected.includes(row.id) ? 'selected' : ''}><input type="checkbox" aria-label={`Select ${row.kind} on sheet ${row.page + 1}`} checked={selected.includes(row.id)} onChange={() => select(row.id, true)} /><button onClick={() => { setTool('Select'); select(row.id); if (row.source === 'annotation') controller.reveal(row.id); else {
            const r = review.find(m => m.id === row.id), m = data.measurements.find(m => m.id === row.id);
            const rect = r ? reviewGeometry(r).rect : m ? bounds(m.points) : state.pdfMarks?.find(m => m.id === row.id)?.data.rect as number[] | undefined;
            viewer.scrollPageIntoView({ pageNumber: row.page + 1, destArray: rect ? [null, { name: 'XYZ' }, rect[0], rect[3] + 40, null] : undefined });
          } }}><strong>Sheet {row.page + 1} · {row.kind} · {row.meta.status}</strong><span>{row.meta.subject || row.text || 'No comment'}</span><small>{[row.meta.author, row.meta.discipline, data.layers?.find(l => l.id === row.meta.layer)?.name, !markVisible(data, row.id) ? 'Hidden' : '', row.meta.carriedFrom ? 'Carried forward — verify' : '', row.meta.locked ? 'Locked' : ''].filter(Boolean).join(' · ')}</small></button></li>)}</ul>
        <div className="review-actions"><button onClick={() => onExport('csv')}>Export CSV</button><button onClick={() => onExport('pdf')}>Review report</button><button onClick={onFlatten}>Save flattened copy…</button></div>
      </section>
        {!rows.length && <p>No comments yet. Choose Add a comment, then click the drawing.</p>}
      </>}
      <footer className="review-panel-footer"><button onClick={() => controller.undoDrawing()} title={keys('Undo review edit (Ctrl+Z)')}>Undo</button><button onClick={() => controller.undoDrawing(true)}>Redo</button></footer>
      <p role="status">{message}</p>
    </aside>}
  </>;
}
