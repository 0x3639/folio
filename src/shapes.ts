import { AnnotationEditorType } from "pdfjs-dist";
import type { PDFViewer } from "./viewer";

export type Shape = "Rectangle" | "Oval" | "Arrow" | "Line" | "Cloud";
type Point = [number, number];

function strokes(shape: Shape, start: Point, end: Point, scale: number): Point[][] {
  const [x, y] = start, [a, b] = end;
  if (shape === "Line") return [[start, end]];
  if (shape === "Cloud") {
    const left = Math.min(x, a), right = Math.max(x, a), top = Math.min(y, b), bottom = Math.max(y, b);
    const corners: Point[] = [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]];
    const cloud: Point[] = [];
    for (let side = 0; side < 4; side++) {
      const from = corners[side], to = corners[side + 1];
      const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
      if (!length) continue;
      const lobes = Math.max(1, Math.ceil(length / (16 * scale)));
      for (let lobe = 0; lobe < lobes; lobe++) for (let step = 0; step < 9; step++) {
        const t = step / 8, along = (lobe + t) / lobes, bulge = Math.sin(t * Math.PI) * length / lobes / 3;
        cloud.push([from[0] + dx * along + dy / length * bulge, from[1] + dy * along - dx / length * bulge]);
      }
    }
    return cloud.length ? [[...cloud, cloud[0], cloud[0]]] : [];
  }
  if (shape === "Rectangle") {
    // Individual straight segments keep pdf.js from smoothing the corners as freehand ink.
    return [[start, [a, y]], [[a, y], end], [end, [x, b]], [[x, b], start]];
  }
  if (shape === "Arrow") {
    const angle = Math.atan2(b - y, a - x);
    const length = Math.min(12 * scale, Math.hypot(a - x, b - y) / 3);
    const wing = (offset: number): Point => [a - length * Math.cos(angle + offset), b - length * Math.sin(angle + offset)];
    return [[start, end], [wing(0.5), end], [end, wing(-0.5)]];
  }
  const oval = Array.from({ length: 64 }, (_, i): Point => {
    const angle = i * Math.PI / 32;
    return [(a + x + (a - x) * Math.cos(angle)) / 2, (b + y + (b - y) * Math.sin(angle)) / 2];
  });
  // The ink fitter ends midway between its final two samples.
  return [[...oval, oval[0], oval[0]]];
}

export function drawShapes(container: HTMLElement, viewer: PDFViewer, shape: Shape, color: string,
  add: (pageIndex: number, data: Record<string, unknown>) => void) {
  const listeners = new AbortController();
  let cancel: (() => void) | undefined;

  container.addEventListener("pointerdown", down => {
    const layer = down.target;
    if (cancel || !down.isPrimary || down.button !== 0 || !(layer instanceof HTMLElement)
      || !layer.matches(".annotationEditorLayer.inkEditing")) return;
    const page = layer.closest<HTMLElement>(".page")!;
    const pageIndex = Number(page.dataset.pageNumber) - 1;
    const view = viewer.getPageView(pageIndex);
    const surface = page.querySelector(".canvasWrapper");
    if (!view?.viewport || !surface) return;
    down.preventDefault();
    down.stopPropagation();
    const viewport = view.viewport;
    const localPoint = (event: PointerEvent): Point => {
      const box = surface.getBoundingClientRect();
      return [Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * viewport.width,
        Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) * viewport.height];
    };
    const start = localPoint(down);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS(svg.namespaceURI!, "path");
    svg.classList.add("shape-preview");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("viewBox", `0 0 ${viewport.width} ${viewport.height}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", String(viewport.scale));
    svg.append(path);
    page.append(svg);
    const gesture = new AbortController();
    const options = { signal: gesture.signal, capture: true };
    const finish = () => {
      gesture.abort();
      cancel = undefined;
      svg.remove();
      if (layer.hasPointerCapture(down.pointerId)) layer.releasePointerCapture(down.pointerId);
    };
    cancel = finish;
    layer.setPointerCapture(down.pointerId);
    layer.addEventListener("pointermove", event => {
      if (event.pointerId !== down.pointerId) return;
      const paths = strokes(shape, start, localPoint(event), viewport.scale);
      path.setAttribute("d", paths.map(points => "M" + points.map(p => p.join(" ")).join(" L")).join(" "));
    }, options);
    layer.addEventListener("pointerup", event => {
      if (event.pointerId !== down.pointerId) return;
      event.stopPropagation();
      const end = localPoint(event);
      finish();
      const dx = Math.abs(start[0] - end[0]), dy = Math.abs(start[1] - end[1]);
      if (((shape === "Arrow" || shape === "Line") ? Math.hypot(dx, dy) : Math.min(dx, dy)) < 2) return;
      const paths = strokes(shape, start, end, viewport.scale).map(line =>
        line.map(([x, y]) => viewport.convertToPdfPoint(x, y) as Point));
      const xs = paths.flat().map(p => p[0]), ys = paths.flat().map(p => p[1]);
      add(pageIndex, { annotationType: AnnotationEditorType.INK, pageIndex, rotation: 0, thickness: 1, opacity: 1,
        color: [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)),
        rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        paths: { points: paths.map(line => Float32Array.from(line.flat())) } });
    }, options);
    const cancelled = (event: PointerEvent) => { if (event.pointerId === down.pointerId) finish(); };
    layer.addEventListener("pointercancel", cancelled, options);
    layer.addEventListener("lostpointercapture", cancelled, options);
    window.addEventListener("blur", finish, options);
  }, { signal: listeners.signal, capture: true });
  return () => { cancel?.(); listeners.abort(); };
}
