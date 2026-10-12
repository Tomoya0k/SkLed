import type { DivisionPath, DivisionResult } from './divisions';
import { createModuleGeometry } from './module';
import type { ModuleMeasurements } from './module';
import type { Point, SvgModel } from './types';
import { pathData } from './regions';

const NS = 'http://www.w3.org/2000/svg';

export interface LedPlacement {
  id: string;
  figureId: string;
  divisionId: string;
  regionId?: string;
  positionMm?: number;
  rowRunId?: string;
  number: number;
  figureNumber: number;
  center: Point;
  corners: [Point, Point, Point, Point];
  directionStart: Point;
  directionEnd: Point;
  arrow: [Point, Point, Point];
  labelPoint: Point;
}

export interface FigureDistribution {
  figureId: string;
  name: string;
  placed: number;
  unplaced: number;
}

export interface LedDistributionResult {
  modules: LedPlacement[];
  byFigure: FigureDistribution[];
  total: number;
  unplaced: number;
  rowBreaks?: Array<{ divisionId: string; fromId: string; toId: string; gapMm: number }>;
  routeRuns?: Array<{ id: string; divisionId: string; regionId?: string; figureId: string; d: string; moduleIds: string[] }>;
}

export interface PlacementOptions {
  minimumGapMm?: number;
  maximumGapMm?: number;
  bodyGapMm?: number;
  edgeMarginMm?: number;
}

export interface PhysicalScale { x: number; y: number }
export interface Polyline { points: Point[]; distances: number[]; length: number; closed: boolean }
export interface Region { outer: Point[]; inner: Point[] | null; holes?: Point[][] }
export interface Rectangle { center: Point; corners: [Point, Point, Point, Point]; tangent: Point; normal: Point; halfLength: number; halfWidth: number }

export const toMm = (point: Point, scale: PhysicalScale): Point => ({ x: point.x * scale.x, y: point.y * scale.y });
export const toSvg = (point: Point, scale: PhysicalScale): Point => ({ x: point.x / scale.x, y: point.y / scale.y });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathPolyline(path: DivisionPath, scale: PhysicalScale): Polyline | null {
  // Legacy divisions and skeleton-derived partitions use M/L/Z, including two-point open lines.
  const numbers = path.d.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g)?.map(Number) ?? [];
  if (numbers.length < 4 || numbers.length % 2) return null;
  const points: Point[] = [];
  for (let index = 0; index < numbers.length; index += 2) points.push(toMm({ x: numbers[index], y: numbers[index + 1] }, scale));
  const closed = /z\s*$/i.test(path.d);
  if (closed) points.push(points[0]);
  const distances = [0];
  for (let index = 1; index < points.length; index++) distances.push(distances[index - 1] + distance(points[index - 1], points[index]));
  return distances.at(-1)! > 0 ? { points, distances, length: distances.at(-1)!, closed } : null;
}

export function pointAt(polyline: Polyline, distanceMm: number): Point {
  const target = polyline.closed ? ((distanceMm % polyline.length) + polyline.length) % polyline.length : Math.max(0, Math.min(polyline.length, distanceMm));
  let low = 0, high = polyline.distances.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (polyline.distances[middle] <= target) low = middle;
    else high = middle;
  }
  const span = polyline.distances[high] - polyline.distances[low];
  const fraction = span > 0 ? (target - polyline.distances[low]) / span : 0;
  return {
    x: polyline.points[low].x + (polyline.points[high].x - polyline.points[low].x) * fraction,
    y: polyline.points[low].y + (polyline.points[high].y - polyline.points[low].y) * fraction,
  };
}

export function makeRectangle(polyline: Polyline, position: number, lengthMm: number, widthMm: number): Rectangle | null {
  const center = pointAt(polyline, position);
  const probe = Math.min(lengthMm / 4, Math.max(widthMm / 2, 0.5));
  const before = pointAt(polyline, position - probe), after = pointAt(polyline, position + probe);
  const magnitude = distance(before, after);
  if (magnitude < 1e-8) return null;
  const tangent = { x: (after.x - before.x) / magnitude, y: (after.y - before.y) / magnitude };
  const normal = { x: -tangent.y, y: tangent.x };
  const halfLength = lengthMm / 2, halfWidth = widthMm / 2;
  const corner = (along: number, across: number): Point => ({
    x: center.x + along * tangent.x + across * normal.x,
    y: center.y + along * tangent.y + across * normal.y,
  });
  return { center, tangent, normal, halfLength, halfWidth, corners: [
    corner(-halfLength, -halfWidth), corner(halfLength, -halfWidth),
    corner(halfLength, halfWidth), corner(-halfLength, halfWidth),
  ] };
}

function polygonFromContour(d: string, scale: PhysicalScale, widthMm: number): Point[] {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  const length = path.getTotalLength();
  const sampleStep = Math.max(0.15, Math.min(0.75, widthMm / 4));
  const count = Math.min(6000, Math.max(128, Math.ceil(length * Math.max(scale.x, scale.y) / sampleStep)));
  return Array.from({ length: count }, (_, index) => {
    const point = path.getPointAtLength(length * index / count);
    return toMm({ x: point.x, y: point.y }, scale);
  });
}

function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function expandedCorners(rectangle: Rectangle, clearance: number): [Point, Point, Point, Point] {
  const { center, tangent, normal } = rectangle;
  const along = rectangle.halfLength + clearance, across = rectangle.halfWidth + clearance;
  const corner = (u: number, v: number): Point => ({ x: center.x + u * tangent.x + v * normal.x, y: center.y + u * tangent.y + v * normal.y });
  return [corner(-along, -across), corner(along, -across), corner(along, across), corner(-along, across)];
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return abC * abD <= 0 && cdA * cdB <= 0 &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
}

function pointInRectangle(point: Point, rectangle: Rectangle, clearance: number): boolean {
  const dx = point.x - rectangle.center.x, dy = point.y - rectangle.center.y;
  return Math.abs(dx * rectangle.tangent.x + dy * rectangle.tangent.y) <= rectangle.halfLength + clearance &&
    Math.abs(dx * rectangle.normal.x + dy * rectangle.normal.y) <= rectangle.halfWidth + clearance;
}

function crossesBoundary(corners: Point[], boundary: Point[], rectangle: Rectangle, clearance: number): boolean {
  const minX = Math.min(...corners.map(point => point.x)), maxX = Math.max(...corners.map(point => point.x));
  const minY = Math.min(...corners.map(point => point.y)), maxY = Math.max(...corners.map(point => point.y));
  for (let index = 0; index < boundary.length; index++) {
    const a = boundary[index], b = boundary[(index + 1) % boundary.length];
    if (Math.max(a.x, b.x) < minX || Math.min(a.x, b.x) > maxX || Math.max(a.y, b.y) < minY || Math.min(a.y, b.y) > maxY) continue;
    if (pointInRectangle(a, rectangle, clearance)) return true;
    for (let edge = 0; edge < 4; edge++) {
      if (segmentsIntersect(corners[edge], corners[(edge + 1) % 4], a, b)) return true;
    }
  }
  return false;
}

export function insideRegion(rectangle: Rectangle, region: Region, clearance: number): boolean {
  const corners = expandedCorners(rectangle, clearance);
  const holes = region.holes ?? (region.inner ? [region.inner] : []);
  if (!corners.every(point => insidePolygon(point, region.outer) && !holes.some(hole => insidePolygon(point, hole)))) return false;
  if (crossesBoundary(corners, region.outer, rectangle, clearance)) return false;
  if (holes.some(hole => crossesBoundary(corners, hole, rectangle, clearance))) return false;
  return true;
}

function overlaps(a: Rectangle, b: Rectangle): boolean {
  for (const axis of [a.tangent, a.normal, b.tangent, b.normal]) {
    const projection = (point: Point) => point.x * axis.x + point.y * axis.y;
    const aValues = a.corners.map(projection), bValues = b.corners.map(projection);
    if (Math.max(...aValues) <= Math.min(...bValues) || Math.max(...bValues) <= Math.min(...aValues)) return false;
  }
  return true;
}

/** Minimum physical distance between oriented bodies, including overlap/contact. */
export function rectangleGap(a: Rectangle, b: Rectangle): number {
  if (overlaps(a, b)) return 0;
  const pointSegment = (p: Point, start: Point, end: Point) => {
    const dx = end.x - start.x, dy = end.y - start.y;
    const t = Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
    return distance(p, { x: start.x + t * dx, y: start.y + t * dy });
  };
  let gap = Infinity;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    gap = Math.min(gap, pointSegment(a.corners[i], b.corners[j], b.corners[(j + 1) % 4]), pointSegment(b.corners[j], a.corners[i], a.corners[(i + 1) % 4]));
  }
  return gap;
}

/** Provisional placement on existing division paths; no electrical connection is inferred. */
export function distributeLeds(model: SvgModel, divisions: DivisionResult, measurements: ModuleMeasurements, widthMm: number, heightMm: number, options: PlacementOptions = {}): LedDistributionResult {
  const geometry = createModuleGeometry(measurements);
  if (![widthMm, heightMm].every(value => Number.isFinite(value) && value > 0)) throw new Error('Indica el ancho y el alto físicos del SVG.');
  const scale = { x: widthMm / model.viewBox.width, y: heightMm / model.viewBox.height };
  const contourById = new Map(model.figures.flatMap(figure => figure.contours).map(contour => [contour.id, contour]));
  const polygonCache = new Map<string, Point[]>();
  const polygon = (id: string) => {
    let value = polygonCache.get(id);
    if (!value) {
      value = polygonFromContour(contourById.get(id)!.d, scale, measurements.widthMm);
      polygonCache.set(id, value);
    }
    return value;
  };
  const byFigure = model.figures.map(figure => ({ figureId: figure.id, name: figure.name, placed: 0, unplaced: 0 }));
  const stats = new Map(byFigure.map(item => [item.figureId, item]));
  const modules: LedPlacement[] = [];
  const placed: Array<{ rectangle: Rectangle; division: DivisionPath }> = [];
  const rowBreaks: NonNullable<LedDistributionResult['rowBreaks']> = [];
  const routeRuns: NonNullable<LedDistributionResult['routeRuns']> = [];
  const lengthMm = geometry.body.lengthMm, bodyWidthMm = geometry.widthMm;
  // A conservative gap estimate: each side must be long enough on its own.
  // Do not add both pigtails or infer a valid electrical connection.
  const gapBudgetMm = Math.min(geometry.leftPigtail.lengthMm, geometry.rightPigtail.lengthMm);
  const minimumGap = options.minimumGapMm ?? 0;
  const maximumGap = options.maximumGapMm ?? Infinity;
  const bodyGap = options.bodyGapMm ?? 0;
  const clearance = options.edgeMarginMm ?? Math.min(0.2, bodyWidthMm * 0.05);
  if (![minimumGap, bodyGap, clearance].every(n => Number.isFinite(n) && n >= 0) || !(maximumGap >= minimumGap)) throw new Error('Revisa la separación mínima, máxima y el margen de los módulos.');
  const desiredGap = Math.max(minimumGap, Math.min(maximumGap, gapBudgetMm));
  // Fit the central terminal branches first so a paired lane cannot crowd a tip.
  const lane = (path: DivisionPath) => (path as DivisionPath & { lane?: number }).lane;
  const paths = [...divisions.paths].sort((a, b) => Number(!!lane(a)) - Number(!!lane(b)));
  for (const division of paths) {
    const stat = stats.get(division.figureId);
    if (!stat) continue;
    const route = pathPolyline(division, scale);
    if (!route) { stat.unplaced++; continue; }
    const sourceRegion = divisions.regions?.find(region => region.id === division.regionId);
    const region: Region = sourceRegion ? { outer: sourceRegion.outer.map(p => toMm(p, scale)), inner: null,
      holes: sourceRegion.holes.map(hole => hole.map(p => toMm(p, scale))) } :
      { outer: polygon(division.outerContourId), inner: division.innerContourId ? polygon(division.innerContourId) : null };
    // Floor preserves the desired gap. Ceil compressed a row below its own
    // pigtail spacing; independent slot shifts then compressed it further.
    const slots = Math.max(1, Math.floor((route.length + (route.closed ? 0 : desiredGap)) / (lengthMm + desiredGap)));
    const pitch = route.closed ? route.length / slots : slots > 1 ? (route.length - lengthMm) / (slots - 1) : route.length;
    const fitsGuide = (position: number) => route.closed || (division.bodyFiltered
      ? position >= lengthMm / 2 - 1e-6 && position <= route.length - lengthMm / 2 + 1e-6
      : position >= 0 && position <= route.length);
    const sameRow = (a: Rectangle, b: Rectangle, other: DivisionPath) => {
      if (division.id === other.id) return true;
      const dx = a.center.x - b.center.x, dy = a.center.y - b.center.y;
      return Math.abs(a.tangent.x * b.tangent.x + a.tangent.y * b.tangent.y) > 0.85 && Math.abs(dx * a.tangent.y - dy * a.tangent.x) < bodyWidthMm * 0.9;
    };
    type Proposal = { rectangle: Rectangle; position: number };
    const valid = (candidate: Rectangle, local: Proposal[]) => insideRegion(candidate, region, clearance) &&
      !placed.some(other => overlaps(candidate, other.rectangle) || rectangleGap(candidate, other.rectangle) + 1e-5 < (sameRow(candidate, other.rectangle, other.division) ? Math.max(bodyGap, minimumGap) : bodyGap)) &&
      !local.some(other => overlaps(candidate, other.rectangle) || rectangleGap(candidate, other.rectangle) + 1e-5 < Math.max(bodyGap, minimumGap));
    let best: Proposal[] = [];
    for (const phase of [0, 0.15, -0.15]) {
      const proposals: Proposal[] = [];
      for (let slot = 0; slot < slots; slot++) {
        const base = (route.closed ? (slot + 0.5) * pitch : slots === 1 ? route.length / 2 : lengthMm / 2 + slot * pitch) + phase * pitch;
        for (const shift of [0, -0.12, 0.12, -0.24, 0.24, -0.36, 0.36, -0.5, 0.5]) {
          const rawPosition = base + shift * pitch;
          const position = route.closed ? (rawPosition % route.length + route.length) % route.length : rawPosition;
          // Filtered partitions cannot reintroduce bodies extending beyond a
          // short guide. Legacy guides retain their original placement rules.
          if (!fitsGuide(position)) continue;
          const candidate = makeRectangle(route, position, lengthMm, bodyWidthMm);
          if (candidate && valid(candidate, proposals)) { proposals.push({ rectangle: candidate, position }); break; }
        }
      }
      if (proposals.length > best.length) best = proposals;
      if (best.length === slots) break;
    }
    best.sort((a, b) => a.position - b.position);
    // Repair a skipped slot where another physical body can bridge the gap.
    for (let i = 1; i < best.length; i++) {
      const gap = Math.max(rectangleGap(best[i - 1].rectangle, best[i].rectangle), best[i].position - best[i - 1].position - lengthMm);
      if (gap <= maximumGap + 1e-5) continue;
      const before = best[i - 1], after = best[i];
      let repaired = false;
      for (const [item, direction] of [[after, -1], [before, 1]] as const) {
        const position = item.position + direction * (gap - maximumGap + 1);
        if (!fitsGuide(position)) continue;
        const candidate = makeRectangle(route, position, lengthMm, bodyWidthMm);
        if (!candidate || !valid(candidate, best.filter(other => other !== item))) continue;
        item.position = position; item.rectangle = candidate;
        if (Math.max(rectangleGap(before.rectangle, after.rectangle), after.position - before.position - lengthMm) <= maximumGap + 1e-5) { repaired = true; break; }
      }
      if (repaired) continue;
      const positions = [(before.position + after.position) / 2, before.position + lengthMm + desiredGap, after.position - lengthMm - desiredGap];
      for (let at = before.position + lengthMm + minimumGap; at <= after.position - lengthMm - minimumGap; at += Math.max(1, bodyWidthMm / 3)) positions.push(at);
      for (const position of positions) {
        if (!fitsGuide(position)) continue;
        const candidate = makeRectangle(route, position, lengthMm, bodyWidthMm);
        if (candidate && valid(candidate, best)) { best.splice(i, 0, { rectangle: candidate, position }); i--; break; }
      }
    }
    best.sort((a, b) => a.position - b.position);
    stat.unplaced += Math.max(0, slots - best.length);
    const rowModules: LedPlacement[] = [];
    for (const [slot, proposal] of best.entries()) {
      const accepted = proposal.rectangle;
      placed.push({ rectangle: accepted, division });
      stat.placed++;
      const forward = (fraction: number): Point => ({
        x: accepted.center.x + accepted.tangent.x * lengthMm * fraction,
        y: accepted.center.y + accepted.tangent.y * lengthMm * fraction,
      });
      const offset = (point: Point, amount: number): Point => ({ x: point.x + accepted!.normal.x * amount, y: point.y + accepted!.normal.y * amount });
      const tip = offset(forward(0.38), -bodyWidthMm * 0.2);
      const arrowSize = Math.min(bodyWidthMm * 0.19, lengthMm * 0.07);
      const arrowBase = { x: tip.x - accepted.tangent.x * arrowSize, y: tip.y - accepted.tangent.y * arrowSize };
      const module: LedPlacement = {
        id: `${division.id}-${slot}`, figureId: division.figureId, divisionId: division.id,
        regionId: division.regionId, positionMm: proposal.position,
        number: modules.length + 1, figureNumber: stat.placed,
        center: toSvg(accepted.center, scale),
        corners: accepted.corners.map(point => toSvg(point, scale)) as [Point, Point, Point, Point],
        directionStart: toSvg(offset(forward(-0.12), -bodyWidthMm * 0.2), scale),
        directionEnd: toSvg(tip, scale),
        arrow: [tip, offset(arrowBase, arrowSize * 0.55), offset(arrowBase, -arrowSize * 0.55)].map(point => toSvg(point, scale)) as [Point, Point, Point],
        labelPoint: toSvg(offset(accepted.center, bodyWidthMm * 0.23), scale),
      };
      modules.push(module); rowModules.push(module);
    }
    const runs: number[][] = best.length ? [[0]] : [];
    for (let i = 1; i < best.length; i++) {
      const gapMm = Math.max(rectangleGap(best[i - 1].rectangle, best[i].rectangle), best[i].position - best[i - 1].position - lengthMm);
      if (gapMm > maximumGap + 1e-5) { rowBreaks.push({ divisionId: division.id, fromId: rowModules[i - 1].id, toId: rowModules[i].id, gapMm }); runs.push([]); }
      runs.at(-1)!.push(i);
    }
    const seamGap = route.closed && best.length > 1 ? Math.max(rectangleGap(best.at(-1)!.rectangle, best[0].rectangle), route.length + best[0].position - best.at(-1)!.position - lengthMm) : Infinity;
    for (const [runIndex, indices] of runs.entries()) {
      const id = `${division.id}-run-${runIndex}`;
      const first = best[indices[0]].position, last = best[indices.at(-1)!].position;
      const from = Math.max(0, first - lengthMm / 2), to = Math.min(route.length, last + lengthMm / 2);
      const points = [pointAt(route, from), ...route.points.filter((_, i) => route.distances[i] > from && route.distances[i] < to), pointAt(route, to)].map(p => toSvg(p, scale));
      for (const i of indices) rowModules[i].rowRunId = id;
      routeRuns.push({ id, divisionId: division.id, regionId: division.regionId, figureId: division.figureId,
        d: route.closed && best.length > 1 && runs.length === 1 && seamGap <= maximumGap + 1e-5 ? division.d : pathData(points), moduleIds: indices.map(i => rowModules[i].id) });
    }
  }
  return { modules, byFigure, total: modules.length, unplaced: byFigure.reduce((sum, figure) => sum + figure.unplaced, 0), rowBreaks, routeRuns };
}
