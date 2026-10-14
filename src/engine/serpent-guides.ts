import type { PartitionPath, PartitionResult, SkeletonSpan } from './partitions';
import type { SkeletonResult } from './skeleton';
import { pathData, pointDistance, unscalePoint, scalePoint, scaleRegion, regionContains, polygonContains } from './regions';
import { usefulSkeletonEdges } from './skeleton-filter';
import type { Point } from './types';
import type { LedDistributionResult } from './distribution';

export interface SerpentGuide extends PartitionPath { origin: 'partition' | 'skeleton' }
export interface SerpentGuides extends PartitionResult { paths: SerpentGuide[] }

/** Both lanes belong to one partida; count their final accepted LEDs together.
 * A lone LED should use the source skeleton instead of an offset loop. */
export function singleLedPartitionIds(guides: SerpentGuides, distribution: LedDistributionResult): Set<string> {
  const counts = new Map<string, number>();
  for (const module of distribution.modules) counts.set(module.divisionId, (counts.get(module.divisionId) ?? 0) + 1);
  const groups = new Map<string, SerpentGuide[]>();
  for (const path of guides.paths) {
    if (path.origin !== 'partition') continue;
    const spans = path.sourceSpans ?? [{ edgeId: path.sourceEdgeId, from: path.sourceRange[0], to: path.sourceRange[1] }];
    const key = `${path.regionId}:${spans.map(span => `${span.edgeId}:${span.from.toFixed(5)}:${span.to.toFixed(5)}`).sort().join('|')}`;
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  return new Set([...groups.values()].filter(paths => paths.reduce((sum, path) => sum + (counts.get(path.id) ?? 0), 0) === 1)
    .flatMap(paths => paths.map(path => path.id)));
}

/** Replace only the original skeleton intervals that actually produced partidas.
 * Provenance survives joined/reversed edges, filtering and a closed guide's seam. */
export function composeSerpentGuides(skeleton: SkeletonResult, partitions: PartitionResult): SerpentGuides {
  // An open partida needs both lanes over the same source intervals. If body
  // fitting removed one lane, restore the centerline instead of leaving a wire
  // with no return lane or joining it to an unrelated nearby partida.
  const paired = new Set<string>();
  const pairs = new Map<string, PartitionPath[]>();
  for (const path of partitions.paths) {
    if (path.closed) { paired.add(path.id); continue; }
    const spans = path.sourceSpans ?? [{ edgeId: path.sourceEdgeId, from: path.sourceRange[0], to: path.sourceRange[1] }];
    const key = `${path.regionId}:${spans.map(span => `${span.edgeId}:${span.from.toFixed(5)}:${span.to.toFixed(5)}`).sort().join('|')}`;
    pairs.set(key, [...(pairs.get(key) ?? []), path]);
  }
  for (const group of pairs.values()) {
    const left = group.filter(path => path.lane === -1), right = group.filter(path => path.lane === 1);
    for (let i = 0; i < Math.min(left.length, right.length); i++) { paired.add(left[i].id); paired.add(right[i].id); }
  }
  if (paired.size < partitions.paths.length) {
    const retained = partitions.paths.filter(path => paired.has(path.id));
    return composeSerpentGuides(skeleton, { ...partitions, paths: retained, pairs: retained.filter(path => path.lane === -1).length });
  }
  const paths: SerpentGuide[] = partitions.paths.map(path => ({ ...path, origin: 'partition' }));
  const coverage = new Map<string, SkeletonSpan[]>();
  for (const path of partitions.paths) for (const span of path.sourceSpans ?? [{ edgeId: path.sourceEdgeId, from: path.sourceRange[0], to: path.sourceRange[1] }]) {
    coverage.set(span.edgeId, [...(coverage.get(span.edgeId) ?? []), span]);
  }
  const sourceBoundaryPoints = new Map<string, { edgeId: string; distance: number; regionId: string; point: Point }>();
  for (const edge of usefulSkeletonEdges(skeleton)) {
    const region = skeleton.regions.find(region => region.id === edge.regionId);
    if (!region || edge.points.length < 2) continue;
    const points = edge.closed ? [...edge.points, edge.points[0]] : edge.points;
    const distances = [0];
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + pointDistance(points[i - 1], points[i]));
    const length = distances.at(-1)!;
    const covered = (coverage.get(edge.id) ?? []).map(span => ({ from: Math.max(0, span.from), to: Math.min(length, span.to) })).sort((a, b) => a.from - b.from);
    const remaining: Array<[number, number]> = [];
    let cursor = 0;
    for (const span of covered) {
      if (span.from - cursor > 1e-6) remaining.push([cursor, span.from]);
      cursor = Math.max(cursor, span.to);
    }
    if (length - cursor > 1e-6) remaining.push([cursor, length]);
    const at = (position: number) => {
      const index = Math.max(0, distances.findIndex(distance => distance >= position) - 1);
      const t = (position - distances[index]) / (distances[index + 1] - distances[index] || 1);
      return { x: points[index].x + (points[index + 1].x - points[index].x) * t, y: points[index].y + (points[index + 1].y - points[index].y) * t };
    };
    for (const span of coverage.get(edge.id) ?? []) for (const position of [span.from, span.to]) {
      const bounded = Math.max(0, Math.min(length, position));
      sourceBoundaryPoints.set(`${edge.id}:${position.toFixed(5)}`, {
        edgeId: edge.id, distance: position, regionId: edge.regionId, point: unscalePoint(at(bounded), skeleton.scale),
      });
    }
    for (const [index, [from, to]] of remaining.entries()) {
      const closed = edge.closed && from === 0 && to === length;
      const physical = closed ? edge.points : [at(from), ...points.filter((_, i) => distances[i] > from && distances[i] < to), at(to)];
      const svgPoints = physical.map(point => unscalePoint(point, skeleton.scale));
      paths.push({ id: `${edge.id}-remaining-${index}`, figureId: edge.figureId, regionId: edge.regionId,
        outerContourId: region.outerContourId, innerContourId: region.holeContourIds[0] ?? '',
        sourceEdgeId: edge.id, sourceRange: [from, to], sourceSpans: [{ edgeId: edge.id, from, to }],
        index: 0, fraction: 0.5, lane: 0, closed, points: svgPoints, d: pathData(svgPoints, closed), origin: 'skeleton',
        coverageBranch: edge.coverageBranch });
    }
  }
  // Close paired lanes at their source interval boundaries, including terminal
  // boundaries with no residual skeleton. Source identity prevents cross-letter
  // joins and shortcuts across holes.
  const residualEnds = paths.filter(path => path.origin === 'skeleton' && !path.closed).flatMap(path => [
    { regionId: path.regionId, edgeId: path.sourceEdgeId, distance: path.sourceRange[0], point: path.points[0] },
    { regionId: path.regionId, edgeId: path.sourceEdgeId, distance: path.sourceRange[1], point: path.points.at(-1)! },
  ]);
  const physicalRegions = new Map(skeleton.regions.map(region => [region.id, scaleRegion(region, skeleton.scale)]));
  for (const path of paths) {
    if (path.origin !== 'partition' || path.closed || path.points.length < 2) continue;
    const region = physicalRegions.get(path.regionId);
    if (!region) continue;
    const spans = path.sourceSpans ?? [{ edgeId: path.sourceEdgeId, from: path.sourceRange[0], to: path.sourceRange[1] }];
    const boundarySpans = spans.length > 1 ? [spans[0], spans.at(-1)!] : spans;
    const candidates = [...residualEnds, ...sourceBoundaryPoints.values()].filter(end => end.regionId === path.regionId && boundarySpans.some(span =>
      span.edgeId === end.edgeId && (Math.abs(span.from - end.distance) < 1e-5 || Math.abs(span.to - end.distance) < 1e-5)));
    const originalStart = path.points[0], originalEnd = path.points.at(-1)!;
    const physicalDistance = (a: Point, b: Point) => pointDistance(scalePoint(a, skeleton.scale), scalePoint(b, skeleton.scale));
    const attach = (point: Point, other: Point) => {
      const candidate = candidates.filter(end => physicalDistance(end.point, point) <= physicalDistance(end.point, other))
        .sort((a, b) => physicalDistance(a.point, point) - physicalDistance(b.point, point))[0];
      if (!candidate || physicalDistance(candidate.point, point) < 1e-6) return null;
      const a = scalePoint(point, skeleton.scale), b = scalePoint(candidate.point, skeleton.scale);
      const steps = Math.max(2, Math.ceil(pointDistance(a, b) / Math.max(skeleton.resolution * 0.5, 0.1)));
      for (let i = 0; i <= steps; i++) if (!regionContains({ x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, region)) return null;
      return candidate.point;
    };
    const start = attach(originalStart, originalEnd), end = attach(originalEnd, originalStart);
    const transition = (input: Point[], target: Point): Point[] => {
      const physical = input.map(point => scalePoint(point, skeleton.scale));
      const anchor = scalePoint(target, skeleton.scale), distances = [0];
      for (let i = 1; i < physical.length; i++) distances.push(distances[i - 1] + pointDistance(physical[i - 1], physical[i]));
      const cut = Math.min(pointDistance(anchor, physical[0]) * 2, distances.at(-1)! * 0.25);
      if (cut < 1e-6) return [target, ...input];
      const index = Math.max(1, distances.findIndex(distance => distance >= cut));
      const a = physical[index - 1], b = physical[index], length = pointDistance(a, b);
      const t = (cut - distances[index - 1]) / (length || 1);
      const finish = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const direction = { x: finish.x - physical[0].x, y: finish.y - physical[0].y };
      const magnitude = Math.hypot(direction.x, direction.y) || 1;
      const control = cut * 0.45;
      // Close the paired lanes with a rounded cap. At the shared anchor its
      // tangent runs across the lanes, so the residual skeleton meets the
      // middle of the cap instead of pulling both lanes into a pointed Y.
      const normal = { x: -direction.y / magnitude, y: direction.x / magnitude };
      const side = Math.sign((physical[0].x - anchor.x) * normal.x + (physical[0].y - anchor.y) * normal.y);
      const c1 = { x: anchor.x + normal.x * side * control, y: anchor.y + normal.y * side * control };
      const c2 = { x: finish.x - (b.x - a.x) / (length || 1) * control, y: finish.y - (b.y - a.y) / (length || 1) * control };
      const steps = Math.max(12, Math.ceil((cut + pointDistance(anchor, physical[0])) / Math.max(skeleton.resolution * 0.5, 0.1)));
      const curve: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const point = { x: u ** 3 * anchor.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * finish.x,
          y: u ** 3 * anchor.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * finish.y };
        if (!regionContains(point, region)) return [target, ...input];
        curve.push(unscalePoint(point, skeleton.scale));
      }
      curve[0] = target;
      return [...curve, ...input.slice(index)];
    };
    if (start) path.points = transition(path.points, start);
    if (end) path.points = transition([...path.points].reverse(), end).reverse();
    path.d = pathData(path.points);
  }
  // A safe cap must exist for both lanes at both ends. If a hole or a concave
  // boundary prevented a join, restore that pair's centerline rather than
  // leaving an open circuit or forcing a connection through empty space.
  const unfinished = new Set<string>();
  const pathsById = new Map(paths.map(path => [path.id, path]));
  const physicalDistance = (a: Point, b: Point) => pointDistance(scalePoint(a, skeleton.scale), scalePoint(b, skeleton.scale));
  for (const group of pairs.values()) {
    const left = group.filter(path => path.lane === -1), right = group.filter(path => path.lane === 1);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const a = pathsById.get(left[i].id)!, b = pathsById.get(right[i].id)!;
      const forward = physicalDistance(a.points[0], b.points[0]) < 1e-5 && physicalDistance(a.points.at(-1)!, b.points.at(-1)!) < 1e-5;
      const reverse = physicalDistance(a.points[0], b.points.at(-1)!) < 1e-5 && physicalDistance(a.points.at(-1)!, b.points[0]) < 1e-5;
      if (!forward && !reverse) { unfinished.add(a.id); unfinished.add(b.id); }
    }
  }
  if (unfinished.size) {
    const retained = partitions.paths.filter(path => !unfinished.has(path.id));
    return composeSerpentGuides(skeleton, { ...partitions, paths: retained, pairs: retained.filter(path => path.lane === -1).length });
  }
  // A brief widening can split into two lanes and immediately merge again, making
  // a bulb rather than useful parallel runs. Restore its source centerline.
  const rejected = new Set<string>();
  const originals = new Map(partitions.paths.map(path => [path.id, path]));
  const branches = paths.filter(path => path.origin === 'partition' && !path.closed);
  const distance = (a: Point, b: Point) => pointDistance(scalePoint(a, skeleton.scale), scalePoint(b, skeleton.scale));
  const sample = (points: Point[], fraction: number): Point => {
    const lengths = points.slice(1).map((point, i) => distance(points[i], point));
    let remaining = lengths.reduce((sum, length) => sum + length, 0) * fraction;
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i]) {
        const t = remaining / (lengths[i] || 1);
        return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t };
      }
      remaining -= lengths[i];
    }
    return points.at(-1)!;
  };
  for (let i = 0; i < branches.length; i++) for (let j = i + 1; j < branches.length; j++) {
    const a = branches[i], b = branches[j];
    if (a.regionId !== b.regionId || a.lane === b.lane || rejected.has(a.id) || rejected.has(b.id)) continue;
    const forward = distance(a.points[0], b.points[0]) < 1e-5 && distance(a.points.at(-1)!, b.points.at(-1)!) < 1e-5;
    const reverse = distance(a.points[0], b.points.at(-1)!) < 1e-5 && distance(a.points.at(-1)!, b.points[0]) < 1e-5;
    if (!forward && !reverse) continue;
    const loop = [...a.points, ...(forward ? [...b.points].reverse() : b.points)];
    const region = skeleton.regions.find(region => region.id === a.regionId);
    if (region?.holes.some(hole => hole.some(point => polygonContains(point, loop)))) continue;
    const originalA = originals.get(a.id)!, originalB = originals.get(b.id)!;
    const runLength = (originalA.sourceSpans ?? []).reduce((sum, span) => sum + span.to - span.from, 0);
    const widths = [0.25, 0.5, 0.75].map(t => distance(sample(originalA.points, t), sample(originalB.points, forward ? t : 1 - t))).sort((a, b) => a - b);
    // Junction arms and runs reaching a skeleton tip are intentional partidas;
    // the caller already checks physical body fit. Only discard brief internal
    // widenings bounded by residual centerline at both ends.
    const residualAt = (point: Point) => residualEnds.some(end => end.regionId === a.regionId && distance(end.point, point) < 1e-5);
    const internalWidening = residualAt(a.points[0]) && residualAt(a.points.at(-1)!);
    if (!a.junctionBounded && !b.junctionBounded && internalWidening && runLength < widths[1] * 6) {
      rejected.add(a.id); rejected.add(b.id);
    }
  }
  if (rejected.size) {
    const retained = partitions.paths.filter(path => !rejected.has(path.id));
    return composeSerpentGuides(skeleton, { ...partitions, paths: retained, pairs: retained.filter(path => path.lane === -1).length });
  }
  return { paths, pairs: partitions.pairs, regions: partitions.regions, warnings: partitions.warnings };
}
