import { markVisible } from './reviewModel';
import { drawingEndpoints, snapPoint } from "./drawingSnap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EventBus, PDFViewer } from "./viewer";
import { calibrate, distance, isSimpleOutline, emptyDrawing, measurementLabel, measurementValue, type DrawingData, type MeasureKind, type Measurement, type MeasureUnit, type Point } from "./measurements";

interface Props {
  viewer: PDFViewer;
  bus: EventBus;
  active: boolean;
  page: number;
  requestedTool?: { tool: MeasureKind | "Calibrate"; sequence: number };
  onModeChange?: (mode: MeasureKind | "Calibrate") => void;
  data?: DrawingData;
  onChange: (data: DrawingData) => void;
  onClose: () => void;
}
export function Measurements({ viewer, bus, active, page, requestedTool, onModeChange, data = emptyDrawing(), onChange, onClose }: Props) {
  // pdf.js replaces page children during zoom/rotation. Keep React's portal children in
  // their own host and reattach that host after each page render.
  const hosts = useRef(new Map<number, HTMLDivElement>());
  useLayoutEffect(() => {
    for (const [index, host] of hosts.current) {
      const surface = viewer.getPageView(index)?.div as HTMLElement | undefined;
      if (surface && host.parentElement !== surface) surface.append(host);
    }
  });
  useEffect(() => () => { for (const host of hosts.current.values()) host.remove(); }, []);
  const [mode, setMode] = useState<MeasureKind | "Calibrate">("Calibrate");
  useEffect(() => { if (requestedTool) { setMode(requestedTool.tool); setDraft(null); } }, [requestedTool]);
  useEffect(() => { if (active) onModeChange?.(mode); }, [mode, active, onModeChange]);
  const [draft, setDraft] = useState<{ page: number; points: Point[] } | null>(null);
  const [snap, setSnap] = useState(true);
  const endpoints = useRef(new Map<number, import("./measurements").Point[]>());
  useEffect(() => { if (active && viewer.pdfDocument) void drawingEndpoints(viewer.pdfDocument, page - 1).then(points => endpoints.current.set(page - 1, points)); }, [active, viewer, page]);
  const [known, setKnown] = useState("10");
  const [unit, setUnit] = useState<MeasureUnit>("ft");
  const [message, setMessage] = useState("");
  const [, redraw] = useState(0);
  useEffect(() => {
    const render = () => redraw(n => n + 1);
    const names = ["pagerendered", "scalechanging", "rotationchanging", "updateviewarea"];
    for (const name of names) bus.on(name, render);
    return () => { for (const name of names) bus.off(name, render); };
  }, [bus]);
  useEffect(() => { setDraft(null); setMessage(""); }, [active, mode, page]);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setDraft(null); setMessage(""); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [active]);

  const finish = (pending = draft) => {
    if (!pending) return;
    const points = pending.points;
    if (mode === "Calibrate") {
      try {
        const scale = calibrate(points[0], points[1], Number(known), unit);
        onChange({ ...data, scales: { ...data.scales, [pending.page]: scale } });
        setDraft(null); setMode("Length"); setMessage(`Page ${pending.page + 1} calibrated.`);
      } catch (error) { setDraft(null); setMessage((error as Error).message); }
      return;
    }
    const minimum = mode === "Count" ? 1 : mode === "Length" ? 2 : 3;
    if (points.length < minimum) { setMessage(`Choose at least ${minimum} points.`); return; }
    if ((mode === "Area" || mode === "Perimeter") && !isSimpleOutline(points)) { setMessage("Edges must not cross or overlap. Undo a point and try again."); return; }
    const scale = data.scales[pending.page];
    if (mode !== "Count" && !scale) { setMessage("Calibrate this page first."); return; }
    const mark: Measurement = { id: crypto.randomUUID(), page: pending.page, kind: mode, points, scale: scale ?? { unit, unitsPerPoint: 1 } };
    if (mode !== "Count" && (!Number.isFinite(measurementValue(mark)) || measurementValue(mark) < 0.000001)) { setMessage("Choose a non-zero measurement."); return; }
    onChange({ ...data, measurements: [...data.measurements, mark] });
    setDraft(null); setMessage(`${mode}: ${measurementLabel(mark)}`);
  };
  const scale = data.scales[page - 1];
  return <>
    {Array.from({ length: viewer.pagesCount }, (_, index) => {
      const view = viewer.getPageView(index);
      const surface = view?.div as HTMLElement | undefined;
      if (!surface || !view.viewport) return null;
      const viewport = view.viewport;
      const canvas = surface.querySelector(".canvasWrapper");
      if (!canvas) return null;
      const canvasBox = canvas.getBoundingClientRect(), pageBox = surface.getBoundingClientRect();
      let host = hosts.current.get(index);
      if (!host) {
        host = document.createElement("div");
        host.className = "measurement-host";
        hosts.current.set(index, host);
      }
      const marks = data.measurements.filter(mark => mark.page === index && markVisible(data, mark.id));
      const pending = draft?.page === index ? draft.points : [];
      const screen = (points: Point[]) => points.map(([x, y]) => viewport.convertToViewportPoint(x, y));
      return createPortal(<svg className={`measurement-overlay ${active ? 'measuring' : ''}`}
        style={{ left: canvasBox.left - pageBox.left - surface.clientLeft, top: canvasBox.top - pageBox.top - surface.clientTop, width: canvasBox.width, height: canvasBox.height }}
        aria-label={`Measurements on page ${index + 1}`} viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        onClick={event => { if (active) event.stopPropagation(); }}
        onPointerDown={event => {
          if (!active || event.button !== 0 || !event.isPrimary) return;
          event.preventDefault(); event.stopPropagation();
          if (mode !== "Calibrate" && mode !== "Count" && !data.scales[index]) { setMessage("Calibrate this page first."); return; }
          const box = event.currentTarget.getBoundingClientRect();
          const raw = viewport.convertToPdfPoint((event.clientX - box.left) / box.width * viewport.width, (event.clientY - box.top) / box.height * viewport.height) as Point;
          const previous = draft?.page === index ? draft.points : [];
          const { point } = snapPoint(raw, snap ? [...(endpoints.current.get(index) ?? []), ...data.measurements.filter(m => m.page === index && markVisible(data, m.id)).flatMap(m => m.points)] : [], 8 / viewport.scale, previous.at(-1), event.shiftKey);
          if (previous.length && distance(previous.at(-1)!, point) < 0.01) return;
          const next = { page: index, points: [...previous, point] };
          setDraft(next); setMessage("");
          if ((mode === "Length" || mode === "Calibrate") && next.points.length === 2) finish(next);
        }}>
        {marks.map(mark => {
          const points = screen(mark.points);
          return <g key={mark.id}>
            {mark.kind === "Count" ? points.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={4} />)
              : <polyline points={(mark.kind === "Length" ? points : [...points, points[0]]).map(p => p.join(',')).join(' ')} />}
            <text transform={`rotate(${viewport.rotation}, ${points[0][0]}, ${points[0][1]})`} style={{ fontSize: 10 * viewport.scale }} x={points[0][0]} y={points[0][1]}>{measurementLabel(mark)}</text>
          </g>;
        })}
        {pending.length > 0 && <g className="measurement-draft">
          <polyline points={screen(pending).map(p => p.join(',')).join(' ')} />
          {screen(pending).map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={4} />)}
        </g>}
      </svg>, host, String(index));
    })}
    {active && <section className="measurement-panel" aria-label="Drawing measurements">
      <header><strong>Measure drawings</strong><button onClick={onClose}>Done</button></header>
      <label>Tool <select aria-label="Measurement tool" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        {["Calibrate", "Length", "Area", "Perimeter", "Count"].map(name => <option key={name}>{name}</option>)}
      </select></label>
      {mode === "Calibrate" && <div className="measurement-calibration">
        <label>Known length <input aria-label="Known length" type="number" min="0" step="any" value={known} onChange={e => { setKnown(e.target.value); setDraft(null); }} /></label>
        <label>Units <select aria-label="Measurement units" value={unit} onChange={e => { setUnit(e.target.value as MeasureUnit); setDraft(null); }}>
          {["ft", "in", "m", "cm", "mm"].map(name => <option key={name}>{name}</option>)}
        </select></label>
      </div>}
      <p>{mode === "Calibrate" ? "Enter a known distance, then click its two endpoints on the drawing." : mode === "Length" ? "Click the two endpoints." : mode === "Count" ? "Click each item, then Finish." : "Click each corner in order, then Finish to close the outline. Do not cross edges."}</p>
      <label><input type="checkbox" checked={snap} onChange={e => setSnap(e.target.checked)} /> Snap to drawing endpoints</label>
      <p>Hold Shift to constrain to 45° angles. Scanned drawings have no vector endpoints.</p>
      <p>Page {page}: {scale ? `Calibrated in ${scale.unit}` : "Not calibrated"}</p>
      <div className="measurement-actions">
        <button disabled={!draft} onClick={() => setDraft(draft && draft.points.length > 1 ? { ...draft, points: draft.points.slice(0, -1) } : null)}>Undo point</button>
        <button disabled={!draft} onClick={() => { setDraft(null); setMessage(""); }}>Cancel</button>
        {mode !== "Calibrate" && mode !== "Length" && <button disabled={!draft} onClick={() => finish()}>Finish</button>}
      </div>
      <p role="status">{message}</p>
      <ul>{data.measurements.map(mark => <li key={mark.id}>
        <button onClick={() => { viewer.currentPageNumber = mark.page + 1; }}>{mark.kind} · p. {mark.page + 1} · {measurementLabel(mark)}</button>
        <button aria-label={`Delete ${mark.kind} measurement`} onClick={() => onChange({ ...data, measurements: data.measurements.filter(m => m.id !== mark.id) })}>×</button>
      </li>)}</ul>
      <small>Calibrate each page against a known dimension. Results keep the scale used when created. PDF copies retain editable measurement marks; flatten only for final issue.</small>
    </section>}
  </>;
}
