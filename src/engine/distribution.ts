import type { DivisionPath, DivisionResult } from './divisions';
import { createModuleGeometry } from './module';
import type { ModuleMeasurements } from './module';
import type { Point, SvgModel } from './types';

const NS = 'http://www.w3.org/2000/svg';

export interface LedPlacement {
  id: string;
  figureId: string;
  divisionId: string;
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

function pointAt(polyline: Polyline, distanceMm: number): Point {
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

/** Provisional placement on existing division paths; no electrical connection is inferred. */
export function distributeLeds(model: SvgModel, divisions: DivisionResult, measurements: ModuleMeasurements, widthMm: number, heightMm: number): LedDistributionResult {
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
  const rectangles: Rectangle[] = [];
  const lengthMm = geometry.body.lengthMm, bodyWidthMm = geometry.widthMm;
  // A conservative gap estimate: each side must be long enough on its own.
  // Do not add both pigtails or infer a valid electrical connection.
  const gapBudgetMm = Math.min(geometry.leftPigtail.lengthMm, geometry.rightPigtail.lengthMm);
  const clearance = Math.min(0.2, bodyWidthMm * 0.05);
  for (const division of divisions.paths) {
    const stat = stats.get(division.figureId);
    if (!stat) continue;
    const route = pathPolyline(division, scale);
    if (!route) { stat.unplaced++; continue; }
    const sourceRegion = divisions.regions?.find(region => region.id === division.regionId);
    const region: Region = sourceRegion ? { outer: sourceRegion.outer.map(p => toMm(p, scale)), inner: null,
      holes: sourceRegion.holes.map(hole => hole.map(p => toMm(p, scale))) } :
      { outer: polygon(division.outerContourId), inner: division.innerContourId ? polygon(division.innerContourId) : null };
    const maxBodies = Math.floor(route.length / lengthMm);
    if (!maxBodies) { stat.unplaced++; continue; }
    const desired = route.closed
      ? Math.ceil(route.length / (lengthMm + gapBudgetMm))
      : Math.ceil((route.length + gapBudgetMm) / (lengthMm + gapBudgetMm));
    const slots = Math.min(maxBodies, Math.max(1, desired));
    const pitch = route.closed ? route.length / slots : slots > 1 ? (route.length - lengthMm) / (slots - 1) : route.length;
    for (let slot = 0; slot < slots; slot++) {
      const base = route.closed ? (slot + 0.5) * pitch : slots === 1 ? route.length / 2 : lengthMm / 2 + slot * pitch;
      let accepted: Rectangle | null = null;
      for (const shift of [0, -0.12, 0.12, -0.24, 0.24, -0.36, 0.36]) {
        const position = base + shift * pitch;
        if (!route.closed && (position < lengthMm / 2 || position > route.length - lengthMm / 2)) continue;
        const candidate = makeRectangle(route, position, lengthMm, bodyWidthMm);
        if (!candidate || !insideRegion(candidate, region, clearance) || rectangles.some(other => overlaps(candidate, other))) continue;
        accepted = candidate;
        break;
      }
      if (!accepted) { stat.unplaced++; continue; }
      rectangles.push(accepted);
      stat.placed++;
      const forward = (fraction: number): Point => ({
        x: accepted!.center.x + accepted!.tangent.x * lengthMm * fraction,
        y: accepted!.center.y + accepted!.tangent.y * lengthMm * fraction,
      });
      const offset = (point: Point, amount: number): Point => ({ x: point.x + accepted!.normal.x * amount, y: point.y + accepted!.normal.y * amount });
      const tip = offset(forward(0.38), -bodyWidthMm * 0.2);
      const arrowSize = Math.min(bodyWidthMm * 0.19, lengthMm * 0.07);
      const arrowBase = { x: tip.x - accepted.tangent.x * arrowSize, y: tip.y - accepted.tangent.y * arrowSize };
      modules.push({
        id: `${division.id}-${slot}`, figureId: division.figureId, divisionId: division.id,
        number: modules.length + 1, figureNumber: stat.placed,
        center: toSvg(accepted.center, scale),
        corners: accepted.corners.map(point => toSvg(point, scale)) as [Point, Point, Point, Point],
        directionStart: toSvg(offset(forward(-0.12), -bodyWidthMm * 0.2), scale),
        directionEnd: toSvg(tip, scale),
        arrow: [tip, offset(arrowBase, arrowSize * 0.55), offset(arrowBase, -arrowSize * 0.55)].map(point => toSvg(point, scale)) as [Point, Point, Point],
        labelPoint: toSvg(offset(accepted.center, bodyWidthMm * 0.23), scale),
      });
    }
  }
  return { modules, byFigure, total: modules.length, unplaced: byFigure.reduce((sum, figure) => sum + figure.unplaced, 0) };
}
