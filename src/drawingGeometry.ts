import type { Point } from './measurements';
export function snapPoint(point: Point, candidates: Point[], tolerance: number, anchor?: Point, constrain = false): { point: Point; snapped: boolean } {
  if (constrain && anchor) {
    const angle = Math.round(Math.atan2(point[1] - anchor[1], point[0] - anchor[0]) / (Math.PI / 4)) * Math.PI / 4;
    const length = Math.hypot(point[0] - anchor[0], point[1] - anchor[1]);
    return { point: [anchor[0] + length * Math.cos(angle), anchor[1] + length * Math.sin(angle)], snapped: false };
  }
  let nearest = point, best = tolerance;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate[0] - point[0], candidate[1] - point[1]);
    if (distance < best) { nearest = candidate; best = distance; }
  }
  return { point: [...nearest], snapped: nearest !== point };
}

export function alignRevision(target: Point[], source: Point[]): number[] {
  const sx = source[1][0] - source[0][0], sy = source[1][1] - source[0][1], tx = target[1][0] - target[0][0], ty = target[1][1] - target[0][1];
  const denominator = sx * sx + sy * sy;
  if (denominator < 1 || Math.hypot(tx, ty) < 1) throw new Error('Choose two distinct reference points on each sheet.');
  const a = (tx * sx + ty * sy) / denominator, b = (ty * sx - tx * sy) / denominator;
  return [a, b, -b, a, target[0][0] - a * source[0][0] + b * source[0][1], target[0][1] - b * source[0][0] - a * source[0][1]];
}
