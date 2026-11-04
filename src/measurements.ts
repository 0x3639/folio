export type Point = [number, number];
export type MeasureKind = "Length" | "Area" | "Perimeter" | "Count";
export type MeasureUnit = "ft" | "in" | "m" | "cm" | "mm";
export interface PageScale { unitsPerPoint: number; unit: MeasureUnit }
export interface Measurement {
  id: string;
  page: number;
  kind: MeasureKind;
  points: Point[];
  scale: PageScale;
}
export interface DrawingData {
  review?: import('./reviewModel').ReviewMark[];
  reviewMeta?: Record<string, import('./reviewModel').ReviewMeta>;
  scales: Record<number, PageScale>; measurements: Measurement[] }
export const emptyDrawing = (): DrawingData => ({ scales: {}, measurements: [] });
export const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export function calibrate(a: Point, b: Point, length: number, unit: MeasureUnit): PageScale {
  const span = distance(a, b);
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(span) || !Number.isFinite(length / span) || span < 0.01) throw new Error("Use two distinct points and a positive known length.");
  return { unitsPerPoint: length / span, unit };
}
/** Crossing outlines have ambiguous takeoff areas, so reject them before saving. */
export function isSimpleOutline(points: Point[]): boolean {
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const on = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < 1e-8 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (distance(a, b) < 0.01) return false;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      const c = points[j], d = points[(j + 1) % points.length];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return false;
    }
  }
  return true;
}
export function measurementValue({ kind, points, scale }: Measurement): number {
  if (kind === "Count") return points.length;
  if (kind === "Area") {
    // Translate to the first vertex to avoid cancellation on drawings with large page origins.
    const [ox, oy] = points[0];
    return Math.abs(points.reduce((sum, [x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length];
      return sum + (x - ox) * (ny - oy) - (nx - ox) * (y - oy);
    }, 0)) / 2 * scale.unitsPerPoint ** 2;
  }
  const length = points.slice(1).reduce((sum, point, i) => sum + distance(points[i], point), 0);
  return (length + (kind === "Perimeter" ? distance(points.at(-1)!, points[0]) : 0)) * scale.unitsPerPoint;
}
export function measurementLabel(mark: Measurement): string {
  const value = measurementValue(mark);
  return mark.kind === "Count" ? `${value} count` : `${value.toFixed(2)} ${mark.scale.unit}${mark.kind === "Area" ? '²' : ''}`;
}

/** Compatibility entry point for callers exporting measurements alone. */
export async function exportMeasurements(bytes: Uint8Array, marks: Measurement[], order?: number[] | null) {
  return (await import('./drawingPdf')).exportDrawingPdf(bytes, { scales: {}, measurements: marks }, order);
}
