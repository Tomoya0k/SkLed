import type { Figure, Point } from './types';

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

export function buildRegions(figures: Figure[]): { regions: GeometryRegion[]; warnings: string[] } {
  const warnings: string[] = [];
  const contours = figures.flatMap(f => f.contours);
  const closed = contours.filter(c => c.closed || pointDistance(c.start, c.end) < 1e-6);
  if (closed.length < contours.length) warnings.push(`${contours.length - closed.length} contorno(s) abierto(s) no tienen superficie interior.`);
  const samples = closed.map(contour => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', contour.d);
    const count = Math.min(6000, Math.max(256, Math.ceil(contour.length / Math.max(contour.length / 2400, 0.01))));
    const points = Array.from({ length: count }, (_, i) => { const p = path.getPointAtLength(contour.length * i / count); return { x: p.x, y: p.y }; });
    const area = Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % count]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2);
    return { contour, points, area, parent: -1, depth: 0 };
  });
  for (const item of samples) {
    let smallest = Infinity;
    samples.forEach((candidate, i) => {
      if (candidate.area > item.area * 1.000001 && candidate.area < smallest && item.points.every((p, j) => j % 24 !== 0 || polygonContains(p, candidate.points))) {
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
