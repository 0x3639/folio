import type { DrawingData, Measurement, Point } from './measurements';
import type { StoredMark } from './recent';
export type ReviewStatus = 'Open' | 'Answered' | 'Resolved';
export interface ReviewMeta {
  author: string; discipline: string; status: ReviewStatus; subject: string;
  replies: { text: string; author: string; at: number }[];
  locked?: boolean; group?: string;
}
export interface ReviewStyle {
  color: string; fill: string; width: number; opacity: number;
  dash: 'solid' | 'dashed' | 'dotted'; fontSize: number; font: 'sans' | 'serif' | 'mono'; arrow: boolean;
}
export type ReviewKind = 'Callout' | 'Cloud callout' | 'Text' | 'Stamp' | 'Line' | 'Arrow' | 'Rectangle' | 'Oval' | 'Cloud' | 'Polygon';
export interface ReviewMark {
  id: string; page: number; kind: ReviewKind; points: Point[]; text: string; style: ReviewStyle; createdAt: number;
}
export interface ToolPreset { points?: Point[]; id: string; name: string; kind: ReviewKind; text: string; style: ReviewStyle; discipline: string }
export const defaultStyle: ReviewStyle = { color: '#e5533d', fill: 'none', width: 1.5, opacity: 1, dash: 'solid', fontSize: 12, font: 'sans', arrow: true };
export const defaultMeta = (): ReviewMeta => ({ author: '', discipline: '', status: 'Open', subject: '', replies: [] });
export const reviewKinds: ReviewKind[] = ['Callout', 'Cloud callout', 'Text', 'Stamp', 'Line', 'Arrow', 'Rectangle', 'Oval', 'Cloud', 'Polygon'];
export const metaFor = (data: DrawingData, id: string): ReviewMeta => ({ ...defaultMeta(), ...data.reviewMeta?.[id] });
export function bounds(points: Point[]) {
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] as [number, number, number, number];
}
export function movePoints(points: Point[], dx: number, dy: number): Point[] { return points.map(([x, y]) => [x + dx, y + dy]); }
export function arrowWings(a: Point, b: Point, size: number): Point[] {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return [[b[0] - size * Math.cos(angle - .5), b[1] - size * Math.sin(angle - .5)], b,
    [b[0] - size * Math.cos(angle + .5), b[1] - size * Math.sin(angle + .5)]];
}
export function cloudPoints(a: Point, b: Point): Point[] {
  const [l, d, r, t] = bounds([a, b]);
  const corners: Point[] = [[l, d], [r, d], [r, t], [l, t], [l, d]];
  const points: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const p = corners[i], q = corners[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
    if (!length) continue;
    const count = Math.max(1, Math.ceil(length / 12));
    for (let j = 0; j < count; j++) for (let k = 0; k <= 8; k++) {
      const along = (j + k / 8) / count, bulge = Math.sin(k / 8 * Math.PI) * length / count / 3;
      points.push([p[0] + dx * along + dy / length * bulge, p[1] + dy * along - dx / length * bulge]);
    }
  }
  return points;
}
export interface ReviewRow { id: string; page: number; kind: string; text: string; source: 'review' | 'measurement' | 'annotation' | 'pdf'; createdAt: number; meta: ReviewMeta }
export function reviewRows(data: DrawingData, marks: StoredMark[], label: (m: Measurement) => string): ReviewRow[] {
  return [
    ...(data.review ?? []).map(m => ({ id: m.id, page: m.page, kind: m.kind, text: m.text, source: 'review' as const, createdAt: m.createdAt, meta: metaFor(data, m.id) })),
    ...data.measurements.map(m => ({ id: m.id, page: m.page, kind: m.kind, text: label(m), source: 'measurement' as const, createdAt: 0, meta: metaFor(data, m.id) })),
    ...marks.map(m => ({ id: m.id, page: m.page, kind: String(m.data.subtype ?? m.shape ?? m.type), text: m.note || m.text, source: m.data.external ? 'pdf' as const : 'annotation' as const, createdAt: m.createdAt, meta: metaFor(data, m.id) })),
  ].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}
export function reviewCsv(rows: ReviewRow[]): string {
  // A CSV opened in a spreadsheet must treat comments as text, not formulas.
  const cell = (value: unknown) => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, s => "'" + s).replaceAll('"', '""') + '"';
  return [['Sheet', 'Type', 'Subject', 'Comment', 'Author', 'Discipline', 'Status', 'Replies'], ...rows.map(r => [r.page + 1, r.kind, r.meta.subject, r.text, r.meta.author, r.meta.discipline, r.meta.status, r.meta.replies.map(p => `${p.author}: ${p.text}`).join('\n')])].map(row => row.map(cell).join(',')).join('\r\n');
}
export function validateReviewMark(value: unknown, pages: number): value is ReviewMark {
  const m = value as ReviewMark;
  if (!m || typeof m.id !== 'string' || m.id.length > 200 || !reviewKinds.includes(m.kind) || !Number.isInteger(m.page) || m.page < 0 || m.page >= pages || typeof m.text !== 'string' || m.text.length > 10000 || !Array.isArray(m.points) || m.points.length < 2 || m.points.length > 5000) return false;
  if (!m.points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && Math.abs(v) < 1e7))) return false;
  const s = m.style;
  return !!s && /^#[\da-f]{6}$/i.test(s.color) && (s.fill === 'none' || /^#[\da-f]{6}$/i.test(s.fill)) && Number.isFinite(s.width) && s.width >= .1 && s.width <= 20 && Number.isFinite(s.opacity) && s.opacity >= .05 && s.opacity <= 1 && Number.isFinite(s.fontSize) && s.fontSize >= 6 && s.fontSize <= 96 && ['sans', 'serif', 'mono'].includes(s.font) && ['solid', 'dashed', 'dotted'].includes(s.dash);
}
export const starterTools: ToolPreset[] = [
  { id: 'verify', name: 'Verify dimension', kind: 'Callout', text: 'Verify dimension', style: { ...defaultStyle }, discipline: '' },
  { id: 'coordinate', name: 'Coordinate with structural', kind: 'Cloud callout', text: 'Coordinate with structural', style: { ...defaultStyle, color: '#2f6fed' }, discipline: 'Structural' },
  { id: 'reviewed', name: 'Reviewed stamp', kind: 'Stamp', text: 'REVIEWED', style: { ...defaultStyle, color: '#1f9d55', fontSize: 18 }, discipline: '' },
];
export function readToolPresets(): ToolPreset[] {
  try {
    const values = JSON.parse(localStorage.getItem('folio:review-tools') || '[]');
    return [...starterTools, ...(Array.isArray(values) ? values.filter((p: ToolPreset) => p && typeof p.name === 'string' && typeof p.discipline === 'string' && validateReviewMark({ ...p, page: 0, points: p.points ?? [[0, 0], [1, 1]] }, 1)).slice(0, 100) : [])];
  } catch { return [...starterTools]; }
}

export interface ReviewGeometry { paths: { points: Point[]; closed?: boolean; fill?: string }[]; lines: { point: Point; text: string }[]; rect: [number, number, number, number] }
export function wrapReviewText(text: string, width: number, size: number): string[] {
  const limit = Math.max(4, Math.floor(width / (size * .62)));
  return text.split('\n').flatMap(line => {
    const lines: string[] = []; let current = '';
    for (const word of line.split(/\s+/)) {
      if (current && current.length + word.length + 1 > limit) { lines.push(current); current = ''; }
      for (let i = 0; i < word.length; i += limit) {
        const part = word.slice(i, i + limit);
        if (i) { lines.push(current); current = ''; }
        current += (current ? ' ' : '') + part;
      }
    }
    return [...lines, current];
  });
}
export function reviewGeometry(mark: ReviewMark): ReviewGeometry {
  const { points: p, kind, style: s } = mark;
  const paths: ReviewGeometry['paths'] = [], lines: ReviewGeometry['lines'] = [];
  const box = bounds(p.slice(0, 2)), [l, b, r, t] = box;
  const rectangle: Point[] = [[l, b], [r, b], [r, t], [l, t]];
  if (kind === 'Rectangle' || kind === 'Text' || kind === 'Stamp') paths.push({ points: rectangle, closed: true, fill: s.fill });
  if (kind === 'Cloud' || kind === 'Cloud callout') paths.push({ points: cloudPoints(p[0], p[1]), closed: true, fill: s.fill });
  if (kind === 'Oval') paths.push({ points: Array.from({ length: 64 }, (_, i): Point => [(l + r) / 2 + (r - l) / 2 * Math.cos(i * Math.PI / 32), (b + t) / 2 + (t - b) / 2 * Math.sin(i * Math.PI / 32)]), closed: true, fill: s.fill });
  if (kind === 'Polygon') paths.push({ points: p, closed: true, fill: s.fill });
  if (kind === 'Line' || kind === 'Arrow') {
    paths.push({ points: p });
    if (kind === 'Arrow' || s.arrow) paths.push({ points: arrowWings(p[0], p[1], Math.max(6, s.width * 4)) });
  }
  let textOrigin: Point | undefined, width = 150;
  if (kind === 'Callout' || kind === 'Cloud callout') {
    textOrigin = p[2] ?? [r + 30, t + 30];
    const tip: Point = kind === 'Callout' ? p[0] : [r, (b + t) / 2];
    const elbow: Point = kind === 'Callout' ? p[1] : [textOrigin[0] - 15, textOrigin[1] - 8];
    paths.push({ points: [tip, elbow, [textOrigin[0], textOrigin[1] - 8]] });
    if (s.arrow) paths.push({ points: arrowWings(elbow, tip, Math.max(6, s.width * 4)) });
  } else if (kind === 'Text' || kind === 'Stamp') { textOrigin = [l + 5, t - 5]; width = Math.max(20, r - l - 10); }
  if (textOrigin) {
    const textLines = wrapReviewText(mark.text, width, s.fontSize);
    textLines.forEach((text, i) => lines.push({ point: [textOrigin![0], textOrigin![1] - s.fontSize * (i * 1.25 + 1)], text }));
    if (kind === 'Callout' || kind === 'Cloud callout') {
      const x = textOrigin[0] - 4, y = textOrigin[1] + 4, bottom = textOrigin[1] - textLines.length * s.fontSize * 1.25 - 3;
      paths.push({ points: [[x, y], [x + width + 8, y], [x + width + 8, bottom], [x, bottom]], closed: true, fill: s.fill });
    }
  }
  const all: Point[] = [...paths.flatMap(path => path.points), ...lines.flatMap(line => [line.point, [line.point[0] + width, line.point[1] + s.fontSize] as Point])];
  const rect = bounds(all.length ? all : p);
  const pad = Math.max(2, s.width * 2);
  return { paths, lines, rect: [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad] };
}
