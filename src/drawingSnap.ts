import { OPS, Util } from 'pdfjs-dist';
import type { PDFDocumentProxy } from './pdf';
import type { Point } from './measurements';
const cache = new WeakMap<PDFDocumentProxy, Map<number, Promise<Point[]>>>();
/** Vector path endpoints, in unrotated PDF coordinates. Scans have no vector endpoints. */
export function drawingEndpoints(pdf: PDFDocumentProxy, page: number): Promise<Point[]> {
  let pages = cache.get(pdf);
  if (!pages) { pages = new Map(); cache.set(pdf, pages); }
  const found = pages.get(page); if (found) return found;
  const pending = (async () => {
    const list = await (await pdf.getPage(page + 1)).getOperatorList();
    let matrix = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [], points: Point[] = [];
    const add = (x: number, y: number) => {
      const p: Point = [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
      if (p.every(Number.isFinite)) points.push(p);
    };
    for (let i = 0; i < list.fnArray.length && points.length < 100000; i++) {
      const op = list.fnArray[i], args = list.argsArray[i];
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        stack.push([...matrix]);
        if (op === OPS.paintFormXObjectBegin && args[0]) matrix = Util.transform(matrix, args[0]);
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (op === OPS.transform) matrix = Util.transform(matrix, args);
      else if (op === OPS.constructPath) {
        const path = args[1]?.[0];
        if (!path || typeof path.length !== 'number') continue;
        for (let j = 0; j < path.length && points.length < 100000;) {
          const code = path[j++];
          if (code === 0 || code === 1) { add(path[j], path[j + 1]); j += 2; }
          else if (code === 2) { add(path[j + 4], path[j + 5]); j += 6; }
          else if (code === 3) { add(path[j + 2], path[j + 3]); j += 4; }
          else if (code !== 4) break;
        }
      }
    }
    return points;
  })().catch(() => []);
  pages.set(page, pending); return pending;
}
export { snapPoint } from './drawingGeometry';
