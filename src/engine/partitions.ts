import type { DivisionPath, DivisionResult } from './divisions';
import type { SkeletonEdge, SkeletonResult } from './skeleton';
import type { GeometryRegion } from './regions';
import { pathData, pointDistance, regionContains, scaleRegion, segmentsCross, transverseSection, unscalePoint } from './regions';
import type { Point } from './types';
import { filterPartitionsForBody } from './partition-fit';

export interface PartitionConfig { moduleWidthMm: number; freeGapMm: number; edgeMarginMm: number; maxLanes: 1 | 2; moduleLengthMm?: number }
export interface PartitionPath extends DivisionPath { regionId: string; sourceEdgeId: string; sourceRange: [number, number]; lane: -1 | 0 | 1; closed: boolean; points: Point[] }
export interface PartitionResult extends DivisionResult { paths: PartitionPath[]; regions: GeometryRegion[]; requiredWidthMm: number }
interface Sample { at: number; center: Point; left: Point; right: Point; doubled: boolean }

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
  return { at, length };
}

/** Independent open/closed lanes. No connector is ever generated at a change in lane count. */
export function generatePartitions(skeleton: SkeletonResult, config: PartitionConfig): PartitionResult {
  if (config.moduleLengthMm !== undefined && !(Number.isFinite(config.moduleLengthMm) && config.moduleLengthMm > 0)) throw new Error('El largo del módulo debe ser mayor que cero.');
  if (!(Number.isFinite(config.moduleWidthMm) && config.moduleWidthMm > 0) || ![config.freeGapMm, config.edgeMarginMm].every(n => Number.isFinite(n) && n >= 0) || ![1, 2].includes(config.maxLanes)) throw new Error('Revisa ancho, separación, margen y máximo de recorridos.');
  const requiredWidthMm = 2 * config.moduleWidthMm + config.freeGapMm + 2 * config.edgeMarginMm;
  const result: PartitionResult = { paths: [], regions: skeleton.regions, requiredWidthMm, pairs: 0, warnings: [...skeleton.warnings] };
  const groupKey = (path: PartitionPath) => `${path.sourceEdgeId}:${path.sourceRange.join(':')}`;
  const fallbacks = new Map<string, PartitionPath>();
  if (skeleton.units !== 'mm') { result.warnings.push('Indica ancho y alto físicos del SVG para generar Partidas.'); return result; }
  const nodes = new Map(skeleton.nodes.map(n => [n.id, n]));
  const spacing = config.moduleLengthMm ? Math.max(0.5, Math.min(2, config.moduleLengthMm / 30)) : Math.max(0.25, Math.min(1, skeleton.resolution * 2));
  for (const edge of skeleton.edges) {
    const sourceRegion = skeleton.regions.find(r => r.id === edge.regionId)!;
    const region = scaleRegion(sourceRegion, skeleton.scale);
    const line = polyline(edge);
    if (!(line.length > 1e-8)) continue;
    const count = Math.max(2, Math.ceil(line.length / spacing));
    const step = line.length / count;
    const probe = Math.max(skeleton.resolution * 8, config.moduleWidthMm);
    const fromJunction = edge.from && nodes.get(edge.from)?.kind === 'junction';
    const toJunction = edge.to && nodes.get(edge.to)?.kind === 'junction';
    // Two nearby junctions must not consume the entire usable span between them.
    // Terminal corner branches retain the full guard; their diagonal width is not a corridor.
    const junctionGuard = fromJunction && toJunction ? Math.min(requiredWidthMm / 2, line.length * 0.15) : requiredWidthMm / 2;
    const samples: Sample[] = Array.from({ length: edge.closed ? count : count + 1 }, (_, i) => {
      const at = i * step, center = line.at(at);
      // Local linear regression suppresses raster tangent jitter without changing the medial graph.
      let tx = 0, ty = 0;
      for (let t = -4; t <= 4; t++) { const p = line.at(at + t * probe / 4); tx += t * (p.x - center.x); ty += t * (p.y - center.y); }
      const magnitude = Math.hypot(tx, ty);
      const normal = magnitude > 1e-8 ? { x: -ty / magnitude, y: tx / magnitude } : { x: 0, y: 0 };
      const section = magnitude > 1e-8 ? transverseSection(center, normal, region) : null;
      let doubled = config.maxLanes === 2 && !!section && section.width + 1e-6 >= requiredWidthMm &&
        (!fromJunction || at >= junctionGuard) && (!toJunction || line.length - at >= junctionGuard);
      const extra = section ? Math.max(0, section.width - requiredWidthMm) / 3 : 0;
      const offset = (config.moduleWidthMm + config.freeGapMm + extra) / 2;
      const middle = section?.center ?? center;
      const left = { x: middle.x - normal.x * offset, y: middle.y - normal.y * offset };
      const right = { x: middle.x + normal.x * offset, y: middle.y + normal.y * offset };
      if (doubled) for (const p of [left, right]) for (const sign of [-1, 1]) {
        const half = config.moduleWidthMm / 2 + Math.max(0, config.edgeMarginMm - 1e-5);
        if (!regionContains({ x: p.x + normal.x * sign * half, y: p.y + normal.y * sign * half }, region)) doubled = false;
      }
      // A wide cross-section is insufficient at a spike or bend: the entire
      // physical body, including its edge margin, must fit along each lane.
      if (doubled && config.moduleLengthMm && magnitude > 1e-8) {
        const tangent = { x: tx / magnitude, y: ty / magnitude };
        const halfLength = config.moduleLengthMm / 2 + config.edgeMarginMm;
        const halfWidth = config.moduleWidthMm / 2 + config.edgeMarginMm;
        for (const p of [left, right]) for (const along of [-halfLength, 0, halfLength]) for (const across of [-halfWidth, halfWidth]) {
          if (!regionContains({ x: p.x + tangent.x * along + normal.x * across, y: p.y + tangent.y * along + normal.y * across }, region)) doubled = false;
        }
      }
      return { at, center, left, right, doubled };
    });
    const segmentCount = edge.closed ? samples.length : samples.length - 1;
    const doubleSegments = Array.from({ length: segmentCount }, (_, i) => samples[i].doubled && samples[(i + 1) % samples.length].doubled);
    // Reject offset foldovers and intersections; return those spans to the original centerline.
    for (let i = 0; i < segmentCount; i++) {
      if (!doubleSegments[i]) continue;
      const a = samples[i], b = samples[(i + 1) % samples.length];
      for (const side of ['left', 'right'] as const) {
        const p = a[side], q = b[side];
        if (!regionContains({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, region)) doubleSegments[i] = false;
        const forward = (q.x - p.x) * (b.center.x - a.center.x) + (q.y - p.y) * (b.center.y - a.center.y);
        if (forward <= 0) doubleSegments[i] = false;
      }
      if (segmentsCross(a.left, b.left, a.right, b.right)) doubleSegments[i] = false;
      for (let j = i + 2; j < segmentCount; j++) {
        if (!doubleSegments[j] || (edge.closed && i === 0 && j === segmentCount - 1)) continue;
        const c = samples[j], d = samples[(j + 1) % samples.length];
        if (segmentsCross(a.left, b.left, c.left, d.left) || segmentsCross(a.right, b.right, c.right, d.right) || segmentsCross(a.left, b.left, c.right, d.right) || segmentsCross(a.right, b.right, c.left, d.left)) doubleSegments[i] = doubleSegments[j] = false;
      }
    }
    // Short alternating paired islands cannot support a complete LED body.
    // Preserve one continuous skeleton span there rather than fragmented lanes.
    if (config.moduleLengthMm) {
      const visited = new Set<number>();
      for (let i = 0; i < segmentCount; i++) {
        if (!doubleSegments[i] || visited.has(i)) continue;
        const run = [i]; visited.add(i);
        for (const direction of [-1, 1]) {
          let j = i + direction;
          while (edge.closed || (j >= 0 && j < segmentCount)) {
            const index = (j % segmentCount + segmentCount) % segmentCount;
            if (!doubleSegments[index] || visited.has(index)) break;
            visited.add(index); run.push(index); j += direction;
          }
        }
        if (run.length * step < config.moduleLengthMm) for (const index of run) doubleSegments[index] = false;
      }
    }
    const emit = (indices: number[], doubled: boolean, closed: boolean) => {
      const lanes: Array<-1 | 0 | 1> = doubled ? [-1, 1] : [0];
      for (const lane of lanes) {
        const key = lane === 0 ? 'center' : lane === -1 ? 'left' : 'right';
        const points = indices.map(i => unscalePoint(samples[i % samples.length][key], skeleton.scale));
        if (closed && indices.length > samples.length) points.pop();
        result.paths.push({ id: `${edge.id}-part-${result.paths.length}`, figureId: edge.figureId, regionId: edge.regionId,
          outerContourId: sourceRegion.outerContourId, innerContourId: sourceRegion.holeContourIds[0] ?? '',
          index: lane === 1 ? 2 : 1, fraction: lane === 0 ? 0.5 : lane === -1 ? 1 / 3 : 2 / 3,
          sourceEdgeId: edge.id, sourceRange: [indices[0] * step, indices.at(-1)! * step], lane, closed, points, d: pathData(points, closed) });
      }
      if (doubled) {
        const base = result.paths.at(-1)!;
        const center = indices.map(i => unscalePoint(samples[i % samples.length].center, skeleton.scale));
        if (closed && indices.length > samples.length) center.pop();
        fallbacks.set(groupKey(base), { ...base, id: `${base.id}-central`, index: 1, fraction: 0.5, lane: 0, points: center, d: pathData(center, closed) });
      }
    };
    // Start a closed cycle at a mode transition, so no artificial seam splits a uniform run.
    const start = edge.closed ? Math.max(0, doubleSegments.findIndex((mode, i) => mode !== doubleSegments[(i + segmentCount - 1) % segmentCount])) : 0;
    let runStart = start;
    for (let position = start + 1; position <= start + segmentCount; position++) {
      const atEnd = position === start + segmentCount;
      if (atEnd || doubleSegments[position % segmentCount] !== doubleSegments[runStart % segmentCount]) {
        emit(Array.from({ length: position - runStart + 1 }, (_, i) => runStart + i), doubleSegments[runStart % segmentCount], edge.closed && position - runStart === segmentCount);
        runStart = position;
      }
    }
  }
  // Independent branches can approach each other even when each local offset is valid.
  // Downgrade affected paired runs together, never splice one lane into the other.
  let downgraded = 0;
  for (let pass = 0; pass <= fallbacks.size; pass++) {
    const conflicts = new Set<string>();
    const boxes = result.paths.map(path => ({ minX: Math.min(...path.points.map(p => p.x)), maxX: Math.max(...path.points.map(p => p.x)), minY: Math.min(...path.points.map(p => p.y)), maxY: Math.max(...path.points.map(p => p.y)) }));
    for (let i = 0; i < result.paths.length; i++) for (let j = i + 1; j < result.paths.length; j++) {
      const a = result.paths[i], b = result.paths[j], ab = boxes[i], bb = boxes[j];
      if ((!a.lane && !b.lane) || a.regionId !== b.regionId || groupKey(a) === groupKey(b) || ab.maxX < bb.minX || bb.maxX < ab.minX || ab.maxY < bb.minY || bb.maxY < ab.minY) continue;
      const ap = a.closed ? [...a.points, a.points[0]] : a.points, bp = b.closed ? [...b.points, b.points[0]] : b.points;
      let collision = false;
      for (let ai = 1; ai < ap.length && !collision; ai++) for (let bi = 1; bi < bp.length; bi++) {
        if (segmentsCross(ap[ai - 1], ap[ai], bp[bi - 1], bp[bi])) { collision = true; break; }
      }
      if (collision) { if (a.lane) conflicts.add(groupKey(a)); if (b.lane) conflicts.add(groupKey(b)); }
    }
    if (!conflicts.size) break;
    result.paths = result.paths.filter(path => !conflicts.has(groupKey(path)));
    for (const key of conflicts) result.paths.push(fallbacks.get(key)!);
    downgraded += conflicts.size;
  }
  if (downgraded) result.warnings.push(`${downgraded} tramo(s) conservan el eje central para evitar cruces entre partidas.`);
  result.paths = filterPartitionsForBody(result.paths, result.regions, skeleton.scale, config);
  result.pairs = result.paths.filter(p => p.lane === -1).length;
  return result;
}
