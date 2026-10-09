import type { Contour, Figure, Point } from './types';
import type { GeometryRegion } from './regions';

const NS = 'http://www.w3.org/2000/svg';

export interface DivisionPath {
  regionId?: string;
  id: string;
  figureId: string;
  outerContourId: string;
  innerContourId: string;
  index: number;
  fraction: number;
  /** Numerically traced line between both source boundaries, in SVG units. */
  d: string;
}

export interface DivisionResult {
  regions?: GeometryRegion[];
  paths: DivisionPath[];
  pairs: number;
  warnings: string[];
}

interface SampledContour {
  contour: Contour;
  points: Point[];
  area: number;
}

function sample(contour: Contour, count: number): Point[] {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', contour.d);
  return Array.from({ length: count }, (_, index) => {
    const point = path.getPointAtLength(contour.length * index / count);
    return { x: point.x, y: point.y };
  });
}

function signedArea(points: Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function findTopology(figures: Figure[]): { pairs: Array<[Contour, Contour]>; singles: Contour[]; openCount: number; ambiguousCount: number } {
  const closed = figures.flatMap(figure => figure.contours).filter(contour => contour.closed || Math.hypot(contour.start.x - contour.end.x, contour.start.y - contour.end.y) < 1e-6);
  const openCount = figures.reduce((count, figure) => count + figure.contours.length, 0) - closed.length;
  const sampled: SampledContour[] = closed.map(contour => {
    const points = sample(contour, 128);
    return { contour, points, area: Math.abs(signedArea(points)) };
  });
  const children = new Map<string, SampledContour[]>();
  const hasParent = new Set<string>();
  for (const inner of sampled) {
    const parents = sampled.filter(outer => outer !== inner && outer.area > inner.area * 1.0001 &&
      inner.points.every((point, index) => index % 8 !== 0 || insidePolygon(point, outer.points)));
    parents.sort((a, b) => a.area - b.area);
    const parent = parents[0];
    if (parent) {
      children.set(parent.contour.id, [...(children.get(parent.contour.id) ?? []), inner]);
      hasParent.add(inner.contour.id);
    }
  }
  const pairs = sampled.flatMap(outer => {
    const holes = children.get(outer.contour.id) ?? [];
    return holes.length === 1 ? [[outer.contour, holes[0].contour] as [Contour, Contour]] : [];
  });
  const singles = sampled.filter(item => !hasParent.has(item.contour.id) && !children.has(item.contour.id)).map(item => item.contour);
  const ambiguousCount = sampled.filter(item => (children.get(item.contour.id)?.length ?? 0) > 1).length;
  return { pairs, singles, openCount, ambiguousCount };
}

interface KdNode { index: number; axis: 0 | 1; left: KdNode | null; right: KdNode | null }

function kdTree(points: Point[], indices: number[], axis: 0 | 1 = 0): KdNode | null {
  if (!indices.length) return null;
  indices.sort((a, b) => axis === 0 ? points[a].x - points[b].x : points[a].y - points[b].y);
  const middle = Math.floor(indices.length / 2);
  return {
    index: indices[middle], axis,
    left: kdTree(points, indices.slice(0, middle), axis === 0 ? 1 : 0),
    right: kdTree(points, indices.slice(middle + 1), axis === 0 ? 1 : 0),
  };
}

function pointSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / lengthSquared)) : 0;
  const dx = point.x - a.x - t * vx, dy = point.y - a.y - t * vy;
  return dx * dx + dy * dy;
}

function distanceToBoundary(point: Point, points: Point[], tree: KdNode | null): number {
  let nearest = 0, best = Infinity;
  function visit(node: KdNode | null) {
    if (!node) return;
    const candidate = points[node.index];
    const dx = point.x - candidate.x, dy = point.y - candidate.y;
    const distance = dx * dx + dy * dy;
    if (distance < best) { best = distance; nearest = node.index; }
    const delta = node.axis === 0 ? dx : dy;
    visit(delta < 0 ? node.left : node.right);
    if (delta * delta < best) visit(delta < 0 ? node.right : node.left);
  }
  visit(tree);
  let segmentDistance = Infinity;
  for (let offset = -2; offset <= 1; offset++) {
    const index = (nearest + offset + points.length) % points.length;
    segmentDistance = Math.min(segmentDistance, pointSegmentDistanceSquared(point, points[index], points[(index + 1) % points.length]));
  }
  return Math.sqrt(segmentDistance);
}

function scanlineCuts(polygon: Point[], y: number): number[] {
  const cuts: number[] = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    if ((a.y > y) !== (b.y > y)) cuts.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
  }
  return cuts.sort((a, b) => a - b);
}

interface Field { values: Float32Array; columns: number; rows: number; x: number; y: number; step: number }

/** 0 at the outer edge, 1 at the inner edge; level sets provide equal cross-width fractions. */
function makeField(outer: Contour, inner: Contour): Field {
  const roughOuter = sample(outer, 256), roughInner = sample(inner, 256);
  const minX = Math.min(...roughOuter.map(p => p.x)), maxX = Math.max(...roughOuter.map(p => p.x));
  const minY = Math.min(...roughOuter.map(p => p.y)), maxY = Math.max(...roughOuter.map(p => p.y));
  const span = Math.max(maxX - minX, maxY - minY);
  const roughTree = kdTree(roughOuter, roughOuter.map((_, index) => index));
  const gap = Math.min(...roughInner.filter((_, index) => index % 8 === 0).map(point => distanceToBoundary(point, roughOuter, roughTree)));
  const step = Math.min(span / 320, Math.max(span / 500, gap / 7));
  const x = minX - step * 2, y = minY - step * 2;
  const columns = Math.ceil((maxX - minX) / step) + 5;
  const rows = Math.ceil((maxY - minY) / step) + 5;
  const outerPoints = sample(outer, Math.min(2500, Math.max(128, Math.ceil(outer.length / (step * 0.7)))));
  const innerPoints = sample(inner, Math.min(2500, Math.max(128, Math.ceil(inner.length / (step * 0.7)))));
  const outerTree = kdTree(outerPoints, outerPoints.map((_, index) => index));
  const innerTree = kdTree(innerPoints, innerPoints.map((_, index) => index));
  const values = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    const py = y + row * step;
    const outerCuts = scanlineCuts(outerPoints, py), innerCuts = scanlineCuts(innerPoints, py);
    let outerCrossings = 0, innerCrossings = 0;
    for (let column = 0; column < columns; column++) {
      const px = x + column * step;
      while (outerCrossings < outerCuts.length && outerCuts[outerCrossings] < px) outerCrossings++;
      while (innerCrossings < innerCuts.length && innerCuts[innerCrossings] < px) innerCrossings++;
      const point = { x: px, y: py };
      const outerDistance = distanceToBoundary(point, outerPoints, outerTree);
      const innerDistance = distanceToBoundary(point, innerPoints, innerTree);
      const total = Math.max(outerDistance + innerDistance, 1e-12);
      const insideOuter = outerCrossings % 2 === 1, insideInner = innerCrossings % 2 === 1;
      values[row * columns + column] = !insideOuter ? -outerDistance / total : insideInner ? 1 + innerDistance / total : outerDistance / total;
    }
  }
  return { values, columns, rows, x, y, step };
}

/** Inset levels split a single closed shape into equal radial bands toward its deepest point. */
function makeInsetField(contour: Contour): Field | null {
  const rough = sample(contour, 256);
  const minX = Math.min(...rough.map(point => point.x)), maxX = Math.max(...rough.map(point => point.x));
  const minY = Math.min(...rough.map(point => point.y)), maxY = Math.max(...rough.map(point => point.y));
  const span = Math.max(maxX - minX, maxY - minY);
  if (span <= 0) return null;
  const step = span / 360;
  const x = minX - step * 2, y = minY - step * 2;
  const columns = Math.ceil((maxX - minX) / step) + 5;
  const rows = Math.ceil((maxY - minY) / step) + 5;
  const points = sample(contour, Math.min(2500, Math.max(128, Math.ceil(contour.length / (step * 0.7)))));
  const tree = kdTree(points, points.map((_, index) => index));
  const values = new Float32Array(columns * rows);
  let deepest = 0;
  for (let row = 0; row < rows; row++) {
    const py = y + row * step;
    const cuts = scanlineCuts(points, py);
    let crossings = 0;
    for (let column = 0; column < columns; column++) {
      const px = x + column * step;
      while (crossings < cuts.length && cuts[crossings] < px) crossings++;
      const distance = distanceToBoundary({ x: px, y: py }, points, tree);
      const inside = crossings % 2 === 1;
      values[row * columns + column] = inside ? distance : -distance;
      if (inside) deepest = Math.max(deepest, distance);
    }
  }
  if (deepest <= step) return null;
  for (let index = 0; index < values.length; index++) values[index] /= deepest;
  return { values, columns, rows, x, y, step };
}

function traceLevel(field: Field, level: number): string[] {
  type Segment = [Point, Point];
  const segments: Segment[] = [];
  const { values, columns, rows, x, y, step } = field;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const index = row * columns + column;
      const v = [values[index], values[index + 1], values[index + columns + 1], values[index + columns]];
      const corners = [
        { x: x + column * step, y: y + row * step },
        { x: x + (column + 1) * step, y: y + row * step },
        { x: x + (column + 1) * step, y: y + (row + 1) * step },
        { x: x + column * step, y: y + (row + 1) * step },
      ];
      const crossings: Point[] = [];
      for (let edge = 0; edge < 4; edge++) {
        const next = (edge + 1) % 4;
        if ((v[edge] < level) === (v[next] < level)) continue;
        const fraction = (level - v[edge]) / (v[next] - v[edge]);
        crossings.push({
          x: corners[edge].x + fraction * (corners[next].x - corners[edge].x),
          y: corners[edge].y + fraction * (corners[next].y - corners[edge].y),
        });
      }
      for (let edge = 0; edge + 1 < crossings.length; edge += 2) segments.push([crossings[edge], crossings[edge + 1]]);
    }
  }
  const quantize = (point: Point) => `${Math.round(point.x / (step * 1e-4))},${Math.round(point.y / (step * 1e-4))}`;
  const links = new Map<string, number[]>();
  segments.forEach(([a, b], index) => {
    for (const point of [a, b]) links.set(quantize(point), [...(links.get(quantize(point)) ?? []), index]);
  });
  const used = new Uint8Array(segments.length);
  const paths: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    if (used[index]) continue;
    used[index] = 1;
    const line: Point[] = [...segments[index]];
    for (const atStart of [false, true]) {
      for (let guard = 0; guard < segments.length; guard++) {
        const end = atStart ? line[0] : line[line.length - 1];
        const nextIndex = (links.get(quantize(end)) ?? []).find(candidate => !used[candidate]);
        if (nextIndex === undefined) break;
        used[nextIndex] = 1;
        const [a, b] = segments[nextIndex];
        const next = quantize(a) === quantize(end) ? b : a;
        if (atStart) line.unshift(next);
        else line.push(next);
      }
    }
    if (line.length < 8 || Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y) > step * 1.5) continue;
    const coordinates = line.slice(0, -1).map(point => `${Number(point.x.toFixed(4))} ${Number(point.y.toFixed(4))}`);
    paths.push(`M ${coordinates.join(' L ')} Z`);
  }
  return paths;
}

/** Divides every closed shape, using its inner contour when one exists. */
export function generateDivisions(figures: Figure[], count: number): DivisionResult {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('Las divisiones deben ser un entero entre 1 y 32.');
  const warnings: string[] = [];
  const paths: DivisionPath[] = [];
  let pairs = 0;
  const topology = findTopology(figures);
  for (const [outer, inner] of topology.pairs) {
    const figure = figures.find(candidate => candidate.id === outer.figureId)!;
    pairs++;
    const field = makeField(outer, inner);
    for (let index = 1; index <= count; index++) {
      const fraction = index / (count + 1);
      const traced = traceLevel(field, fraction);
      if (!traced.length) warnings.push(`${figure.name}: no se pudo cerrar la división ${index}.`);
      traced.forEach((d, component) => paths.push({
        id: `${figure.id}-${outer.id}-${inner.id}-${index}-${component}`,
        figureId: figure.id, outerContourId: outer.id, innerContourId: inner.id,
        index, fraction, d,
      }));
    }
  }
  for (const contour of topology.singles) {
    const figure = figures.find(candidate => candidate.id === contour.figureId)!;
    const field = makeInsetField(contour);
    if (!field) {
      warnings.push(`${figure.name}: el contorno es demasiado estrecho para dividirlo.`);
      continue;
    }
    for (let index = 1; index <= count; index++) {
      const fraction = index / (count + 1);
      const traced = traceLevel(field, fraction);
      if (!traced.length) warnings.push(`${figure.name}: no se pudo cerrar la división ${index}.`);
      traced.forEach((d, component) => paths.push({
        id: `${figure.id}-${contour.id}-inset-${index}-${component}`,
        figureId: figure.id, outerContourId: contour.id, innerContourId: '',
        index, fraction, d,
      }));
    }
  }
  if (topology.openCount) warnings.push(`${topology.openCount} contorno(s) abierto(s) no tienen superficie interior para dividir.`);
  if (topology.ambiguousCount) warnings.push(`${topology.ambiguousCount} figura(s) tienen varios huecos; falta definir cómo dividirlas.`);
  if (!paths.length && !warnings.length) warnings.push('No hay contornos cerrados para dividir.');
  return { paths, pairs, warnings };
}
