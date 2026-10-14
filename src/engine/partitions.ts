import type { DivisionPath, DivisionResult } from './divisions';
import type { SkeletonEdge, SkeletonResult } from './skeleton';
import type { GeometryRegion } from './regions';
import { pathData, pointDistance, regionContains, scaleRegion, unscalePoint } from './regions';
import type { Point } from './types';
import { usefulSkeletonEdges } from './skeleton-filter';

export interface PartitionConfig { minimumSectionWidthMm?: number }
export interface SkeletonSpan { edgeId: string; from: number; to: number }
export interface PartitionPath extends DivisionPath { regionId: string; sourceEdgeId: string; sourceRange: [number, number]; sourceSpans?: SkeletonSpan[]; lane: -1 | 0 | 1; closed: boolean; points: Point[] }
export interface PartitionResult extends DivisionResult { paths: PartitionPath[]; regions: GeometryRegion[] }
interface Sample { left: Point; right: Point; eligible: boolean }
interface BoundarySegment { a: Point; b: Point; minX: number; minY: number; maxX: number; maxY: number; centerX: number; centerY: number }
interface BoundaryNode { minX: number; minY: number; maxX: number; maxY: number; segments?: BoundarySegment[]; left?: BoundaryNode; right?: BoundaryNode }

function buildBoundaryIndex(region: GeometryRegion): BoundaryNode | null {
  const segments: BoundarySegment[] = [region.outer, ...region.holes].flatMap(loop => loop.map((a, i) => {
    const b = loop[(i + 1) % loop.length];
    return { a, b, minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y), centerX: (a.x + b.x) / 2, centerY: (a.y + b.y) / 2 };
  }));
  const build = (items: BoundarySegment[]): BoundaryNode => {
    const node: BoundaryNode = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const item of items) { node.minX = Math.min(node.minX, item.minX); node.minY = Math.min(node.minY, item.minY); node.maxX = Math.max(node.maxX, item.maxX); node.maxY = Math.max(node.maxY, item.maxY); }
    if (items.length <= 12) { node.segments = items; return node; }
    const splitX = node.maxX - node.minX >= node.maxY - node.minY;
    items.sort((a, b) => splitX ? a.centerX - b.centerX : a.centerY - b.centerY);
    const middle = items.length >> 1;
    node.left = build(items.slice(0, middle)); node.right = build(items.slice(middle));
    return node;
  };
  return segments.length ? build(segments) : null;
}

function nearestBoundaryDistance(point: Point, index: BoundaryNode | null | undefined): number {
  let bestSquared = Infinity;
  const boundsDistanceSquared = (node: BoundaryNode) => {
    const dx = point.x < node.minX ? node.minX - point.x : point.x > node.maxX ? point.x - node.maxX : 0;
    const dy = point.y < node.minY ? node.minY - point.y : point.y > node.maxY ? point.y - node.maxY : 0;
    return dx * dx + dy * dy;
  };
  const visit = (node: BoundaryNode | null | undefined) => {
    if (!node || boundsDistanceSquared(node) >= bestSquared) return;
    if (node.segments) {
      for (const { a, b } of node.segments) {
        const dx = b.x - a.x, dy = b.y - a.y, lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
        bestSquared = Math.min(bestSquared, (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2);
      }
      return;
    }
    const first = boundsDistanceSquared(node.left!) <= boundsDistanceSquared(node.right!) ? node.left : node.right;
    const second = first === node.left ? node.right : node.left;
    visit(first); visit(second);
  };
  visit(index);
  return Math.sqrt(bestSquared);
}

function polyline(edge: SkeletonEdge) {
  const points = edge.closed ? [...edge.points, edge.points[0]] : edge.points;
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + pointDistance(points[i - 1], points[i]));
  const length = distances.at(-1)!;
  const at = (position: number): Point => {
    const target = edge.closed ? (position % length + length) % length : Math.max(0, Math.min(length, position));
    let lo = 0, hi = points.length - 1;
    while (lo + 1 < hi) { const middle = (lo + hi) >> 1; if (distances[middle] <= target) lo = middle; else hi = middle; }
    const fraction = (target - distances[lo]) / (distances[hi] - distances[lo] || 1);
    return { x: points[lo].x + (points[hi].x - points[lo].x) * fraction, y: points[lo].y + (points[hi].y - points[lo].y) * fraction };
  };
  return { at, length, points, distances };
}

interface SourceSection { edgeId: string; offset: number; length: number; reversed: boolean }
interface GuideEdge extends SkeletonEdge { sourceSections: SourceSection[]; sourceOffset: number }

function sourceSpans(edge: GuideEdge, from: number, to: number): SkeletonSpan[] {
  const spans: SkeletonSpan[] = [];
  const length = edge.sourceSections.reduce((sum, section) => sum + section.length, 0);
  const start = from + edge.sourceOffset, end = to + edge.sourceOffset;
  for (let cycle = Math.floor(start / length); cycle <= Math.floor(end / length); cycle++) {
    for (const section of edge.sourceSections) {
      const origin = cycle * length + section.offset;
      const a = Math.max(start, origin) - origin, b = Math.min(end, origin + section.length) - origin;
      if (b - a <= 1e-7) continue;
      spans.push({ edgeId: section.edgeId, from: section.reversed ? section.length - b : a, to: section.reversed ? section.length - a : b });
    }
  }
  return spans;
}

/** Keep original junctions as guide boundaries after pruning corner spokes.
 * A pruned spoke must not turn a junction into a false degree-two continuation. */
function guideEdges(skeleton: SkeletonResult): GuideEdge[] {
  const nodes = new Map(skeleton.nodes.map(node => [node.id, node]));
  const edges = usefulSkeletonEdges(skeleton);
  const originalIncident = new Map<string, SkeletonEdge[]>();
  for (const edge of skeleton.edges) for (const id of [edge.from, edge.to]) if (id) originalIncident.set(id, [...(originalIncident.get(id) ?? []), edge]);
  const originalDegree = (id: string | null) => id ? originalIncident.get(id)?.length ?? 0 : 0;
  const incident = new Map<string, SkeletonEdge[]>();
  for (const edge of edges) for (const id of [edge.from, edge.to]) if (id) incident.set(id, [...(incident.get(id) ?? []), edge]);
  const used = new Set<string>(), guides: GuideEdge[] = [];
  const walk = (seed: SkeletonEdge, start: string | null) => {
    if (used.has(seed.id)) return;
    let current = seed, node = start, end: string | null = start;
    const points: Point[] = [];
    const sourceSections: SourceSection[] = [];
    let offset = 0;
    let closed = seed.closed;
    while (!used.has(current.id)) {
      used.add(current.id);
      const forward = current.from === node;
      const part = forward ? current.points : [...current.points].reverse();
      const length = polyline(current).length;
      sourceSections.push({ edgeId: current.id, offset, length, reversed: !forward });
      offset += length;
      points.push(...(points.length ? part.slice(1) : part));
      end = forward ? current.to : current.from;
      if (current.closed || (end && end === start)) { closed = true; break; }
      const next = end ? incident.get(end) ?? [] : [];
      if (originalDegree(end) !== 2 || next.length !== 2) break;
      const continuation = next.find(edge => !used.has(edge.id));
      if (!continuation) break;
      node = end; current = continuation;
    }
    if (closed && pointDistance(points[0], points.at(-1)!) < 1e-6) points.pop();
    let guide: GuideEdge = { ...seed, from: start, to: end, points, closed, sourceSections, sourceOffset: 0 };
    if (!closed) {
      const line = polyline(guide);
      const trim = (id: string | null) => id && originalDegree(id) > 2 ? (nodes.get(id)?.radius ?? 0) * 0.8 : 0;
      const from = trim(start), to = line.length - trim(end);
      if (to <= from) return;
      if (from || to < line.length) {
        guide = { ...guide, sourceOffset: from, points: [line.at(from), ...line.points.filter((_, i) => line.distances[i] > from && line.distances[i] < to), line.at(to)] };
      }
    }
    guides.push(guide);
  };
  for (const edge of edges) if (!edge.closed) {
    if (!edge.from || originalDegree(edge.from) !== 2) walk(edge, edge.from);
    else if (!edge.to || originalDegree(edge.to) !== 2) walk(edge, edge.to);
  }
  for (const edge of edges) walk(edge, edge.from);
  return guides;
}

function simplifyGuide(points: Point[], tolerance: number): Point[] {
  const keep = new Set([0, points.length - 1]), pending: [number, number][] = [[0, points.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!, a = points[first], b = points[last];
    const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    let maximum = tolerance, farthest = -1;
    for (let i = first + 1; i < last; i++) {
      const p = points[i], t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared)) : 0;
      const distance = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
      if (distance > maximum) { maximum = distance; farthest = i; }
    }
    if (farthest >= 0) { keep.add(farthest); pending.push([first, farthest], [farthest, last]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}

/** Remove offset loops at tight concave turns instead of drawing backtracking spikes. */
function cleanGuide(input: Point[], closed: boolean, tolerance: number): Point[] {
  let points = simplifyGuide(closed ? [...input, input[0]] : input, tolerance);
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 2; j < points.length - 1; j++) {
      const a = points[i], b = points[i + 1], c = points[j], d = points[j + 1];
      const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
      const determinant = ux * vy - uy * vx;
      if (Math.abs(determinant) < 1e-9) continue;
      const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / determinant;
      const s = ((c.x - a.x) * uy - (c.y - a.y) * ux) / determinant;
      if (t <= 1e-6 || t >= 1 - 1e-6 || s <= 1e-6 || s >= 1 - 1e-6) continue;
      const intersection = { x: a.x + ux * t, y: a.y + uy * t };
      points.splice(i + 1, j - i, intersection);
      i = Math.max(-1, i - 1); break;
    }
  }
  if (closed) points.pop();
  return points;
}

/** Remove candidate guides that cross another guide inside the same geometry region. */
export function filterCrossingPartitionPaths(paths: PartitionPath[]): { paths: PartitionPath[]; removed: number } {
  let pointCount = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const path of paths) for (const point of path.points) {
    pointCount++;
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  if (pointCount < 4) return { paths, removed: 0 };
  const cellSize = Math.max(maxX - minX, maxY - minY, 1e-6) / 512;
  const buckets = new Map<string, number[]>(), checked = new Set<string>(), crossingPaths = new Set<number>();
  const segments: Array<{ path: number; index: number; count: number; closed: boolean; regionId: string; a: Point; b: Point; minX: number; maxX: number; minY: number; maxY: number }> = [];
  const crossAt = (a: Point, b: Point, c: Point, d: Point) => {
    const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
    const denominator = ux * vy - uy * vx;
    if (Math.abs(denominator) < 1e-10) return false;
    const dx = c.x - a.x, dy = c.y - a.y;
    const t = (dx * vy - dy * vx) / denominator, u = (dx * uy - dy * ux) / denominator;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  };

  for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
    const path = paths[pathIndex], points = path.closed ? [...path.points, path.points[0]] : path.points;
    const count = points.length - 1;
    for (let index = 0; index < count; index++) {
      const a = points[index], b = points[index + 1];
      const segment = { path: pathIndex, index, count, closed: path.closed, regionId: path.regionId, a, b,
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
      const id = segments.length, x0 = Math.floor(segment.minX / cellSize), x1 = Math.floor(segment.maxX / cellSize);
      const y0 = Math.floor(segment.minY / cellSize), y1 = Math.floor(segment.maxY / cellSize), candidates = new Set<number>();
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (const other of buckets.get(`${x},${y}`) ?? []) candidates.add(other);
      for (const otherId of candidates) {
        const other = segments[otherId];
        if (other.regionId !== segment.regionId) continue;
        if (other.path === segment.path) {
          const adjacent = Math.abs(other.index - segment.index) <= 1 ||
            (segment.closed && Math.abs(other.index - segment.index) === segment.count - 1);
          if (adjacent) continue;
        }
        const pair = `${Math.min(id, otherId)}:${Math.max(id, otherId)}`;
        if (checked.has(pair)) continue;
        checked.add(pair);
        if (crossAt(other.a, other.b, segment.a, segment.b)) {
          crossingPaths.add(other.path); crossingPaths.add(segment.path);
        }
      }
      segments.push(segment);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`, bucket = buckets.get(key) ?? [];
        bucket.push(id); buckets.set(key, bucket);
      }
    }
  }
  return { paths: paths.filter((_, index) => !crossingPaths.has(index)), removed: crossingPaths.size };
}

/** Create candidate guides halfway from the medial skeleton to each nearest boundary. */
export function generatePartitions(skeleton: SkeletonResult, config: PartitionConfig = {}): PartitionResult {
  const minimumSectionWidthMm = config.minimumSectionWidthMm ?? 0;
  if (!Number.isFinite(minimumSectionWidthMm) || minimumSectionWidthMm < 0) throw new Error('El ancho mínimo local debe ser un valor positivo o cero.');
  const result: PartitionResult = { paths: [], regions: skeleton.regions, pairs: 0, warnings: [...skeleton.warnings] };
  if (skeleton.units !== 'mm') { result.warnings.push('Indica ancho y alto físicos del SVG para generar Partidas.'); return result; }

  const spacing = Math.max(0.25, Math.min(1, skeleton.resolution * 2));
  const scaledRegions = new Map(skeleton.regions.map(region => [region.id, scaleRegion(region, skeleton.scale)]));
  const boundaryIndexes = new Map([...scaledRegions].map(([id, region]) => [id, buildBoundaryIndex(region)]));
  for (const edge of guideEdges(skeleton)) {
    const sourceRegion = skeleton.regions.find(region => region.id === edge.regionId);
    const region = scaledRegions.get(edge.regionId), boundaryIndex = boundaryIndexes.get(edge.regionId);
    if (!sourceRegion || !region) continue;
    const line = polyline(edge);
    if (!(line.length > 1e-8)) continue;
    const count = Math.max(2, Math.ceil(line.length / spacing));
    const step = line.length / count;
    const samples: Sample[] = Array.from({ length: edge.closed ? count : count + 1 }, (_, i) => {
      const at = i * step;
      // Average only raster-scale noise; geometry and sharp turns remain local.
      const center = [-2, -1, 0, 1, 2].reduce((sum, offset) => {
        const point = line.at(at + offset * skeleton.resolution), weight = 3 - Math.abs(offset);
        return { x: sum.x + point.x * weight / 9, y: sum.y + point.y * weight / 9 };
      }, { x: 0, y: 0 });
      const radius = nearestBoundaryDistance(center, boundaryIndex);
      const probe = Math.max(skeleton.resolution * 8, radius * 1.2, spacing * 2);
      // Smooth raster tangent jitter before measuring the two local boundaries.
      let tx = 0, ty = 0;
      for (let t = -4; t <= 4; t++) { const p = line.at(at + t * probe / 4); tx += t * (p.x - center.x); ty += t * (p.y - center.y); }
      const magnitude = Math.hypot(tx, ty);
      const normal = magnitude > 1e-8 ? { x: -ty / magnitude, y: tx / magnitude } : { x: 0, y: 0 };
      const eligible = magnitude > 1e-8 && regionContains(center, region) && radius > skeleton.resolution && radius + 1e-6 >= minimumSectionWidthMm;
      return {
        left: { x: center.x - normal.x * radius / 2, y: center.y - normal.y * radius / 2 },
        right: { x: center.x + normal.x * radius / 2, y: center.y + normal.y * radius / 2 },
        eligible,
      };
    });
    const segmentCount = edge.closed ? samples.length : samples.length - 1;

    for (const lane of [-1, 1] as const) {
      const key = lane === -1 ? 'left' : 'right';
      const validSegments = Array.from({ length: segmentCount }, (_, i) => {
        const a = samples[i], b = samples[(i + 1) % samples.length];
        if (!a.eligible || !b.eligible) return false;
        const p = a[key], q = b[key];
        const midpoint = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        return regionContains(midpoint, region);
      });

      const modes = validSegments.map(valid => valid ? 1 : -1);
      const start = edge.closed ? Math.max(0, modes.findIndex((mode, i) => mode !== modes[(i + segmentCount - 1) % segmentCount])) : 0;
      let runStart = start;
      for (let position = start + 1; position <= start + segmentCount; position++) {
        const atEnd = position === start + segmentCount;
        if (atEnd || modes[position % segmentCount] !== modes[runStart % segmentCount]) {
          if (modes[runStart % segmentCount] >= 0) {
            const indices = Array.from({ length: position - runStart + 1 }, (_, i) => runStart + i);
            const closed = edge.closed && position - runStart === segmentCount;
            const sampled = indices.map(i => samples[i % samples.length][key]);
            if (closed && sampled.length > samples.length) sampled.pop();
            const cleaned = cleanGuide(sampled, closed, skeleton.resolution * 0.45);
            const points = cleaned.map(point => unscalePoint(point, skeleton.scale));
            if (points.length >= (closed ? 3 : 2)) result.paths.push({ id: `${edge.id}-part-${result.paths.length}`, figureId: edge.figureId,
              regionId: edge.regionId, outerContourId: sourceRegion.outerContourId, innerContourId: sourceRegion.holeContourIds[0] ?? '',
              sourceEdgeId: edge.id, sourceRange: [indices[0] * step, indices.at(-1)! * step], index: lane === -1 ? 1 : 2,
              sourceSpans: sourceSpans(edge, indices[0] * step, indices.at(-1)! * step),
              fraction: lane === -1 ? 0.25 : 0.75, lane, closed, points, d: pathData(points, closed) });
          }
          runStart = position;
        }
      }
    }
  }
  const crossingFree = filterCrossingPartitionPaths(result.paths);
  result.paths = crossingFree.paths;
  if (crossingFree.removed) result.warnings.push(`${crossingFree.removed} partida(s) eliminada(s): las guías se cruzaban entre sí.`);
  result.pairs = result.paths.filter(path => path.lane === -1).length;
  return result;
}
