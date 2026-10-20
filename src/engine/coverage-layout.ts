import { insideRegion, makeRectangle, overlaps, pathPolyline, rectangleGap } from './distribution';
import type { LedDistributionResult, PlacementOptions, Polyline, Rectangle, Region } from './distribution';
import type { ModuleMeasurements } from './module';
import { minimumPigtailSpacingMm } from './pigtail-spacing';
import { pathData, pointDistance, scaleRegion, unscalePoint } from './regions';
import type { SerpentGuide, SerpentGuides } from './serpent-guides';
import type { SkeletonEdge, SkeletonResult } from './skeleton';
import type { Point } from './types';

interface Placement {
  guide: SerpentGuide;
  route: Polyline;
  position: number;
  rectangle: Rectangle;
  fixed?: boolean;
}
interface Target { id: string; center: Point; angle: number; sourceEdges: SkeletonEdge[] }
export interface CoverageLayout {
  guides: SerpentGuides;
  positionsByGuideMm: Record<string, number[]>;
  restoredEdges: SkeletonEdge[];
}

function polyline(points: Point[]): Polyline {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + pointDistance(points[i - 1], points[i]));
  return { points, distances, length: distances.at(-1)!, closed: false };
}

function bodyLine(center: Point, angle: number, length: number): Polyline {
  const dx = Math.cos(angle) * length / 2, dy = Math.sin(angle) * length / 2;
  return polyline([{ x: center.x - dx, y: center.y - dy }, { x: center.x + dx, y: center.y + dy }]);
}

function pointBodyGap(point: Point, body: Rectangle): number {
  const dx = point.x - body.center.x, dy = point.y - body.center.y;
  return Math.hypot(
    Math.max(0, Math.abs(dx * body.tangent.x + dy * body.tangent.y) - body.halfLength),
    Math.max(0, Math.abs(dx * body.normal.x + dy * body.normal.y) - body.halfWidth));
}

/** Pruned terminal spokes still identify a flat cap even when their diagonal
 * centerlines cannot host a body. Search around the cap, including across it.
 * Also revisit real skeleton spans that received no LED at all. */
function coverageTargets(source: SkeletonResult, skeleton: SkeletonResult, regionId: string,
  existing: Placement[], length: number, width: number): Target[] {
  const nodes = new Map(source.nodes.map(node => [node.id, node]));
  const retained = new Set(skeleton.edges.map(edge => edge.id));
  const groups = new Map<string, { joint: Point; tips: Point[]; edges: SkeletonEdge[] }>();
  for (const edge of source.edges) {
    if (edge.regionId !== regionId || edge.closed || retained.has(edge.id)) continue;
    const a = nodes.get(edge.from ?? ''), b = nodes.get(edge.to ?? '');
    const tip = a?.kind === 'end' ? a : b?.kind === 'end' ? b : null;
    const joint = tip === a ? b : a;
    if (!tip || !joint) continue;
    let group = groups.get(joint.id);
    if (!group) { group = { joint: joint.point, tips: [], edges: [] }; groups.set(joint.id, group); }
    group.tips.push(tip.point); group.edges.push(edge);
  }
  const targets: Target[] = [];
  for (const [id, group] of groups) {
    const cap = { x: group.tips.reduce((sum, p) => sum + p.x, 0) / group.tips.length,
      y: group.tips.reduce((sum, p) => sum + p.y, 0) / group.tips.length };
    if (existing.some(item => pointBodyGap(cap, item.rectangle) < length * 0.45)) continue;
    const angle = Math.atan2(group.joint.y - cap.y, group.joint.x - cap.x);
    const offset = length / 2 + width * 0.7;
    targets.push({ id: `cap-${id}`, center: { x: cap.x + Math.cos(angle) * offset,
      y: cap.y + Math.sin(angle) * offset }, angle, sourceEdges: group.edges });
  }
  const active = new Set(existing.flatMap(item => item.guide.sourceSpans?.map(span => span.edgeId) ?? [item.guide.sourceEdgeId]));
  for (const edge of skeleton.edges) {
    if (edge.regionId !== regionId || edge.closed || edge.coverageBranch || active.has(edge.id)) continue;
    const route = polyline(edge.points);
    if (route.length < length) continue;
    const body = makeRectangle(route, route.length / 2, length, width);
    if (body) targets.push({ id: `span-${edge.id}`, center: body.center,
      angle: Math.atan2(body.tangent.y, body.tangent.x), sourceEdges: [] });
  }
  return targets.sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x);
}

/** Add one body while retaining every existing LED. Neighbors slide only along
 * their own guides; a bounded constraint search commits a complete safe layout
 * or leaves the current distribution intact. No letter names or sizes are used. */
export function repairCoverageLayout(source: SkeletonResult, skeleton: SkeletonResult, guides: SerpentGuides,
  distribution: LedDistributionResult, measurements: ModuleMeasurements, options: PlacementOptions): CoverageLayout | null {
  if (skeleton.units !== 'mm' || options.independentPaths) return null;
  const { lengthMm: length, widthMm: width } = measurements;
  const gap = Math.max(options.bodyGapMm ?? 0, options.flexibleSpacing ? options.minimumGapMm ?? 10 :
    Math.max(options.minimumGapMm ?? 0, minimumPigtailSpacingMm(measurements.leftPigtailMm, measurements.rightPigtailMm)));
  const clearance = options.edgeMarginMm ?? Math.min(0.2, width * 0.05);
  const paths = new Map(guides.paths.map(guide => [guide.id, guide]));
  let placements: Placement[] = [];
  for (const module of distribution.modules) {
    const guide = paths.get(module.divisionId);
    const route = guide && pathPolyline(guide, skeleton.scale);
    if (!guide || !route || module.positionMm === undefined) return null;
    const rectangle = makeRectangle(route, module.positionMm, length, width);
    if (!rectangle) return null;
    placements.push({ guide, route, position: module.positionMm, rectangle });
  }
  const additions: SerpentGuide[] = [], restoredEdges: SkeletonEdge[] = [];
  // Circumscribed circles cheaply exclude far-away bodies before the exact
  // oriented rectangle distance test, including bodies in other figures.
  const distant = Math.hypot(length, width) + gap;
  let compatibility = new WeakMap<Rectangle, WeakMap<Rectangle, boolean>>();
  const compatible = (a: Rectangle, b: Rectangle): boolean => {
    if (pointDistance(a.center, b.center) > distant) return true;
    let row = compatibility.get(a);
    const cached = row?.get(b);
    if (cached !== undefined) return cached;
    const safe = gap > 1e-5 ? rectangleGap(a, b) >= gap - 1e-5 : !overlaps(a, b);
    if (!row) { row = new WeakMap(); compatibility.set(a, row); }
    row.set(b, safe);
    return safe;
  };
  for (const region of skeleton.regions) {
    let current = placements.filter(item => item.guide.regionId === region.id);
    const external = placements.filter(item => item.guide.regionId !== region.id);
    const scaled = scaleRegion(region, skeleton.scale);
    const physical: Region = { outer: scaled.outer, inner: null, holes: scaled.holes };
    const fits = (body: Rectangle) => insideRegion(body, physical, clearance + 1e-4) &&
      external.every(item => compatible(body, item.rectangle));
    const targets = coverageTargets(source, skeleton, region.id, current, length, width);
    for (const target of targets) {
      compatibility = new WeakMap();
      // Keep the search local even in a large sign with hundreds of LEDs.
      // All other bodies remain fixed obstacles, including other figures.
      const neighbors = current.filter(item => !item.fixed && !item.guide.junctionBridge &&
        pointDistance(item.rectangle.center, target.center) <= 3 * (length + gap) + width * 4)
        .sort((a, b) => pointDistance(a.rectangle.center, target.center) - pointDistance(b.rectangle.center, target.center))
        .slice(0, 32);
      const moving = new Set(neighbors);
      const unchanged = current.filter(item => !moving.has(item));
      const locallyFits = (body: Rectangle) => fits(body) && unchanged.every(item => compatible(body, item.rectangle));
      // New corner references are fixed after acceptance. Existing bodies can
      // move by at most about one normal LED pitch, without changing rows.
      const increment = Math.max(1, width / 3), reach = length + gap + increment * 2;
      const domains = neighbors.map(item => {
        const candidates = [item];
        for (let delta = increment; delta <= reach + 1e-6; delta += increment) for (const sign of [-1, 1]) {
          const raw = item.position + sign * delta;
          const at = item.route.closed ? (raw % item.route.length + item.route.length) % item.route.length : raw;
          const wholeSpan = item.guide.bodyFiltered || item.guide.lane !== 0;
          if (!item.route.closed && (at < (wholeSpan ? length / 2 : 0) ||
            at > item.route.length - (wholeSpan ? length / 2 : 0))) continue;
          const rectangle = makeRectangle(item.route, at, length, width);
          if (rectangle && locallyFits(rectangle)) candidates.push({ ...item, position: at, rectangle });
        }
        return candidates;
      });
      const poses: Array<{ rectangle: Rectangle; score: number }> = [];
      const step = width * 2 / 3;
      const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4].map(i => i * step);
      const tx = Math.cos(target.angle), ty = Math.sin(target.angle);
      for (const along of offsets) for (const across of offsets) {
        const center = { x: target.center.x + tx * along - ty * across,
          y: target.center.y + ty * along + tx * across };
        for (const degrees of [0, -15, 15, -30, 30, -45, 45, -60, 60, 90]) {
          const rectangle = makeRectangle(bodyLine(center, target.angle + degrees * Math.PI / 180, length), length / 2, length, width);
          if (!rectangle || !locallyFits(rectangle)) continue;
          // Try poses that already need fewer neighbor movements first.
          const conflicts = current.reduce((sum, item) => sum + Math.max(0, gap - rectangleGap(rectangle, item.rectangle)), 0);
          poses.push({ rectangle, score: conflicts * 100 + pointDistance(center, target.center) + Math.abs(degrees) * width / 100 });
        }
      }
      poses.sort((a, b) => a.score - b.score);
      const seen = new Set<string>();
      const candidates = poses.filter(({ rectangle: body }) => {
        const key = `${Math.round(body.center.x / (width / 5))}:${Math.round(body.center.y / (width / 5))}:${Math.round(Math.atan2(body.tangent.y, body.tangent.x) * 18 / Math.PI)}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 100);
      let visited = 0;
      let solution: Placement[] | null = null;
      const assigned: Array<Placement | null> = Array(neighbors.length).fill(null);
      const search = (remaining: number[], added: Rectangle): boolean => {
        if (++visited > 10_000) return false;
        if (!remaining.length) { solution = assigned.map(item => item!); return true; }
        let index = -1, valid: Placement[] = [];
        for (const variable of remaining) {
          const choices = domains[variable].filter(item => compatible(item.rectangle, added) &&
            assigned.every((other, j) => !other || (compatible(item.rectangle, other.rectangle) &&
              (item.guide.id !== other.guide.id || item.route.closed ||
                (neighbors[variable].position - neighbors[j].position) * (item.position - other.position) > 0))));
          if (!choices.length) return false;
          if (index < 0 || choices.length < valid.length) { index = variable; valid = choices; }
        }
        const rest = remaining.filter(variable => variable !== index);
        for (const choice of valid) {
          assigned[index] = choice;
          if (search(rest, added)) return true;
          assigned[index] = null;
        }
        return false;
      };
      for (const candidate of candidates) {
        if (!search(neighbors.map((_, i) => i), candidate.rectangle)) {
          if (visited > 10_000) break;
          continue;
        }
        const body = candidate.rectangle;
        const line = bodyLine(body.center, Math.atan2(body.tangent.y, body.tangent.x), length);
        const points = line.points.map(point => unscalePoint(point, skeleton.scale));
        const guide: SerpentGuide = { id: `coverage-refit-${target.id}`, figureId: region.figureId, regionId: region.id,
          outerContourId: region.outerContourId, innerContourId: '', index: 0, fraction: 0.5, points, d: pathData(points),
          closed: false, sourceEdgeId: `coverage-refit-${target.id}`, sourceRange: [0, 0], lane: 0,
          origin: 'skeleton', coverageBranch: true, cornerBranch: true, bodyFiltered: true };
        current = [...unchanged, ...solution!, { guide, route: pathPolyline(guide, skeleton.scale)!, position: length / 2, rectangle: body, fixed: true }];
        additions.push(guide); restoredEdges.push(...target.sourceEdges);
        break;
      }
    }
    placements = [...external, ...current];
  }
  if (!additions.length) return null;
  // Freeze all rows, including empty ones. A later greedy pass must not undo
  // the accepted arrangement or add an unplanned body ahead of a repaired row.
  const positionsByGuideMm: Record<string, number[]> = Object.fromEntries(guides.paths.map(guide => [guide.id, []]));
  for (const item of placements) (positionsByGuideMm[item.guide.id] ??= []).push(item.position);
  return { guides: { ...guides, paths: [...guides.paths, ...additions] }, positionsByGuideMm, restoredEdges };
}
