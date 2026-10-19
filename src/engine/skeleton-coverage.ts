import type { SkeletonResult, SkeletonEdge } from './skeleton';
import type { ModuleMeasurements } from './module';
import type { SvgModel, Point } from './types';
import type { DivisionPath } from './divisions';
import { distributeLeds, pathPolyline, pointAt, makeRectangle, insideRegion } from './distribution';
import type { LedDistributionResult } from './distribution';
import type { SerpentGuide, SerpentGuides } from './serpent-guides';
import { minimumPigtailSpacingMm } from './pigtail-spacing';
import { pathData, unscalePoint, scalePoint, scaleRegion } from './regions';

const distanceToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

function coverageGuide(id: string, figureId: string, regionId: string, outerContourId: string,
  pointsMm: Point[], scale: SkeletonResult['scale'], edgeId = id): SerpentGuide {
  const points = pointsMm.map(point => unscalePoint(point, scale));
  return { id, figureId, regionId, outerContourId, innerContourId: '', index: 0, fraction: 0.5,
    bodyFiltered: true, coverageBranch: true, cornerBranch: true, sourceEdgeId: edgeId,
    sourceRange: [0, 0], lane: 0, closed: false, points, d: pathData(points), origin: 'skeleton' };
}

function guideAtSkeletonTip(edge: SkeletonEdge, tipId: string, measurements: ModuleMeasurements,
  skeleton: SkeletonResult): SerpentGuide | null {
  const ordered = edge.from === tipId ? edge.points : [...edge.points].reverse();
  if (ordered.length < 2) return null;
  // Skeleton edge coordinates are already physical millimeters when units is
  // "mm". Convert back to SVG only when constructing the guide path.
  const physical = ordered;
  const points = [physical[0]];
  let remaining = measurements.lengthMm;
  for (let i = 1; i < physical.length && remaining > 1e-6; i++) {
    const a = physical[i - 1], b = physical[i], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-8) continue;
    if (length >= remaining) {
      const t = remaining / length;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      remaining = 0;
    } else { points.push(b); remaining -= length; }
  }
  // A terminal raster span can be shorter than the module while the shape
  // around its tip is still wide enough. Continue its final tangent; the
  // regular body-in-region check decides whether that pose is physically safe.
  if (remaining > 1e-6) {
    const a = points.at(-2)!, b = points.at(-1)!, length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-8) return null;
    points.push({ x: b.x + (b.x - a.x) * remaining / length, y: b.y + (b.y - a.y) * remaining / length });
  }
  const regionId = edge.regionId;
  return coverageGuide(`${edge.id}-tip-led-${tipId}`, edge.figureId, regionId,
    skeleton.regions.find(region => region.id === regionId)?.outerContourId ?? '', points, skeleton.scale, edge.id);
}

function guideOnUncoveredSkeletonEdge(edge: SkeletonEdge, measurements: ModuleMeasurements,
  skeleton: SkeletonResult): SerpentGuide | null {
  if (edge.closed || edge.points.length < 2) return null;
  // Skeleton edges already use physical millimeters in this recovery pass.
  const points = edge.points;
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const length = distances.at(-1)!;
  if (length <= 1e-6) return null;
  let line: Point[];
  if (length < measurements.lengthMm) {
    const extension = (measurements.lengthMm - length) / 2;
    const first = points[0], second = points[1], penultimate = points.at(-2)!, last = points.at(-1)!;
    const startLength = Math.hypot(second.x - first.x, second.y - first.y);
    const endLength = Math.hypot(last.x - penultimate.x, last.y - penultimate.y);
    if (startLength <= 1e-8 || endLength <= 1e-8) return null;
    line = [
      { x: first.x - (second.x - first.x) * extension / startLength, y: first.y - (second.y - first.y) * extension / startLength },
      ...points,
      { x: last.x + (last.x - penultimate.x) * extension / endLength, y: last.y + (last.y - penultimate.y) * extension / endLength },
    ];
  } else {
    const start = (length - measurements.lengthMm) / 2, end = start + measurements.lengthMm;
    const at = (distance: number) => {
      let i = 1;
      while (i < distances.length - 1 && distances[i] < distance) i++;
      const span = distances[i] - distances[i - 1];
      const t = (distance - distances[i - 1]) / (span || 1);
      return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
    };
    line = [at(start), ...points.filter((_, i) => distances[i] > start && distances[i] < end), at(end)];
  }
  const region = skeleton.regions.find(item => item.id === edge.regionId);
  if (!region) return null;
  const guide = coverageGuide(`${edge.id}-branch-led`, edge.figureId, edge.regionId, region.outerContourId, line, skeleton.scale, edge.id);
  // Let the normal body/region check slide the module within this short branch.
  // Locking its center to the branch midpoint can miss a wider pocket near a
  // junction even when the whole LED body fits elsewhere along the stem.
  guide.bodyFiltered = false;
  return guide;
}

function guideInEmptyRegion(region: SkeletonResult['regions'][number], measurements: ModuleMeasurements,
  skeleton: SkeletonResult): SerpentGuide | null {
  const scaled = scaleRegion(region, skeleton.scale);
  const xs = scaled.outer.map(point => point.x), ys = scaled.outer.map(point => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const area = Math.max(0, (maxX - minX) * (maxY - minY));
  let step = Math.max(2, Math.min(measurements.widthMm, measurements.lengthMm / 2));
  // Keep a worst-case search bounded for unusually large, empty figures.
  if (area / (step * step) > 12_000) step = Math.sqrt(area / 12_000);
  const clearance = Math.min(0.2, measurements.widthMm * 0.05);
  const candidates: Array<{ center: Point; score: number }> = [];
  const loops = [scaled.outer, ...scaled.holes];
  for (let y = minY; y <= maxY; y += step) for (let x = minX; x <= maxX; x += step) {
    const center = { x, y };
    let boundaryDistance = Infinity;
    for (const loop of loops) for (let i = 0; i < loop.length; i++) {
      boundaryDistance = Math.min(boundaryDistance, distanceToSegment(center, loop[i], loop[(i + 1) % loop.length]));
    }
    if (boundaryDistance > 0) candidates.push({ center, score: boundaryDistance });
  }
  // Rank cheap point-to-boundary estimates first, then run the expensive exact
  // rectangle/contour test only near the most spacious candidate centers.
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates.slice(0, 96)) {
    const { center } = candidate;
    for (let angle = 0; angle < Math.PI; angle += Math.PI / 12) {
      const direction = { x: Math.cos(angle), y: Math.sin(angle) };
      const ends = [
        { x: center.x - direction.x * measurements.lengthMm / 2, y: center.y - direction.y * measurements.lengthMm / 2 },
        { x: center.x + direction.x * measurements.lengthMm / 2, y: center.y + direction.y * measurements.lengthMm / 2 },
      ];
      const line = { points: ends, distances: [0, measurements.lengthMm], length: measurements.lengthMm, closed: false };
      const rectangle = makeRectangle(line, measurements.lengthMm / 2, measurements.lengthMm, measurements.widthMm);
      if (rectangle && insideRegion(rectangle, { outer: scaled.outer, inner: null, holes: scaled.holes }, clearance)) {
        return coverageGuide(`empty-region-led-${region.id}`, region.figureId, region.id, region.outerContourId,
          ends, skeleton.scale);
      }
    }
  }
  return null;
}

/** Add physically checked tip LEDs and one body-fitting LED to any otherwise
 * empty filled region. This covers real ends and compact isolated marks whose
 * medial skeleton has no directional edge. */
export function recoverMissingCoverageGuides(skeleton: SkeletonResult, guides: SerpentGuides,
  distribution: LedDistributionResult, measurements: ModuleMeasurements): SerpentGuide[] {
  if (skeleton.units !== 'mm') return [];
  const existingIds = new Set(guides.paths.map(path => path.id));
  const guidesById = new Map(guides.paths.map(path => [path.id, path]));
  const edgesWithModules = new Set<string>();
  for (const module of distribution.modules) {
    const guide = guidesById.get(module.divisionId);
    if (!guide) continue;
    for (const span of guide.sourceSpans ?? [{ edgeId: guide.sourceEdgeId, from: guide.sourceRange[0], to: guide.sourceRange[1] }]) {
      edgesWithModules.add(span.edgeId);
    }
  }
  const nodes = new Map(skeleton.nodes.map(node => [node.id, node]));
  const added: SerpentGuide[] = [];
  for (const edge of skeleton.edges) {
    if (edge.closed) continue;
    // A recovered corner already reserves one body on this source branch.
    // A second tip guide would compete with that same reservation.
    if (edge.cornerBranch && edgesWithModules.has(edge.id)) continue;
    let recoveredTip = false;
    for (const tipId of [edge.from, edge.to].filter((id): id is string => !!id && nodes.get(id)?.kind === 'end')) {
      const id = `${edge.id}-tip-led-${tipId}`;
      if (existingIds.has(id)) continue;
      const guide = guideAtSkeletonTip(edge, tipId, measurements, skeleton);
      if (guide) { added.push(guide); existingIds.add(id); recoveredTip = true; }
    }
    if (!edgesWithModules.has(edge.id) && !recoveredTip) {
      const guide = guideOnUncoveredSkeletonEdge(edge, measurements, skeleton);
      if (guide && !existingIds.has(guide.id)) { added.push(guide); existingIds.add(guide.id); }
    }
  }
  const emptyFigureIds = new Set(distribution.byFigure.filter(figure => figure.placed === 0).map(figure => figure.figureId));
  for (const region of skeleton.regions) {
    if (!emptyFigureIds.has(region.figureId) || existingIds.has(`empty-region-led-${region.id}`)) continue;
    const guide = guideInEmptyRegion(region, measurements, skeleton);
    if (guide) { added.push(guide); existingIds.add(guide.id); }
  }
  return added;
}

// Only recover gaps larger than two normal LED pitches; ordinary terminal
// margins should not reintroduce every corner spoke removed by pruning.
export const COVERAGE_GAP_PITCH_FACTOR = 2;

/** Restore terminal corner pairs and useful portions of pruned medial branches
 * when they can host a physical LED. This is geometric coverage,
 * not a photometric estimate. Every candidate is checked against the original
 * contour and holes using the same body-fit rules as normal LED placement. */
export function restoreCoverageBranches(model: SvgModel, source: SkeletonResult, filtered: SkeletonResult,
  measurements: ModuleMeasurements, size: { widthMm: number; heightMm: number }): SkeletonResult {
  if (source.units !== 'mm' || !filtered.edges.length) return filtered;
  const nodes = new Map(source.nodes.map(node => [node.id, node]));
  const retainedIds = new Set(filtered.edges.map(edge => edge.id));
  const joints = new Set(filtered.edges.flatMap(edge => [edge.from, edge.to]));
  const candidates: Array<{ edge: SkeletonEdge; path: DivisionPath; joint: string }> = [];
  for (const edge of source.edges) {
    if (retainedIds.has(edge.id) || edge.closed || !edge.from || !edge.to) continue;
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    const joint = from?.kind === 'end' && joints.has(edge.to) ? edge.to
      : to?.kind === 'end' && joints.has(edge.from) ? edge.from : null;
    const region = source.regions.find(region => region.id === edge.regionId);
    if (!joint || !region) continue;
    const points = edge.from === joint ? edge.points : [...edge.points].reverse();
    candidates.push({ edge, joint, path: { id: edge.id, figureId: edge.figureId, regionId: edge.regionId,
      outerContourId: region.outerContourId, innerContourId: '', index: 0, fraction: 0.5, bodyFiltered: true,
      d: pathData(points.map(p => unscalePoint(p, source.scale))) } });
  }
  if (!candidates.length) return filtered;
  const fit = distributeLeds(model, { paths: candidates.map(item => item.path), regions: source.regions, pairs: 0, warnings: [] },
    { ...measurements, leftPigtailMm: 0, rightPigtailMm: 0 }, size.widthMm, size.heightMm,
    { minimumGapMm: 0, maximumGapMm: 0, independentPaths: true });
  const pitch = measurements.lengthMm + minimumPigtailSpacingMm(measurements.leftPigtailMm, measurements.rightPigtailMm);
  const physicalRegions = new Map(source.regions.map(region => [region.id, scaleRegion(region, source.scale)]));
  const boundaryDistance = (point: Point, loop: Point[]) => loop.reduce((minimum, p, i) =>
    Math.min(minimum, distanceToSegment(point, p, loop[(i + 1) % loop.length])), Infinity);
  const cornerIds = new Set<string>();
  // At a flat terminal, pruning leaves one stem and removes the two spokes
  // toward its corners. Recover that fork independently of the large-gap rule.
  // Hole spokes and isolated corner noise do not qualify as a terminal pair.
  for (const joint of new Set(candidates.map(candidate => candidate.joint))) {
    if (filtered.edges.filter(edge => edge.from === joint || edge.to === joint).length !== 1) continue;
    const arms = candidates.filter(candidate => candidate.joint === joint).filter(({ edge }) => {
      const tip = nodes.get((edge.from === joint ? edge.to : edge.from)!)!;
      const region = physicalRegions.get(edge.regionId)!;
      const outerDistance = boundaryDistance(tip.point, region.outer);
      // Simplification and approximate symmetry can leave the tip a few cells
      // inside the contour, especially on slightly rounded source corners.
      const cornerTolerance = Math.max(source.resolution * 6, measurements.widthMm);
      return tip.radius <= cornerTolerance && outerDistance <= cornerTolerance &&
        region.holes.every(hole => boundaryDistance(tip.point, hole) > outerDistance + source.resolution);
    });
    if (arms.length !== 2) continue;
    const origin = nodes.get(joint)!.point;
    const vectors = arms.map(({ edge }) => {
      const tip = nodes.get((edge.from === joint ? edge.to : edge.from)!)!.point;
      const length = Math.hypot(tip.x - origin.x, tip.y - origin.y);
      return { x: (tip.x - origin.x) / (length || 1), y: (tip.y - origin.y) / (length || 1) };
    });
    if (vectors[0].x * vectors[1].x + vectors[0].y * vectors[1].y > 0.5) continue;
    for (const arm of arms) cornerIds.add(arm.edge.id);
  }
  const added: SkeletonEdge[] = [], tips = [];
  for (const { edge, path, joint } of candidates) {
    const line = pathPolyline(path, source.scale);
    if (!line) continue;
    const cornerBranch = cornerIds.has(edge.id);
    const neighbors = filtered.edges.filter(other => other.regionId === edge.regionId);
    const coverageDistance = Math.max(30, pitch * COVERAGE_GAP_PITCH_FACTOR, (nodes.get(joint)?.radius ?? 0) * 0.75);
    const usable = fit.modules.filter(module => module.divisionId === edge.id).filter(module => {
      const center = scalePoint(module.center, source.scale);
      let distance = Infinity;
      for (const other of neighbors) {
        const points = other.closed ? [...other.points, other.points[0]] : other.points;
        for (let i = 1; i < points.length; i++) distance = Math.min(distance, distanceToSegment(center, points[i - 1], points[i]));
      }
      return distance > coverageDistance;
    }).map(module => module.positionMm ?? 0);
    if (cornerBranch) {
      const region = physicalRegions.get(edge.regionId)!;
      const half = measurements.lengthMm / 2;
      for (let position = line.length - half; position >= half; position -= Math.max(0.25, Math.min(1, measurements.widthMm / 4))) {
        const rectangle = makeRectangle(line, position, measurements.lengthMm, measurements.widthMm);
        if (rectangle && insideRegion(rectangle, { outer: region.outer, inner: null, holes: region.holes }, Math.min(0.2, measurements.widthMm * 0.05))) {
          usable.push(position); break;
        }
      }
    }
    if (!usable.length) continue;
    const end = Math.min(line.length, Math.max(...usable) + measurements.lengthMm / 2);
    const points = [...line.points.filter((_, i) => line.distances[i] < end), pointAt(line, end)];
    const tipId = `${edge.id}-coverage-tip`;
    tips.push({ id: tipId, regionId: edge.regionId, figureId: edge.figureId, kind: 'end' as const,
      point: points.at(-1)!, radius: measurements.widthMm / 2 });
    added.push({ ...edge, from: joint, to: tipId, points, closed: false, coverageBranch: true, cornerBranch,
      d: pathData(points.map(p => unscalePoint(p, source.scale))) });
  }
  return added.length ? { ...filtered, edges: [...filtered.edges, ...added], nodes: [...filtered.nodes, ...tips],
    warnings: [...filtered.warnings, `${added.length} rama(s) recuperada(s) para cubrir esquinas o zonas alejadas del recorrido.`] } : filtered;
}
