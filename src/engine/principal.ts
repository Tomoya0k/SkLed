import type { DivisionPath } from './divisions';
import { createPigtailChecker } from './connectivity';
import type { ConnectionLink } from './connectivity';
import { insideRegion, makeRectangle, pathPolyline, toSvg } from './distribution';
import type { LedPlacement, PhysicalScale, Polyline, Rectangle, Region } from './distribution';
import type { PartitionResult } from './partitions';
import { pathData, scaleRegion } from './regions';
import type { GeometryRegion } from './regions';
import type { SkeletonEdge, SkeletonResult } from './skeleton';
import type { Point, SvgModel } from './types';

export interface PrincipalConfig {
  moduleLengthMm: number;
  moduleWidthMm: number;
  freeGapMm: number;
  edgeMarginMm: number;
  criticalGapMm: number;
  leftPigtailMm: number;
  rightPigtailMm: number;
}

export interface PrincipalModule {
  id: string;
  pathId: string;
  figureId: string;
  center: Point;
  corners: [Point, Point, Point, Point];
  nearestGapMm: number | null;
  kind: 'normal' | 'enlace';
  reasons: string[];
}

export interface PrincipalCandidate {
  id: string;
  figureId: string;
  origin: 'skeleton' | 'partida';
  pathIds: string[];
  pathDs: string[];
  modules: PrincipalModule[];
  proposed: number;
  valid: number;
  discarded: number;
  contacts: number;
  borderConflicts: number;
  spacingConflicts: number;
  criticalCount: number;
  minimumGapMm: number | null;
  quality: number;
  eligible: boolean;
  reason: string | null;
  links: ConnectionLink[];
  pendingConflicts: string[];
  linkModules: number;
}

export interface PrincipalFigure {
  figureId: string;
  name: string;
  selected: PrincipalCandidate | null;
  diagnostic: PrincipalCandidate | null;
  candidates: PrincipalCandidate[];
}

export interface PrincipalResult {
  figures: PrincipalFigure[];
  total: number;
  discarded: number;
  conflicts: number;
}

interface Route { id: string; figureId: string; regionId: string; d: string; closed?: boolean }
interface Proposal { module: PrincipalModule; rectangle: Rectangle; positionMm: number; routeId: string }

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const delta = { x: b.x - a.x, y: b.y - a.y };
  const lengthSquared = dot(delta, delta);
  const t = lengthSquared ? Math.max(0, Math.min(1, dot({ x: p.x - a.x, y: p.y - a.y }, delta) / lengthSquared)) : 0;
  return distance(p, { x: a.x + t * delta.x, y: a.y + t * delta.y });
}

/** Exact minimum distance between two oriented rectangular LED bodies, including contact. */
export function bodyGap(a: Rectangle, b: Rectangle): number {
  for (const axis of [a.tangent, a.normal, b.tangent, b.normal]) {
    const project = (p: Point) => dot(p, axis);
    const aa = a.corners.map(project), bb = b.corners.map(project);
    if (Math.max(...aa) < Math.min(...bb) || Math.max(...bb) < Math.min(...aa)) {
      let gap = Infinity;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        gap = Math.min(gap, pointSegmentDistance(a.corners[i], b.corners[j], b.corners[(j + 1) % 4]));
        gap = Math.min(gap, pointSegmentDistance(b.corners[j], a.corners[i], a.corners[(i + 1) % 4]));
      }
      return gap;
    }
  }
  return 0;
}

function routeQuality(route: Route, scale: PhysicalScale): number {
  const line = pathPolyline(route as DivisionPath, scale);
  if (!line) return Infinity;
  let turn = 0;
  for (let i = 1; i + 1 < line.points.length; i++) {
    const a = line.points[i - 1], b = line.points[i], c = line.points[i + 1];
    const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: c.x - b.x, y: c.y - b.y };
    const lengths = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
    if (lengths > 1e-8) turn += Math.acos(Math.max(-1, Math.min(1, dot(u, v) / lengths)));
  }
  return turn / Math.max(line.length, 1);
}

/** Remove terminal spurs from a medial graph before proposing its central loop. */
function centralRoutes(edges: SkeletonEdge[], scale: PhysicalScale): Route[] {
  const result: Route[] = [];
  const byRegion = new Map<string, SkeletonEdge[]>();
  for (const edge of edges) byRegion.set(edge.regionId, [...(byRegion.get(edge.regionId) ?? []), edge]);
  for (const [regionId, regionEdges] of byRegion) {
    for (const edge of regionEdges.filter(edge => edge.closed || !edge.from || !edge.to)) {
      result.push({ id: edge.id, figureId: edge.figureId, regionId, d: edge.d, closed: edge.closed });
    }
    const graph = regionEdges.filter(edge => !edge.closed && edge.from && edge.to);
    const incident = new Map<string, SkeletonEdge[]>();
    for (const edge of graph) for (const node of [edge.from!, edge.to!]) incident.set(node, [...(incident.get(node) ?? []), edge]);
    const pending = new Set(graph.map(edge => edge.id));
    const length = (edge: SkeletonEdge) => edge.points.slice(1).reduce((sum, p, i) => sum + distance(p, edge.points[i]), 0);
    while (pending.size) {
      const seed = graph.find(edge => pending.has(edge.id))!;
      const component: SkeletonEdge[] = [], stack = [seed];
      pending.delete(seed.id);
      while (stack.length) {
        const edge = stack.pop()!;
        component.push(edge);
        for (const node of [edge.from!, edge.to!]) for (const other of incident.get(node) ?? []) if (pending.delete(other.id)) stack.push(other);
      }
      const remaining = new Set(component.map(edge => edge.id));
      let changed = true;
      while (changed) {
        changed = false;
        const degree = new Map<string, number>();
        for (const edge of component.filter(edge => remaining.has(edge.id))) for (const node of [edge.from!, edge.to!]) degree.set(node, (degree.get(node) ?? 0) + 1);
        for (const edge of component) if (remaining.has(edge.id) && ((degree.get(edge.from!) ?? 0) <= 1 || (degree.get(edge.to!) ?? 0) <= 1)) {
          remaining.delete(edge.id); changed = true;
        }
      }
      const core = component.filter(edge => remaining.has(edge.id));
      const append = (ordered: Array<{ edge: SkeletonEdge; forward: boolean }>, closed: boolean) => {
        const points: Point[] = [];
        for (const { edge, forward } of ordered) {
          const oriented = forward ? edge.points : [...edge.points].reverse();
          points.push(...(points.length ? oriented.slice(1) : oriented));
        }
        if (closed && points.length > 1 && distance(points[0], points.at(-1)!) < 1e-5) points.pop();
        if (points.length < 2) return;
        result.push({ id: `${regionId}-${closed ? 'centro-ciclo' : 'centro-eje'}-${result.length}`,
          figureId: seed.figureId, regionId, d: pathData(points.map(point => toSvg(point, scale)), closed), closed });
      };
      if (core.length) {
        const used = new Set<string>(), ordered: Array<{ edge: SkeletonEdge; forward: boolean }> = [];
        let node = core[0].from!, start = node;
        for (let guard = 0; guard < core.length; guard++) {
          const next = core.find(edge => !used.has(edge.id) && (edge.from === node || edge.to === node));
          if (!next) break;
          const forward = next.from === node;
          used.add(next.id); ordered.push({ edge: next, forward });
          node = forward ? next.to! : next.from!;
          if (node === start) break;
        }
        if (ordered.length > 0 && node === start) { append(ordered, true); continue; }
      }
      // Open medial trees: a single useful trunk, not every short diagonal spur.
      const degree = new Map<string, number>();
      for (const edge of component) for (const node of [edge.from!, edge.to!]) degree.set(node, (degree.get(node) ?? 0) + 1);
      const ends = [...degree].filter(([, count]) => count === 1).map(([node]) => node);
      let best: Array<{ edge: SkeletonEdge; forward: boolean }> = [];
      let bestLength = -1, visits = 0;
      const search = (node: string, used: Set<string>, ordered: Array<{ edge: SkeletonEdge; forward: boolean }>, total: number) => {
        if (++visits > 20000) return;
        if (total > bestLength) { bestLength = total; best = [...ordered]; }
        for (const edge of incident.get(node) ?? []) {
          if (!component.includes(edge) || used.has(edge.id)) continue;
          const forward = edge.from === node;
          used.add(edge.id); ordered.push({ edge, forward });
          search(forward ? edge.to! : edge.from!, used, ordered, total + length(edge));
          ordered.pop(); used.delete(edge.id);
        }
      };
      for (const end of ends.length ? ends : [component[0].from!]) search(end, new Set(), [], 0);
      if (best.length) append(best, false);
    }
  }
  return result;
}

function asPlacement(proposal: Proposal, number: number): LedPlacement {
  const { module } = proposal;
  return { id: module.id, figureId: module.figureId, divisionId: module.pathId, number, figureNumber: number,
    center: module.center, corners: module.corners, directionStart: module.center, directionEnd: module.center,
    arrow: [module.center, module.center, module.center], labelPoint: module.center };
}

function routePath(route: Route): DivisionPath {
  return { id: route.id, figureId: route.figureId, regionId: route.regionId, d: route.d,
    outerContourId: '', innerContourId: '', index: 0, fraction: 0 };
}

interface LinkPlan { links: ConnectionLink[]; misses: Array<[Proposal, Proposal]>; cableMm: number }

function orderedLinks(proposals: Proposal[], routes: Route[], guideRoutes: Route[], regionData: GeometryRegion[],
  scale: PhysicalScale, config: PrincipalConfig): LinkPlan {
  const placed = proposals.map((proposal, index) => asPlacement(proposal, index + 1));
  const byId = new Map(placed.map(module => [module.id, module]));
  const checker = createPigtailChecker(regionData, guideRoutes.map(routePath), placed,
    { lengthMm: config.moduleLengthMm, widthMm: config.moduleWidthMm,
      leftPigtailMm: config.leftPigtailMm, rightPigtailMm: config.rightPigtailMm }, scale);
  const links: ConnectionLink[] = [], misses: Array<[Proposal, Proposal]> = [];
  let cableMm = 0;
  for (const route of routes) {
    const ordered = proposals.filter(proposal => proposal.routeId === route.id).sort((a, b) => a.positionMm - b.positionMm);
    if (ordered.length < 2) continue;
    // A closed geometric contour is deliberately an open electrical chain.
    const options = ordered.slice(1).map((proposal, i) => checker(byId.get(ordered[i].module.id)!, byId.get(proposal.module.id)!));
    type State = { used: 'left' | 'right' | null; links: ConnectionLink[]; missed: number[]; length: number };
    let states: State[] = [{ used: null, links: [], missed: [], length: 0 }];
    for (let i = 0; i < options.length; i++) {
      const next: State[] = [];
      for (const state of states) {
        next.push({ ...state, used: null, missed: [...state.missed, i] });
        for (const link of options[i]) if (state.used !== link.fromSide) next.push({
          used: link.toSide, links: [...state.links, link], missed: state.missed, length: state.length + link.lengthMm,
        });
      }
      const best = new Map<string, State>();
      for (const state of next) {
        const key = state.used ?? 'none', current = best.get(key);
        if (!current || state.missed.length < current.missed.length ||
          (state.missed.length === current.missed.length && state.length < current.length)) best.set(key, state);
      }
      states = [...best.values()];
    }
    states.sort((a, b) => a.missed.length - b.missed.length || a.length - b.length);
    const best = states[0];
    links.push(...best.links); cableMm += best.length;
    misses.push(...best.missed.map(i => [ordered[i], ordered[i + 1]] as [Proposal, Proposal]));
  }
  return { links: links.map((link, index) => ({ ...link, id: `principal-link-${index + 1}` })), misses, cableMm };
}

function curvaturePositions(line: Polyline, a: number, b: number): number[] {
  const span = b - a;
  if (!(span > 1)) return [];
  const at = (position: number): Point => {
    const target = line.closed ? (position % line.length + line.length) % line.length : Math.max(0, Math.min(line.length, position));
    let low = 0, high = line.distances.length - 1;
    while (low + 1 < high) { const middle = (low + high) >> 1; if (line.distances[middle] <= target) low = middle; else high = middle; }
    const fraction = (target - line.distances[low]) / (line.distances[high] - line.distances[low] || 1);
    return { x: line.points[low].x + (line.points[high].x - line.points[low].x) * fraction,
      y: line.points[low].y + (line.points[high].y - line.points[low].y) * fraction };
  };
  const probe = Math.max(1, Math.min(5, span / 8));
  const heading = (position: number) => {
    const before = at(position - probe), after = at(position + probe);
    const magnitude = distance(before, after);
    return magnitude > 1e-8 ? { x: (after.x - before.x) / magnitude, y: (after.y - before.y) / magnitude } : null;
  };
  const locations = [a + span * 0.12, a + span * 0.35, a + span * 0.65, b - span * 0.12];
  const headings = locations.map(heading);
  let turn = 0;
  for (let i = 1; i < headings.length; i++) if (headings[i - 1] && headings[i])
    turn += Math.acos(Math.max(-1, Math.min(1, dot(headings[i - 1]!, headings[i]!))));
  if (turn < 0.28) return [];
  const vertices = line.distances.slice(1, -1).filter(position => position > a && position < b);
  return [...new Set([...vertices, (a + b) / 2, a * 0.75 + b * 0.25, a * 0.25 + b * 0.75])];
}

function bridgeCandidates(a: Proposal, b: Proposal, route: Route, skeletonEdges: SkeletonEdge[], scale: PhysicalScale,
  config: PrincipalConfig): Array<{ route: Route; position: number }> {
  const line = pathPolyline(routePath(route), scale);
  if (!line) return [];
  const positions = curvaturePositions(line, a.positionMm, b.positionMm).map(position => ({ route, position }));
  if (!positions.length) return [];
  // Terminal branches are only geometric search areas, never mandatory LED paths.
  for (const edge of skeletonEdges) {
    if (edge.regionId !== route.regionId || edge.id === route.id || edge.closed) continue;
    const branch: Route = { id: edge.id, figureId: edge.figureId, regionId: edge.regionId, d: edge.d };
    const branchLine = pathPolyline(routePath(branch), scale);
    if (!branchLine || branchLine.length < Math.max(1, config.moduleWidthMm / 2)) continue;
    const jointDistance = line.points.reduce((best, point, index) => {
      if (line.distances[index] < a.positionMm || line.distances[index] > b.positionMm) return best;
      return Math.min(best, distance(point, edge.points[0]), distance(point, edge.points.at(-1)!));
    }, Infinity);
    if (jointDistance > Math.max(1, config.moduleWidthMm / 4)) continue;
    for (const fraction of [0.25, 0.5, 0.75]) positions.push({ route: branch, position: branchLine.length * fraction });
  }
  return positions;
}

function physicalChecks(proposals: Proposal[], config: PrincipalConfig) {
  for (const proposal of proposals) proposal.module.reasons = proposal.module.reasons.filter(reason => reason === 'Borde o margen insuficiente');
  let contacts = 0, spacingConflicts = 0, minimumGapMm = Infinity;
  const nearest = new Array(proposals.length).fill(Infinity) as number[];
  for (let i = 0; i < proposals.length; i++) for (let j = i + 1; j < proposals.length; j++) {
    const gap = bodyGap(proposals[i].rectangle, proposals[j].rectangle);
    nearest[i] = Math.min(nearest[i], gap); nearest[j] = Math.min(nearest[j], gap);
    minimumGapMm = Math.min(minimumGapMm, gap);
    if (gap <= 1e-5) {
      contacts++;
      proposals[i].module.reasons.push('Contacto físico'); proposals[j].module.reasons.push('Contacto físico');
    } else if (gap + 1e-5 < config.freeGapMm) {
      spacingConflicts++;
      proposals[i].module.reasons.push('Separación libre insuficiente'); proposals[j].module.reasons.push('Separación libre insuficiente');
    }
  }
  let criticalCount = 0;
  for (let i = 0; i < proposals.length; i++) {
    const gap = nearest[i];
    proposals[i].module.nearestGapMm = Number.isFinite(gap) ? gap : null;
    if (gap + 1e-5 < config.criticalGapMm) {
      criticalCount++; proposals[i].module.reasons.push('Cercanía crítica');
    }
    proposals[i].module.reasons = [...new Set(proposals[i].module.reasons)];
  }
  return { contacts, spacingConflicts, criticalCount,
    minimumGapMm: Number.isFinite(minimumGapMm) ? minimumGapMm : null };
}

function evaluate(id: string, origin: 'skeleton' | 'partida', routes: Route[], regions: Map<string, Region>,
  regionData: GeometryRegion[], skeletonEdges: SkeletonEdge[], scale: PhysicalScale, config: PrincipalConfig): PrincipalCandidate {
  const proposals: Proposal[] = [];
  let proposed = 0, addedCount = 0, borderConflicts = 0, quality = 0;
  const desiredGap = Math.max(config.freeGapMm, config.criticalGapMm);
  for (const route of routes) {
    const line = pathPolyline(route as DivisionPath, scale);
    const region = regions.get(route.regionId);
    if (!line || !region || line.length + 1e-8 < config.moduleLengthMm) continue;
    quality += routeQuality(route, scale);
    const count = line.closed
      ? Math.floor(line.length / (config.moduleLengthMm + desiredGap))
      : Math.floor((line.length + desiredGap) / (config.moduleLengthMm + desiredGap));
    if (count < 1) continue;
    let optimized: Proposal[] | null = null;
    // Curved bodies can touch even when centerline spacing is correct. Try lower
    // densities and several phases before declaring the central route unusable.
    for (let slots = count; slots >= 1 && !optimized; slots--) for (const phase of line.closed ? [0.5, 0, 0.25, 0.75] : [0, config.moduleLengthMm / 4, config.moduleLengthMm / 2]) {
      if (optimized) break;
      const trial: Proposal[] = [];
      const trialPitch = line.closed ? line.length / slots : slots > 1 ? (line.length - 2 * phase) / (slots - 1) : line.length;
      let failed = false;
      for (let slot = 0; slot < slots; slot++) {
        const base = line.closed ? (slot + phase) * trialPitch : slots === 1 ? line.length / 2 : phase + slot * trialPitch;
        let accepted: { rectangle: Rectangle; at: number } | null = null;
        for (const shift of [0, -0.08, 0.08, -0.16, 0.16, -0.24, 0.24]) {
          const at = base + shift * trialPitch;
          if (!line.closed && (at < -1e-7 || at > line.length + 1e-7)) continue;
          const rectangle = makeRectangle(line, at, config.moduleLengthMm, config.moduleWidthMm);
          if (!rectangle || !insideRegion(rectangle, region, config.edgeMarginMm) ||
            [...proposals, ...trial].some(other => bodyGap(other.rectangle, rectangle) + 1e-5 < config.freeGapMm)) continue;
          accepted = { rectangle, at }; break;
        }
        if (!accepted) { failed = true; break; }
        trial.push({ rectangle: accepted.rectangle, positionMm: accepted.at, routeId: route.id,
          module: { id: `${id}-${route.id}-${slot}`, pathId: route.id, figureId: route.figureId,
            center: toSvg(accepted.rectangle.center, scale),
            corners: accepted.rectangle.corners.map(point => toSvg(point, scale)) as [Point, Point, Point, Point],
            nearestGapMm: null, kind: 'normal', reasons: [] } });
      }
      if (failed) continue;
      const checks = physicalChecks([...proposals, ...trial], config);
      if (checks.contacts || checks.spacingConflicts || checks.criticalCount > (proposals.length + trial.length) / 2) continue;
      optimized = trial;
    }
    if (optimized) { proposed += optimized.length; proposals.push(...optimized); continue; }
    const pitch = line.closed ? line.length / count : count > 1 ? (line.length - config.moduleLengthMm) / (count - 1) : line.length;
    for (let slot = 0; slot < count; slot++) {
      proposed++;
      const base = line.closed ? (slot + 0.5) * pitch : count === 1 ? line.length / 2 : config.moduleLengthMm / 2 + slot * pitch;
      let accepted: Rectangle | null = null;
      let closest: Rectangle | null = null;
      let acceptedAt = base;
      for (const shift of [0, -0.08, 0.08, -0.16, 0.16, -0.24, 0.24]) {
        const at = base + shift * pitch;
        if (!line.closed && (at < config.moduleLengthMm / 2 - 1e-7 || at > line.length - config.moduleLengthMm / 2 + 1e-7)) continue;
        const rectangle = makeRectangle(line, at, config.moduleLengthMm, config.moduleWidthMm);
        if (!rectangle) continue;
        closest ??= rectangle;
        if (insideRegion(rectangle, region, config.edgeMarginMm)) { accepted = rectangle; acceptedAt = at; break; }
      }
      const rectangle = accepted ?? closest;
      if (!rectangle) { borderConflicts++; continue; }
      if (!accepted) borderConflicts++;
      proposals.push({ rectangle, positionMm: acceptedAt, routeId: route.id, module: {
        id: `${id}-${route.id}-${slot}`, pathId: route.id, figureId: route.figureId,
        center: toSvg(rectangle.center, scale),
        corners: rectangle.corners.map(point => toSvg(point, scale)) as [Point, Point, Point, Point],
        nearestGapMm: null, kind: 'normal', reasons: accepted ? [] : ['Borde o margen insuficiente'],
      } });
    }
  }
  let checks = physicalChecks(proposals, config);
  let links: ConnectionLink[] = [], pendingConflicts: string[] = [];
  if (proposed > 0 && !borderConflicts && !checks.contacts && !checks.spacingConflicts && checks.criticalCount <= proposals.length / 2) {
    const guides = [...routes];
    let plan = orderedLinks(proposals, routes, guides, regionData, scale, config);
    // Only a missing real connection triggers a search; no LED is added just because a corner exists.
    for (let pass = 0; pass < proposals.length; pass++) {
      const unresolved = plan.misses.find(([a, b]) => a.routeId === b.routeId && a.module.kind === 'normal' && b.module.kind === 'normal');
      if (!unresolved) break;
      const [a, b] = unresolved, route = routes.find(item => item.id === a.routeId)!;
      const routeLine = pathPolyline(routePath(route), scale), routeRegion = regions.get(route.regionId);
      if (!routeLine || !routeRegion || !curvaturePositions(routeLine, a.positionMm, b.positionMm).length) break;
      // First try moving an existing LED a little along the same central guide.
      let moved: { old: Proposal; replacement: Proposal; plan: LinkPlan } | null = null;
      for (const old of [a, b]) for (const fraction of [-0.75, -0.5, -0.3, -0.2, -0.1, 0.1, 0.2, 0.3, 0.5, 0.75]) {
        const at = old.positionMm + fraction * config.moduleLengthMm;
        if (!routeLine.closed && (at < 0 || at > routeLine.length)) continue;
        const rectangle = makeRectangle(routeLine, at, config.moduleLengthMm, config.moduleWidthMm);
        if (!rectangle || !insideRegion(rectangle, routeRegion, config.edgeMarginMm) ||
          proposals.some(other => other !== old && bodyGap(other.rectangle, rectangle) + 1e-5 < Math.max(config.freeGapMm, config.criticalGapMm))) continue;
        const replacement: Proposal = { ...old, rectangle, positionMm: at, module: { ...old.module,
          center: toSvg(rectangle.center, scale), corners: rectangle.corners.map(point => toSvg(point, scale)) as [Point, Point, Point, Point] } };
        const trial = orderedLinks(proposals.map(item => item === old ? replacement : item), routes, guides, regionData, scale, config);
        if (trial.misses.length >= plan.misses.length) continue;
        if (!moved || trial.misses.length < moved.plan.misses.length ||
          (trial.misses.length === moved.plan.misses.length && trial.cableMm < moved.plan.cableMm)) moved = { old, replacement, plan: trial };
      }
      if (moved) {
        proposals[proposals.indexOf(moved.old)] = moved.replacement;
        plan = moved.plan;
        if (!plan.misses.length) break;
        continue;
      }
      let best: { proposal: Proposal; guide: Route; plan: LinkPlan } | null = null;
      for (const position of bridgeCandidates(a, b, route, origin === 'skeleton' ? skeletonEdges : [], scale, config)) {
        const line = pathPolyline(routePath(position.route), scale), region = regions.get(position.route.regionId);
        if (!line || !region) continue;
        const rectangle = makeRectangle(line, position.position, config.moduleLengthMm, config.moduleWidthMm);
        if (!rectangle || !insideRegion(rectangle, region, config.edgeMarginMm)) continue;
        if (proposals.some(existing => bodyGap(existing.rectangle, rectangle) + 1e-5 < Math.max(config.freeGapMm, config.criticalGapMm))) continue;
        const proposal: Proposal = { rectangle, routeId: route.id, positionMm: (a.positionMm + b.positionMm) / 2,
          module: { id: `${id}-enlace-${proposals.length}`, pathId: position.route.id, figureId: route.figureId,
            center: toSvg(rectangle.center, scale), corners: rectangle.corners.map(point => toSvg(point, scale)) as [Point, Point, Point, Point],
            nearestGapMm: null, kind: 'enlace', reasons: [] } };
        const trialGuides = position.route.id === route.id ? guides : [...guides, position.route];
        const trial = orderedLinks([...proposals, proposal], routes, trialGuides, regionData, scale, config);
        const connects = (first: string, second: string) => trial.links.some(link =>
          (link.fromId === first && link.toId === second) || (link.fromId === second && link.toId === first));
        if (!connects(a.module.id, proposal.module.id) || !connects(proposal.module.id, b.module.id)) continue;
        if (trial.misses.length >= plan.misses.length) continue;
        if (!best || trial.misses.length < best.plan.misses.length ||
          (trial.misses.length === best.plan.misses.length && trial.cableMm < best.plan.cableMm)) best = { proposal, guide: position.route, plan: trial };
      }
      if (!best) break;
      proposals.push(best.proposal);
      addedCount++;
      if (!guides.some(guide => guide.id === best.guide.id)) guides.push(best.guide);
      plan = best.plan;
      if (!plan.misses.length) break;
    }
    links = plan.links;
    pendingConflicts = plan.misses.map(([a, b]) => `Sin enlace pigtail entre módulos ${proposals.indexOf(a) + 1} y ${proposals.indexOf(b) + 1}.`);
    if (!pendingConflicts.length) {
      const placements = proposals.map((proposal, number) => asPlacement(proposal, number + 1));
      const byId = new Map(placements.map(module => [module.id, module]));
      const checker = createPigtailChecker(regionData, guides.map(routePath), placements,
        { lengthMm: config.moduleLengthMm, widthMm: config.moduleWidthMm,
          leftPigtailMm: config.leftPigtailMm, rightPigtailMm: config.rightPigtailMm }, scale);
      for (const route of routes) {
      const line = pathPolyline(routePath(route), scale);
      if (!line) continue;
      const ordered = proposals.filter(proposal => proposal.routeId === route.id).sort((a, b) => a.positionMm - b.positionMm);
      for (let index = 1; index + 1 < ordered.length; index++) {
        const a = ordered[index - 1], c = ordered[index], b = ordered[index + 1];
        if (c.module.kind === 'enlace' || !curvaturePositions(line, a.positionMm, b.positionMm).length) continue;
        const linked = (first: string, second: string) => links.some(link =>
          (link.fromId === first && link.toId === second) || (link.fromId === second && link.toId === first));
        if (!linked(a.module.id, c.module.id) || !linked(c.module.id, b.module.id)) continue;
        if (!checker(byId.get(a.module.id)!, byId.get(b.module.id)!, c.module.id).length) c.module.kind = 'enlace';
      }
      }
    }
    checks = physicalChecks(proposals, config);
  }
  const modules = proposals.map(item => item.module);
  const discarded = modules.filter(module => module.reasons.length > 0).length + Math.max(0, proposed - modules.length);
  const valid = modules.filter(module => module.reasons.length === 0).length;
  const majorityCritical = checks.criticalCount > modules.length / 2;
  const reason = proposed === 0 ? 'No cabe un módulo longitudinalmente' : borderConflicts ? 'Módulos invaden borde o margen' : checks.contacts ? 'Contacto físico entre módulos' : checks.spacingConflicts ? 'Separación libre insuficiente' : majorityCritical ? 'Mayoría con cercanía crítica' : pendingConflicts.length ? 'Conexiones pigtail pendientes' : null;
  return { id, figureId: routes[0].figureId, origin, pathIds: routes.map(route => route.id), pathDs: routes.map(route => route.d),
    modules, proposed: proposed + addedCount, valid, discarded,
    contacts: checks.contacts, borderConflicts, spacingConflicts: checks.spacingConflicts, criticalCount: checks.criticalCount,
    minimumGapMm: checks.minimumGapMm, quality, eligible: reason === null, reason, links, pendingConflicts,
    linkModules: modules.filter(module => module.kind === 'enlace').length };
}

/** Compare physical route configurations without changing the existing LED distribution or connectivity. */
export function selectPrincipalRoutes(model: SvgModel, skeleton: SkeletonResult, partitions: PartitionResult,
  config: PrincipalConfig, widthMm: number, heightMm: number): PrincipalResult {
  if (![config.moduleLengthMm, config.moduleWidthMm, widthMm, heightMm].every(n => Number.isFinite(n) && n > 0) ||
    ![config.freeGapMm, config.edgeMarginMm, config.criticalGapMm, config.leftPigtailMm, config.rightPigtailMm].every(n => Number.isFinite(n) && n >= 0)) {
    throw new Error('Revisa las medidas físicas del SVG y del módulo.');
  }
  const scale = { x: widthMm / model.viewBox.width, y: heightMm / model.viewBox.height };
  const regions = new Map(skeleton.regions.map(region => {
    const physical = scaleRegion(region, scale);
    return [region.id, { outer: physical.outer, inner: null, holes: physical.holes } as Region] as const;
  }));
  const figures = model.figures.map(figure => {
    const figureEdges = skeleton.edges.filter(edge => edge.figureId === figure.id);
    const skeletonRoutes = centralRoutes(figureEdges, scale);
    const partitionRoutes: Route[] = partitions.paths.filter(path => path.figureId === figure.id).map(path => ({ id: path.id, figureId: path.figureId, regionId: path.regionId, d: path.d }));
    const groups: Array<{ id: string; origin: 'skeleton' | 'partida'; routes: Route[] }> = [];
    for (const [index, route] of skeletonRoutes.entries()) groups.push({ id: `${figure.id}-skeleton-${index}`, origin: 'skeleton', routes: [route] });
    if (partitionRoutes.length) groups.push({ id: `${figure.id}-partidas`, origin: 'partida', routes: partitionRoutes });
    for (const route of partitionRoutes) groups.push({ id: `${route.id}-solo`, origin: 'partida', routes: [route] });
    // Paired lanes are evaluated together, so a conflict between them cannot be hidden.
    const pairGroups = new Map<string, Route[]>();
    for (const path of partitions.paths.filter(path => path.figureId === figure.id && path.lane !== 0)) {
      const key = `${path.sourceEdgeId}:${path.sourceRange.join(':')}`;
      pairGroups.set(key, [...(pairGroups.get(key) ?? []), { id: path.id, figureId: path.figureId, regionId: path.regionId, d: path.d }]);
    }
    for (const [key, routes] of pairGroups) if (routes.length === 2) groups.push({ id: `${figure.id}-pair-${key}`, origin: 'partida', routes });
    const skeletonCandidates = groups.filter(group => group.origin === 'skeleton').map(group =>
      evaluate(group.id, group.origin, group.routes, regions, skeleton.regions, figureEdges, scale, config));
    const rank = (a: PrincipalCandidate, b: PrincipalCandidate) => b.valid - a.valid ||
      a.linkModules - b.linkModules || (b.minimumGapMm ?? 1e9) - (a.minimumGapMm ?? 1e9) ||
      a.quality - b.quality || a.id.localeCompare(b.id);
    const central = skeletonCandidates.filter(candidate => candidate.eligible).sort(rank)[0] ?? null;
    const alternatives = central ? [] : groups.filter(group => group.origin === 'partida').map(group =>
      evaluate(group.id, group.origin, group.routes, regions, skeleton.regions, figureEdges, scale, config));
    const candidates = [...skeletonCandidates, ...alternatives];
    const selected = central ?? alternatives.filter(candidate => candidate.eligible).sort(rank)[0] ?? null;
    const diagnostic = selected ? null : candidates.filter(candidate => candidate.origin === 'skeleton' && candidate.proposed > 0).sort(rank)[0] ??
      candidates.filter(candidate => candidate.proposed > 0).sort(rank)[0] ?? null;
    return { figureId: figure.id, name: figure.name, selected, diagnostic, candidates };
  });
  return {
    figures,
    total: figures.reduce((sum, figure) => sum + (figure.selected?.valid ?? 0), 0),
    discarded: figures.reduce((sum, figure) => sum + (figure.selected?.discarded ?? figure.diagnostic?.discarded ?? 0), 0),
    conflicts: figures.reduce((sum, figure) => sum + (figure.selected?.pendingConflicts.length ?? figure.diagnostic?.pendingConflicts.length ?? 0) +
      (figure.selected?.criticalCount ?? figure.diagnostic?.criticalCount ?? 0) +
      (figure.selected?.contacts ?? figure.diagnostic?.contacts ?? 0) + (figure.selected?.borderConflicts ?? figure.diagnostic?.borderConflicts ?? 0) +
      (figure.selected?.spacingConflicts ?? figure.diagnostic?.spacingConflicts ?? 0), 0),
  };
}
