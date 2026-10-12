import type { Figure, Point } from './types';
import svgpath from 'svgpath';

/** Region boundaries in root SVG coordinates. Nested paths retain the importer's hole convention. */
export interface GeometryRegion {
  id: string;
  figureId: string;
  outerContourId: string;
  holeContourIds: string[];
  outer: Point[];
  holes: Point[][];
}
export interface GeometryScale { x: number; y: number }
export const pointDistance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const scalePoint = (p: Point, s: GeometryScale): Point => ({ x: p.x * s.x, y: p.y * s.y });
export const unscalePoint = (p: Point, s: GeometryScale): Point => ({ x: p.x / s.x, y: p.y / s.y });
export const pathData = (points: Point[], closed = false) => points.length ? `M ${points.map(p => `${Number(p.x.toFixed(6))} ${Number(p.y.toFixed(6))}`).join(' L ')}${closed ? ' Z' : ''}` : '';

export function polygonContains(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export const regionContains = (p: Point, region: GeometryRegion) => polygonContains(p, region.outer) && !region.holes.some(hole => polygonContains(p, hole));
export const scaleRegion = (region: GeometryRegion, scale: GeometryScale): GeometryRegion => ({ ...region,
  outer: region.outer.map(p => scalePoint(p, scale)), holes: region.holes.map(hole => hole.map(p => scalePoint(p, scale))),
});

/** Adaptive Bézier flattening is usable in a worker and avoids thousands of
 * synchronous browser getPointAtLength calls on every imported contour. */
export function contourPolygon(d: string, tolerance: number): Point[] {
  const points: Point[] = [];
  const append = (p: Point) => { if (!points.length || pointDistance(points.at(-1)!, p) > 1e-9) points.push(p); };
  const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const cubic = (a: Point, b: Point, c: Point, end: Point, depth = 0) => {
    const length = pointDistance(a, end);
    const toChord = (p: Point) => length ? Math.abs((end.x - a.x) * (p.y - a.y) - (end.y - a.y) * (p.x - a.x)) / length : pointDistance(a, p);
    const excess = pointDistance(a, b) + pointDistance(b, c) + pointDistance(c, end) - length;
    if (depth >= 16 || (Math.max(toChord(b), toChord(c)) <= tolerance && excess <= tolerance * 2)) { append(end); return; }
    const ab = middle(a, b), bc = middle(b, c), ce = middle(c, end), abc = middle(ab, bc), bce = middle(bc, ce), center = middle(abc, bce);
    cubic(a, ab, abc, center, depth + 1); cubic(center, bce, ce, end, depth + 1);
  };
  svgpath(d).abs().unshort().unarc().iterate((segment, _index, x, y) => {
    switch (segment[0]) {
      case 'M': case 'L': append({ x: segment[1], y: segment[2] }); break;
      case 'H': append({ x: segment[1], y }); break;
      case 'V': append({ x, y: segment[1] }); break;
      case 'C': cubic({ x, y }, { x: segment[1], y: segment[2] }, { x: segment[3], y: segment[4] }, { x: segment[5], y: segment[6] }); break;
      case 'Q': {
        const control = { x: segment[1], y: segment[2] }, end = { x: segment[3], y: segment[4] };
        cubic({ x, y }, { x: x + (control.x - x) * 2 / 3, y: y + (control.y - y) * 2 / 3 }, { x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3 }, end);
        break;
      }
    }
  });
  if (points.length > 1 && pointDistance(points[0], points.at(-1)!) < 1e-9) points.pop();
  return points;
}

export function buildRegions(figures: Figure[]): { regions: GeometryRegion[]; warnings: string[] } {
  const warnings: string[] = [];
  const contours = figures.flatMap(f => f.contours);
  const closed = contours.filter(c => c.closed || pointDistance(c.start, c.end) < 1e-6);
  if (closed.length < contours.length) warnings.push(`${contours.length - closed.length} contorno(s) abierto(s) no tienen superficie interior.`);
  const samples = closed.map(contour => {
    const points = contourPolygon(contour.d, Math.max(0.001, Math.min(0.05, contour.length / 50000)));
    const area = Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2);
    return { contour, points, area, parent: -1, depth: 0 };
  });
  for (const item of samples) {
    let smallest = Infinity;
    samples.forEach((candidate, i) => {
      const stride = Math.max(1, Math.floor(item.points.length / 100));
      if (candidate.area > item.area * 1.000001 && candidate.area < smallest && item.points.every((p, j) => j % stride !== 0 || polygonContains(p, candidate.points))) {
        // Adaptive polygons have few vertices on long straight sides. Check
        // crossings too, so a hole cannot jump across a concave outer notch.
        const crosses = item.points.some((a, i) => {
          const b = item.points[(i + 1) % item.points.length];
          return candidate.points.some((c, j) => {
            const d = candidate.points[(j + 1) % candidate.points.length];
            return Math.max(a.x, b.x) >= Math.min(c.x, d.x) && Math.max(c.x, d.x) >= Math.min(a.x, b.x) && Math.max(a.y, b.y) >= Math.min(c.y, d.y) && Math.max(c.y, d.y) >= Math.min(a.y, b.y) && segmentsCross(a, b, c, d);
          });
        });
        if (crosses) return;
        item.parent = i; smallest = candidate.area;
      }
    });
  }
  for (const item of samples) { for (let p = item.parent; p >= 0; p = samples[p].parent) item.depth++; }
  const regions = samples.flatMap((item, i) => {
    if (item.depth % 2) return [];
    const holes = samples.filter(child => child.parent === i);
    return [{ id: `region-${item.contour.id}`, figureId: item.contour.figureId, outerContourId: item.contour.id,
      holeContourIds: holes.map(h => h.contour.id), outer: item.points, holes: holes.map(h => h.points) }];
  });
  return { regions, warnings };
}

/** Nearest crossings on both sides of a normal, never stepping across a hole. */
export function transverseSection(p: Point, normal: Point, region: GeometryRegion): { left: number; right: number; width: number; center: Point } | null {
  let left = Infinity, right = Infinity;
  for (const loop of [region.outer, ...region.holes]) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const vx = b.x - a.x, vy = b.y - a.y;
    const denominator = normal.x * vy - normal.y * vx;
    if (Math.abs(denominator) < 1e-12) continue;
    const dx = a.x - p.x, dy = a.y - p.y;
    const t = (dx * vy - dy * vx) / denominator;
    const u = (dx * normal.y - dy * normal.x) / denominator;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (t >= 0) right = Math.min(right, t); else left = Math.min(left, -t);
  }
  if (!Number.isFinite(left + right)) return null;
  return { left, right, width: left + right, center: { x: p.x + normal.x * (right - left) / 2, y: p.y + normal.y * (right - left) / 2 } };
}

export function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
}
