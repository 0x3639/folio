import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons';
import type { ReviewKind } from './reviewModel';
import type { MeasureKind } from './measurements';

export type DrawingTool = ReviewKind | 'Select' | 'Comment';
export type ReviewPanel = 'comments' | 'style' | 'details' | 'layers' | 'tools' | 'arrange';
export type MeasureTool = MeasureKind | 'Calibrate';
const markupTools: [DrawingTool, IconName][] = [
  ['Select', 'cursor'], ['Comment', 'note'], ['Arrow', 'arrow'], ['Callout', 'callout'],
  ['Cloud callout', 'cloud'], ['Text', 'text'], ['Cloud', 'cloud'], ['Rectangle', 'rectangle'],
  ['Oval', 'oval'], ['Line', 'line'], ['Polygon', 'polygon'], ['Stamp', 'stamp'],
];
interface Props {
  tool: string; hint: string; message: string; count: number; drawing: boolean;
  onTool: (tool: DrawingTool) => void; onMeasure: (tool: MeasureTool) => void;
  onNative: (tool: 'highlight' | 'ink' | 'sign') => void; onPanel: (panel: ReviewPanel) => void;
  onUndo: (redo?: boolean) => void; onCancel: () => void;
  onFinish: () => void; onCompare: () => void; onCarry: () => void;
  onExport: (format: 'csv' | 'pdf') => void; onFlatten: () => void; onSave: () => void; onClose: () => void;
}
export function ReviewToolbar(p: Props) {
  const [tab, setTab] = useState('Markup'), [collapsed, setCollapsed] = useState(false);
  const root = useRef<HTMLElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const move = (left: number, top: number) => {
    const el = root.current, parent = el?.parentElement;
    if (!el || !parent) return;
    const next = { left: Math.max(12, Math.min(left, parent.clientWidth - el.offsetWidth - 12)), top: Math.max(12, Math.min(top, parent.clientHeight - el.offsetHeight - 12)) };
    setPosition(p => p.left === next.left && p.top === next.top ? p : next);
  };
  useEffect(() => {
    const observer = new ResizeObserver(() => move(position.left, position.top));
    if (root.current) { observer.observe(root.current); if (root.current.parentElement) observer.observe(root.current.parentElement); }
    return () => observer.disconnect();
  }, [position]);
  const button = (label: string, icon: IconName, action: () => void, pressed?: boolean) =>
    <button key={label} type="button" aria-pressed={pressed} onClick={action} title={label}><Icon name={icon} size={21} /><span>{label}</span></button>;
  return <aside ref={root} style={position} className={`drawing-toolbar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Drawing tools">
    <header><button className="drawing-toolbar-handle" aria-label="Move drawing toolbar" title="Drag to move. Arrow keys move; Home resets." onKeyDown={e => {
      if (e.key === 'Home') { e.preventDefault(); move(12, 12); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); move(position.left + (e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0), position.top + (e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0)); }
    }} onPointerDown={e => { if (e.button !== 0) return; drag.current = { x: e.clientX, y: e.clientY, ...position }; e.currentTarget.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { const d = drag.current; if (d) move(d.left + e.clientX - d.x, d.top + e.clientY - d.y); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}><strong>Drawing tools</strong></button><button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand drawing toolbar' : 'Collapse drawing toolbar'} aria-expanded={!collapsed}><Icon name={collapsed ? 'chevronDown' : 'chevronUp'} size={16} /></button><button onClick={p.onClose} aria-label="Close drawing toolbar"><Icon name="close" size={16} /></button></header>
    {!collapsed && <>
      <div className="drawing-tool-tabs" aria-label="Tool groups">{['Markup', 'Measure', 'Review'].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === 'Markup' && <><div className="drawing-tool-grid" role="group" aria-label="Markup tools">
        {markupTools.map(([tool, icon]) => button(tool, icon, () => p.onTool(tool), p.tool === tool))}
        {button('Highlight', 'highlight', () => p.onNative('highlight'), p.tool === 'highlight')}
        {button('Freehand', 'pen', () => p.onNative('ink'), p.tool === 'ink')}
        {button('Sign', 'signature', () => p.onNative('sign'))}
      </div><div className="drawing-quick-style"><button onClick={() => p.onPanel('style')}><Icon name="settings" size={15} /> Style</button><button onClick={() => p.onPanel('details')}><Icon name="info" size={15} /> Review details</button></div></>}
      {tab === 'Measure' && <><p className="drawing-tool-intro">Calibrate the sheet, then measure.</p><div className="drawing-tool-grid" role="group" aria-label="Measurement tools">{(['Calibrate', 'Length', 'Area', 'Perimeter', 'Count'] as const).map((t, i) => button(t, (['ruler', 'fitWidth', 'rectangle', 'polygon', 'grid'] as const)[i], () => p.onMeasure(t), p.tool === t))}</div></>}
      {tab === 'Review' && <div className="drawing-tool-grid drawing-review-grid" role="group" aria-label="Review actions">
        {button('Comments', 'note', () => p.onPanel('comments'))}
        {button('Layers', 'copy', () => p.onPanel('layers'))}
        {button('Tool chest', 'stamp', () => p.onPanel('tools'))}
        {button('Style', 'settings', () => p.onPanel('style'))}
        {button('Review details', 'info', () => p.onPanel('details'))}
        {button('Arrange', 'cursor', () => p.onPanel('arrange'))}
        {button('Compare revisions', 'grid', p.onCompare)}
        {button('Carry comments', 'copy', p.onCarry)}
        {button('Export CSV', 'list', () => p.onExport('csv'))}
        {button('Review report', 'file', () => p.onExport('pdf'))}
        {button('Flatten copy', 'download', p.onFlatten)}
      </div>}
      <div className="drawing-tool-instruction"><strong>{p.tool === 'Select' ? 'Ready to review' : p.tool === 'ink' ? 'Freehand' : p.tool === 'highlight' ? 'Highlight' : p.tool}</strong><p>{p.hint}</p>
        {p.drawing && <div className="review-actions"><button onClick={p.onCancel}>Cancel drawing</button>{p.tool === 'Polygon' && <button onClick={p.onFinish}>Finish polygon</button>}</div>}
      </div>
      <div className="drawing-tool-footer"><button onClick={() => p.onUndo()} title="Undo the active drawing tool’s edit"><Icon name="undo" size={15} /> Undo</button><button onClick={() => p.onUndo(true)}>Redo</button><button onClick={() => p.onPanel('comments')}>Comments ({p.count})</button></div>
      <button className="drawing-save" onClick={p.onSave}><Icon name="download" size={16} /> Save PDF copy</button>
      <p className="drawing-tool-status" role="status">{p.message}</p>
    </>}
  </aside>;
}
