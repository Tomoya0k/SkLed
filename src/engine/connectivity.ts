import type { DivisionPath, DivisionResult } from './divisions';
import type { LedDistributionResult, LedPlacement } from './distribution';
import { createModuleGeometry } from './module';
import type { ModuleMeasurements } from './module';
import type { Point, SvgModel } from './types';
import type { GeometryRegion } from './regions';

const NS = 'http://www.w3.org/2000/svg';
export type TerminalSide = 'left' | 'right';
export type ConnectionKind = 'pigtail' | 'bridge';

export interface ConnectionLink {
  id: string;
  kind: ConnectionKind;
  fromId: string;
  toId: string;
  fromSide: TerminalSide;
  toSide: TerminalSide;
  lengthMm: number;
  fromPigtailUsedMm: number;
  toPigtailUsedMm: number;
  bridgeLengthMm: number;
  route: Point[];
  bridgeSegment: [Point, Point] | null;
}

export interface FlowChain {
  id: string;
  moduleIds: string[];
  moduleNumbers: number[];
  figureIds: string[];
  entry: Point;
  firstModuleId: string;
  lastModuleId: string;
  exit: Point;
  linkIds: string[];
}

export interface FigureFlow {
  figureId: string;
  name: string;
  connected: number;
  discarded: number;
  runs: Array<{
    chainId: string;
    entry: Point;
    firstModuleId: string;
    sequence: number[];
    lastModuleId: string;
    exit: Point;
  }>;
}

export interface ConnectivityResult {
  links: ConnectionLink[];
  chains: FlowChain[];
  figureFlows: FigureFlow[];
  connectedIds: string[];
  discardedIds: string[];
  discardedReasons: Record<string, string>;
  conflicts: string[];
  bridgeTotalMm: number;
}

export interface ConnectivityModes {
  pigtails: ConnectivityResult;
  bridges: ConnectivityResult;
}

interface Scale { x: number; y: number }
interface Terminal { module: LedPlacement; side: TerminalSide; svg: Point; mm: Point; centerMm: Point; availableMm: number }
interface Region { outer: Point[]; inner: Point[] | null; holes?: Point[][] }
interface Guide { path: DivisionPath; points: Point[]; distances: number[]; length: number; closed: boolean }
interface Candidate {
  a: Terminal;
  b: Terminal;
  routeMm: Point[];
  lengthMm: number;
  bridgeLengthMm: number;
}

const toMm = (point: Point, scale: Scale): Point => ({ x: point.x * scale.x, y: point.y * scale.y });
const toSvg = (point: Point, scale: Scale): Point => ({ x: point.x / scale.x, y: point.y / scale.y });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const terminalKey = (terminal: Terminal) => `${terminal.module.id}:${terminal.side}`;
const opposite = (side: TerminalSide): TerminalSide => side === 'left' ? 'right' : 'left';

function sampleContour(d: string, scale: Scale): Point[] {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  const length = path.getTotalLength();
  const count = Math.min(3000, Math.max(96, Math.ceil(length * Math.max(scale.x, scale.y) / 0.7)));
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

function insideRegions(point: Point, regions: Region[]): boolean {
  return regions.some(region => insidePolygon(point, region.outer) && !(region.holes ?? (region.inner ? [region.inner] : [])).some(hole => insidePolygon(point, hole)));
}

function segmentInside(a: Point, b: Point, regions: Region[]): boolean {
  if (!regions.length) return false;
  const steps = Math.max(2, Math.ceil(distance(a, b) / 0.4));
  for (let index = 0; index <= steps; index++) {
    const fraction = index / steps;
    if (!insideRegions({ x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }, regions)) return false;
  }
  return true;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 &&
    Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) &&
    Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
}

function crossesBody(a: Point, b: Point, corners: Point[]): boolean {
  for (let index = 0; index < 4; index++) {
    if (segmentsIntersect(a, b, corners[index], corners[(index + 1) % 4])) return true;
  }
  return false;
}

function routeAvoidsBodies(route: Point[], bodyById: Map<string, Point[]>, fromId: string, toId: string, avoidModuleCollisions = true): boolean {
  if (!avoidModuleCollisions) return true;
  for (let index = 1; index < route.length; index++) {
    const a = route[index - 1], b = route[index];
    for (const [id, corners] of bodyById) {
      if (id === fromId || id === toId) continue;
      const middle = midpoint(a, b);
      if (insidePolygon(a, corners) || insidePolygon(middle, corners) || insidePolygon(b, corners) || crossesBody(a, b, corners)) return false;
    }
  }
  return true;
}

function exitsBody(terminal: Terminal, next: Point): boolean {
  const center = terminal.centerMm;
  const outward = { x: terminal.mm.x - center.x, y: terminal.mm.y - center.y };
  const movement = { x: next.x - terminal.mm.x, y: next.y - terminal.mm.y };
  return outward.x * movement.x + outward.y * movement.y >= -1e-6;
}

function routeLength(route: Point[]): number {
  let length = 0;
  for (let index = 1; index < route.length; index++) length += distance(route[index - 1], route[index]);
  return length;
}

function makeGuide(path: DivisionPath, scale: Scale): Guide | null {
  const numbers = path.d.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g)?.map(Number) ?? [];
  if (numbers.length < 4 || numbers.length % 2) return null;
  const points: Point[] = [];
  for (let index = 0; index < numbers.length; index += 2) points.push(toMm({ x: numbers[index], y: numbers[index + 1] }, scale));
  const closed = /z\s*$/i.test(path.d);
  if (closed) points.push(points[0]);
  const distances = [0];
  for (let index = 1; index < points.length; index++) distances.push(distances[index - 1] + distance(points[index - 1], points[index]));
  const length = distances.at(-1)!;
  return length > 0 ? { path, points, distances, length, closed } : null;
}

function project(point: Point, guide: Guide): { point: Point; position: number } {
  let best = Infinity, position = 0, projected = guide.points[0];
  for (let index = 1; index < guide.points.length; index++) {
    const a = guide.points[index - 1], b = guide.points[index];
    const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    const fraction = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
    const candidate = { x: a.x + dx * fraction, y: a.y + dy * fraction };
    const gap = distance(point, candidate);
    if (gap < best) { best = gap; projected = candidate; position = guide.distances[index - 1] + distance(a, b) * fraction; }
  }
  return { point: projected, position };
}

function forwardArc(guide: Guide, a: { point: Point; position: number }, b: { point: Point; position: number }): Point[] {
  let end = b.position;
  if (guide.closed && end < a.position) end += guide.length;
  if (!guide.closed && end < a.position) return [];
  const points = [a.point];
  for (let pass = 0; pass <= (end > guide.length ? 1 : 0); pass++) {
    for (let index = 1; index < guide.points.length; index++) {
      const at = guide.distances[index] + pass * guide.length;
      if (at > a.position + 1e-6 && at < end - 1e-6) points.push(guide.points[index]);
    }
  }
  points.push(b.point);
  return points;
}

function guidedRoutes(a: Terminal, b: Terminal, guide: Guide): Point[][] {
  const aProjection = project(a.mm, guide), bProjection = project(b.mm, guide);
  const forward = forwardArc(guide, aProjection, bProjection);
  const backward = forwardArc(guide, bProjection, aProjection).reverse();
  const exitPoint = (terminal: Terminal): Point => {
    const dx = terminal.mm.x - terminal.centerMm.x, dy = terminal.mm.y - terminal.centerMm.y;
    const magnitude = Math.hypot(dx, dy);
    const extension = Math.min(1, magnitude / 4);
    return { x: terminal.mm.x + dx / magnitude * extension, y: terminal.mm.y + dy / magnitude * extension };
  };
  return [forward, backward].filter(route => route.length > 1).map(route => [a.mm, exitPoint(a), ...route, exitPoint(b), b.mm]);
}

function terminalPairRoute(a: Terminal, b: Terminal, regions: Region[], guide: Guide | undefined, bodies: Map<string, Point[]>, avoidModuleCollisions = true): Point[] | null {
  const valid = (route: Point[]) => {
    if (!exitsBody(a, route[1]) || !exitsBody(b, route[route.length - 2])) return false;
    if (!route.every((point, index) => index === 0 || segmentInside(route[index - 1], point, regions))) return false;
    if (!routeAvoidsBodies(route, bodies, a.module.id, b.module.id, avoidModuleCollisions)) return false;
    return true;
  };
  const direct = [a.mm, b.mm];
  if (valid(direct)) return direct;
  if (!guide) return null;
  const alternatives = guidedRoutes(a, b, guide).filter(valid).sort((first, second) => routeLength(first) - routeLength(second));
  return alternatives[0] ?? null;
}

function terminalsOf(module: LedPlacement, measurements: ModuleMeasurements, scale: Scale): [Terminal, Terminal] {
  const leftSvg = midpoint(module.corners[0], module.corners[3]);
  const rightSvg = midpoint(module.corners[1], module.corners[2]);
  const centerMm = toMm(module.center, scale);
  return [
    { module, side: 'left', svg: leftSvg, mm: toMm(leftSvg, scale), centerMm, availableMm: measurements.leftPigtailMm },
    { module, side: 'right', svg: rightSvg, mm: toMm(rightSvg, scale), centerMm, availableMm: measurements.rightPigtailMm },
  ];
}

/** The same terminal, cable-route and body checks used by Conexiones, exposed for ordered route planning. */
export function createPigtailChecker(regions: GeometryRegion[], paths: DivisionPath[], modules: LedPlacement[],
  measurements: ModuleMeasurements, scale: Scale): (a: LedPlacement, b: LedPlacement, ignoredBodyId?: string) => ConnectionLink[] {
  createModuleGeometry(measurements);
  const byFigure = new Map<string, Region[]>();
  for (const region of regions) {
    const list = byFigure.get(region.figureId) ?? [];
    list.push({ outer: region.outer.map(point => toMm(point, scale)), inner: null,
      holes: region.holes.map(hole => hole.map(point => toMm(point, scale))) });
    byFigure.set(region.figureId, list);
  }
  const guides = new Map(paths.map(path => [path.id, makeGuide(path, scale)]));
  const bodies = new Map(modules.map(module => [module.id, module.corners.map(point => toMm(point, scale))]));
  const terminals = new Map(modules.flatMap(module => terminalsOf(module, measurements, scale).map(terminal => [terminalKey(terminal), terminal] as const)));
  return (first, second, ignoredBodyId) => {
    const options: ConnectionLink[] = [];
    const visibleBodies = ignoredBodyId ? new Map([...bodies].filter(([id]) => id !== ignoredBodyId)) : bodies;
    for (const firstSide of ['left', 'right'] as const) for (const secondSide of ['left', 'right'] as const) {
      const a = terminals.get(`${first.id}:${firstSide}`), b = terminals.get(`${second.id}:${secondSide}`);
      if (!a || !b || distance(a.mm, b.mm) > a.availableMm + b.availableMm + 1e-6) continue;
      const guide = first.divisionId === second.divisionId ? guides.get(first.divisionId) ?? undefined : undefined;
      const route = terminalPairRoute(a, b, byFigure.get(first.figureId) ?? [], guide, visibleBodies);
      if (!route) continue;
      const lengthMm = routeLength(route);
      if (lengthMm > a.availableMm + b.availableMm + 1e-6) continue;
      options.push(asLink({ a, b, routeMm: route, lengthMm, bridgeLengthMm: 0 }, options.length, scale));
    }
    return options.sort((a, b) => a.lengthMm - b.lengthMm);
  };
}

/** Ordered connections for a snake, strictly within the available pigtails.
 * Detours count toward the limit; supplementary cable is never accepted. */
export function createSerpentCableRouter(regions: GeometryRegion[], paths: DivisionPath[], modules: LedPlacement[],
  measurements: ModuleMeasurements, scale: Scale, avoidModuleCollisions = true) {
  createModuleGeometry(measurements);
  const surfaces: Region[] = regions.map(region => ({ outer: region.outer.map(p => toMm(p, scale)), inner: null, holes: region.holes.map(hole => hole.map(p => toMm(p, scale))) }));
  const guides = new Map(paths.map(path => [path.id, makeGuide(path, scale)]));
  const bodies = new Map(modules.map(module => [module.id, module.corners.map(p => toMm(p, scale))]));
  const terminals = new Map(modules.flatMap(module => terminalsOf(module, measurements, scale).map(t => [terminalKey(t), t] as const)));
  const cache = new Map<string, ConnectionLink | null>();
  const networkAttachments = new Map<string, Array<{ id: number; cost: number }>>();
  let network: { points: Point[]; origins: string[]; adjacent: Map<number, number[]>; buckets: Map<string, number[]>; radius: number; neighbors: Map<number, number[]> } | null = null;
  const internalClear = (a: Point, b: Point) => segmentInside(a, b, surfaces) && routeAvoidsBodies([a, b], bodies, '', '', avoidModuleCollisions);
  const prepareNetwork = () => {
    if (network) return network;
    const points: Point[] = [], origins: string[] = [], keys = new Map<string, number>(), adjacent = new Map<number, number[]>();
    const radius = Math.max(10, measurements.widthMm * 2, measurements.lengthMm / 2);
    const add = (p: Point, origin: string) => {
      if (!insideRegions(p, surfaces) || (avoidModuleCollisions && [...bodies.values()].some(body => insidePolygon(p, body)))) return -1;
      const key = `${p.x.toFixed(5)},${p.y.toFixed(5)}`;
      const existing = keys.get(key); if (existing !== undefined) return existing;
      const id = points.length; points.push(p); origins.push(origin); keys.set(key, id); return id;
    };
    const join = (a: number, b: number) => { if (a >= 0 && b >= 0 && a !== b) { adjacent.set(a, [...(adjacent.get(a) ?? []), b]); adjacent.set(b, [...(adjacent.get(b) ?? []), a]); } };
    for (const guide of guides.values()) if (guide) {
      let previous = -1;
      for (const point of guide.points) { const id = add(point, guide.path.id); join(previous, id); previous = id; }
    }
    // Small detours around the physical bodies reconnect a center guide which
    // is occupied by an LED; the route still stays inside the figure.
    for (const [id, corners] of bodies) {
      const center = midpoint(corners[0], corners[2]);
      const expanded = corners.map(p => {
        const dx = p.x - center.x, dy = p.y - center.y;
        return { x: p.x + dx / Math.hypot(dx, dy) * 1.5, y: p.y + dy / Math.hypot(dx, dy) * 1.5 };
      });
      const perimeter = expanded.flatMap((p, i) => [p, midpoint(p, expanded[(i + 1) % 4])]).map(p => add(p, `body-${id}`));
      for (let i = 0; i < perimeter.length; i++) join(perimeter[i], perimeter[(i + 1) % perimeter.length]);
    }
    const buckets = new Map<string, number[]>();
    points.forEach((p, id) => { const key = `${Math.floor(p.x / radius)},${Math.floor(p.y / radius)}`; buckets.set(key, [...(buckets.get(key) ?? []), id]); });
    network = { points, origins, adjacent, buckets, radius, neighbors: new Map() }; return network;
  };
  const networkRoute = (a: Terminal, b: Terminal): Point[] | null => {
    const graph = prepareNetwork(), { points, origins, radius, adjacent, buckets, neighbors } = graph;
    const attach = (terminal: Terminal) => {
      const key = terminalKey(terminal), known = networkAttachments.get(key); if (known) return known;
      const result: Array<{ id: number; cost: number }> = [];
      const candidates = points.map((p, id) => ({ id, cost: distance(p, terminal.mm) })).filter(item => item.cost <= measurements.lengthMm + measurements.widthMm * 2).sort((x, y) => x.cost - y.cost);
      for (const item of candidates) {
        if (exitsBody(terminal, points[item.id]) && segmentInside(terminal.mm, points[item.id], surfaces) && routeAvoidsBodies([terminal.mm, points[item.id]], bodies, terminal.module.id, '', avoidModuleCollisions)) result.push(item);
        if (result.length === 8) break;
      }
      networkAttachments.set(key, result); return result;
    };
    const starts = attach(a), goals = new Map(attach(b).map(item => [item.id, item.cost]));
    if (!starts.length || !goals.size) return null;
    const connections = (id: number) => {
      const known = neighbors.get(id); if (known) return known;
      const p = points[id], x = Math.floor(p.x / radius), y = Math.floor(p.y / radius), candidates = new Set(adjacent.get(id) ?? []);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const next of buckets.get(`${x + dx},${y + dy}`) ?? []) if (next !== id && distance(p, points[next]) <= radius) candidates.add(next);
      const byOrigin = new Map<string, number>(), result: number[] = [];
      for (const next of [...candidates].sort((x, y) => distance(p, points[x]) - distance(p, points[y]))) {
        const origin = origins[next], count = byOrigin.get(origin) ?? 0;
        if (!(adjacent.get(id) ?? []).includes(next) && count >= (origin.startsWith('body-') ? 4 : 2)) continue;
        if (!internalClear(p, points[next])) continue;
        result.push(next); byOrigin.set(origin, count + 1);
        if (result.length >= 24) break;
      }
      neighbors.set(id, result); return result;
    };
    const costs = new Float64Array(points.length).fill(Infinity), priorities = new Float64Array(points.length).fill(Infinity), previous = new Int32Array(points.length).fill(-1);
    const open = new Set<number>();
    for (const start of starts) { costs[start.id] = start.cost; priorities[start.id] = start.cost + distance(points[start.id], b.mm); open.add(start.id); }
    let end = -1, best = Infinity;
    while (open.size) {
      let current = -1, score = Infinity;
      for (const id of open) if (priorities[id] < score) { score = priorities[id]; current = id; }
      if (current < 0 || score >= best) break;
      open.delete(current);
      const finish = goals.get(current);
      if (finish !== undefined && costs[current] + finish < best) { best = costs[current] + finish; end = current; }
      for (const next of connections(current)) {
        const cost = costs[current] + distance(points[current], points[next]);
        if (cost >= costs[next]) continue;
        costs[next] = cost; priorities[next] = cost + distance(points[next], b.mm); previous[next] = current; open.add(next);
      }
    }
    if (end < 0) return null;
    const route = [b.mm];
    for (let id = end; id >= 0; id = previous[id]) route.push(points[id]);
    route.push(a.mm); return route.reverse();
  };
  let grid: { mask: Uint8Array; columns: number; rows: number; cell: number; minX: number; minY: number } | null = null;
  const prepareGrid = () => {
    if (grid) return grid;
    const points = surfaces.flatMap(region => region.outer);
    const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
    const cell = Math.max(0.75, Math.min(2, measurements.widthMm / 8), Math.sqrt((maxX - minX) * (maxY - minY) / 300000));
    const columns = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxY - minY) / cell) + 1;
    const mask = new Uint8Array(columns * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) mask[y * columns + x] = Number(insideRegions({ x: minX + x * cell, y: minY + y * cell }, surfaces));
    // Only visit each body's bounding cells, instead of all bodies per pixel.
    if (avoidModuleCollisions) for (const corners of bodies.values()) {
      const center = midpoint(corners[0], corners[2]);
      const length = distance(corners[0], corners[1]), width = distance(corners[0], corners[3]);
      const tx = (corners[1].x - corners[0].x) / length, ty = (corners[1].y - corners[0].y) / length;
      const nx = (corners[3].x - corners[0].x) / width, ny = (corners[3].y - corners[0].y) / width;
      const x0 = Math.max(0, Math.floor((Math.min(...corners.map(p => p.x)) - minX - 0.4) / cell));
      const x1 = Math.min(columns - 1, Math.ceil((Math.max(...corners.map(p => p.x)) - minX + 0.4) / cell));
      const y0 = Math.max(0, Math.floor((Math.min(...corners.map(p => p.y)) - minY - 0.4) / cell));
      const y1 = Math.min(rows - 1, Math.ceil((Math.max(...corners.map(p => p.y)) - minY + 0.4) / cell));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = minX + x * cell - center.x, dy = minY + y * cell - center.y;
        if (Math.abs(dx * tx + dy * ty) <= length / 2 + 0.3 && Math.abs(dx * nx + dy * ny) <= width / 2 + 0.3) mask[y * columns + x] = 0;
      }
    }
    grid = { mask, columns, rows, cell, minX, minY }; return grid;
  };
  const rasterRoute = (a: Terminal, b: Terminal): Point[] | null => {
    const { mask, columns, rows, cell, minX, minY } = prepareGrid();
    const point = (id: number) => ({ x: minX + (id % columns) * cell, y: minY + Math.floor(id / columns) * cell });
    const attachments = (terminal: Terminal) => {
      const cx = Math.round((terminal.mm.x - minX) / cell), cy = Math.round((terminal.mm.y - minY) / cell);
      const candidates: Array<{ id: number; cost: number }> = [];
      for (let y = Math.max(0, cy - 4); y <= Math.min(rows - 1, cy + 4); y++) for (let x = Math.max(0, cx - 4); x <= Math.min(columns - 1, cx + 4); x++) {
        const id = y * columns + x, p = point(id);
        if (mask[id] && exitsBody(terminal, p) && segmentInside(terminal.mm, p, surfaces) && routeAvoidsBodies([terminal.mm, p], bodies, terminal.module.id, '', avoidModuleCollisions)) candidates.push({ id, cost: distance(terminal.mm, p) });
      }
      return candidates.sort((first, second) => first.cost - second.cost).slice(0, 12);
    };
    const starts = attachments(a), goals = new Map(attachments(b).map(item => [item.id, item.cost]));
    if (!starts.length || !goals.size) return null;
    const costs = new Float64Array(mask.length).fill(Infinity), previous = new Int32Array(mask.length).fill(-1);
    const heap: Array<{ id: number; priority: number }> = [];
    const push = (item: { id: number; priority: number }) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const parent = (i - 1) >> 1; if (heap[parent].priority <= item.priority) break; heap[i] = heap[parent]; i = parent; } heap[i] = item; };
    const pop = () => { const first = heap[0], last = heap.pop()!; if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1].priority < heap[child].priority) child++; if (heap[child].priority >= last.priority) break; heap[i] = heap[child]; i = child; } heap[i] = last; } return first; };
    for (const start of starts) { costs[start.id] = start.cost; push({ id: start.id, priority: start.cost + distance(point(start.id), b.mm) }); }
    let end = -1, best = Infinity;
    while (heap.length) {
      const current = pop();
      if (current.priority >= best) break;
      const finish = goals.get(current.id);
      if (finish !== undefined && costs[current.id] + finish < best) { best = costs[current.id] + finish; end = current.id; }
      const x = current.id % columns, y = Math.floor(current.id / columns);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy, id = ny * columns + nx;
        if (nx < 0 || nx >= columns || ny < 0 || ny >= rows || !mask[id] || (dx && dy && (!mask[y * columns + nx] || !mask[ny * columns + x]))) continue;
        const nextCost = costs[current.id] + Math.hypot(dx, dy) * cell;
        if (nextCost >= costs[id]) continue;
        costs[id] = nextCost; previous[id] = current.id;
        push({ id, priority: nextCost + distance(point(id), b.mm) });
      }
    }
    if (end < 0) return null;
    const route: Point[] = [b.mm];
    for (let id = end; id >= 0; id = previous[id]) route.push(point(id));
    route.push(a.mm); route.reverse();
    const safeSegment = (i: number, j: number) => (i !== 0 || exitsBody(a, route[j])) && (j !== route.length - 1 || exitsBody(b, route[i])) &&
      segmentInside(route[i], route[j], surfaces) && routeAvoidsBodies([route[i], route[j]], bodies, i === 0 ? a.module.id : '', j === route.length - 1 ? b.module.id : '', avoidModuleCollisions);
    const simplified = [route[0]];
    for (let i = 0; i < route.length - 1;) {
      let next = i + 1;
      for (let j = route.length - 1; j > i; j--) if (safeSegment(i, j)) { next = j; break; }
      if (!safeSegment(i, next)) return null;
      simplified.push(route[next]); i = next;
    }
    return simplified;
  };
  return (first: LedPlacement, fromSide: TerminalSide, second: LedPlacement, toSide: TerminalSide): ConnectionLink | null => {
    if (!surfaces.length) return null;
    const key = `${first.id}:${fromSide}>${second.id}:${toSide}`;
    if (cache.has(key)) return cache.get(key)!;
    const a = terminals.get(`${first.id}:${fromSide}`)!, b = terminals.get(`${second.id}:${toSide}`)!;
    const limit = Math.min(a.availableMm + b.availableMm, measurements.leftPigtailMm + measurements.rightPigtailMm);
    if (distance(a.mm, b.mm) > limit + 1e-6) { cache.set(key, null); return null; }
    const guide = first.divisionId === second.divisionId ? guides.get(first.divisionId) ?? undefined : undefined;
    const withinReach = (route: Point[] | null) => route && routeLength(route) <= limit + 1e-6 ? route : null;
    const route = withinReach(terminalPairRoute(a, b, surfaces, guide, bodies, avoidModuleCollisions)) ?? withinReach(networkRoute(a, b)) ?? withinReach(rasterRoute(a, b));
    const lengthMm = route ? routeLength(route) : 0;
    const result = route ? asLink({ a, b, routeMm: route, lengthMm, bridgeLengthMm: 0 }, cache.size, scale) : null;
    cache.set(key, result); return result;
  };
}

class Forest {
  private parent = new Map<string, string>();
  readonly used = new Set<string>();
  readonly edges: Candidate[] = [];
  constructor(ids: string[], from?: Forest) {
    for (const id of ids) this.parent.set(id, from ? from.root(id) : id);
    if (from) { for (const key of from.used) this.used.add(key); this.edges.push(...from.edges); }
  }
  root(id: string): string {
    const parent = this.parent.get(id)!;
    if (parent === id) return id;
    const root = this.root(parent);
    this.parent.set(id, root);
    return root;
  }
  canAdd(edge: Candidate): boolean {
    return !this.used.has(terminalKey(edge.a)) && !this.used.has(terminalKey(edge.b)) && this.root(edge.a.module.id) !== this.root(edge.b.module.id);
  }
  add(edge: Candidate): void {
    if (!this.canAdd(edge)) return;
    this.used.add(terminalKey(edge.a));
    this.used.add(terminalKey(edge.b));
    this.parent.set(this.root(edge.b.module.id), this.root(edge.a.module.id));
    this.edges.push(edge);
  }
}

function asLink(candidate: Candidate, index: number, scale: Scale): ConnectionLink {
  const kind: ConnectionKind = candidate.bridgeLengthMm > 1e-6 ? 'bridge' : 'pigtail';
  const fromUsed = Math.min(candidate.a.availableMm, candidate.lengthMm);
  const toUsed = kind === 'pigtail' ? candidate.lengthMm - fromUsed : Math.min(candidate.b.availableMm, candidate.lengthMm - fromUsed);
  const atDistance = (target: number): Point => {
    for (let i = 1; i < candidate.routeMm.length; i++) {
      const a = candidate.routeMm[i - 1], b = candidate.routeMm[i], length = distance(a, b);
      if (target <= length) { const t = length ? target / length : 0; return toSvg({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, scale); }
      target -= length;
    }
    return toSvg(candidate.routeMm.at(-1)!, scale);
  };
  const bridgeSegment: [Point, Point] | null = kind === 'bridge' ? [atDistance(candidate.a.availableMm), atDistance(candidate.lengthMm - candidate.b.availableMm)] : null;
  return {
    id: `link-${index + 1}`, kind,
    fromId: candidate.a.module.id, toId: candidate.b.module.id,
    fromSide: candidate.a.side, toSide: candidate.b.side,
    lengthMm: candidate.lengthMm, fromPigtailUsedMm: fromUsed, toPigtailUsedMm: toUsed,
    bridgeLengthMm: candidate.bridgeLengthMm,
    route: candidate.routeMm.map(point => toSvg(point, scale)), bridgeSegment,
  };
}

function buildResult(model: SvgModel, modules: LedPlacement[], forest: Forest, terminals: Map<string, Terminal>, scale: Scale, potentialIds: Set<string>): ConnectivityResult {
  const links = forest.edges.map((edge, index) => asLink(edge, index, scale));
  const byId = new Map(modules.map(module => [module.id, module]));
  const adjacency = new Map(modules.map(module => [module.id, [] as ConnectionLink[]]));
  for (const link of links) { adjacency.get(link.fromId)!.push(link); adjacency.get(link.toId)!.push(link); }
  const connectedIds = modules.filter(module => adjacency.get(module.id)!.length > 0).map(module => module.id);
  const connected = new Set(connectedIds);
  const discardedIds = modules.filter(module => !connected.has(module.id)).map(module => module.id);
  const discardedReasons = Object.fromEntries(modules.filter(module => !connected.has(module.id)).map(module => [module.id,
    potentialIds.has(module.id) ? 'No entró en una cadena sin reutilizar terminales.' : 'No tiene enlace alcanzable con las longitudes y rutas disponibles.']));
  const chains: FlowChain[] = [];
  const visited = new Set<string>();
  for (const start of modules.filter(module => adjacency.get(module.id)!.length === 1)) {
    if (visited.has(start.id)) continue;
    const component: LedPlacement[] = [];
    const componentLinks: ConnectionLink[] = [];
    let previousId = '', currentId: string | null = start.id;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      component.push(byId.get(currentId)!);
      const next: ConnectionLink | undefined = adjacency.get(currentId)!.find(link => (link.fromId === currentId ? link.toId : link.fromId) !== previousId);
      if (!next) break;
      componentLinks.push(next);
      previousId = currentId;
      currentId = next.fromId === currentId ? next.toId : next.fromId;
    }
    if (component.length < 2) continue;
    const first = component[0], last = component.at(-1)!;
    const firstLink = componentLinks[0], lastLink = componentLinks.at(-1)!;
    const firstUsedSide = firstLink.fromId === first.id ? firstLink.fromSide : firstLink.toSide;
    const lastUsedSide = lastLink.fromId === last.id ? lastLink.fromSide : lastLink.toSide;
    const entry = terminals.get(`${first.id}:${opposite(firstUsedSide)}`)!.svg;
    const exit = terminals.get(`${last.id}:${opposite(lastUsedSide)}`)!.svg;
    chains.push({
      id: `chain-${chains.length + 1}`, moduleIds: component.map(module => module.id), moduleNumbers: component.map(module => module.number),
      figureIds: [...new Set(component.map(module => module.figureId))], entry, firstModuleId: first.id,
      lastModuleId: last.id, exit, linkIds: componentLinks.map(link => link.id),
    });
  }
  const figureFlows: FigureFlow[] = model.figures.map(figure => {
    const runs: FigureFlow['runs'] = [];
    for (const chain of chains) {
      for (let start = 0; start < chain.moduleIds.length;) {
        if (byId.get(chain.moduleIds[start])!.figureId !== figure.id) { start++; continue; }
        let end = start;
        while (end + 1 < chain.moduleIds.length && byId.get(chain.moduleIds[end + 1])!.figureId === figure.id) end++;
        const firstId = chain.moduleIds[start], lastId = chain.moduleIds[end];
        const entryLink = start > 0 ? links.find(link => link.id === chain.linkIds[start - 1])! : null;
        const exitLink = end < chain.moduleIds.length - 1 ? links.find(link => link.id === chain.linkIds[end])! : null;
        const entry = entryLink ? terminals.get(`${firstId}:${entryLink.fromId === firstId ? entryLink.fromSide : entryLink.toSide}`)!.svg : chain.entry;
        const exit = exitLink ? terminals.get(`${lastId}:${exitLink.fromId === lastId ? exitLink.fromSide : exitLink.toSide}`)!.svg : chain.exit;
        runs.push({ chainId: chain.id, entry, firstModuleId: firstId, sequence: chain.moduleNumbers.slice(start, end + 1), lastModuleId: lastId, exit });
        start = end + 1;
      }
    }
    return {
      figureId: figure.id, name: figure.name,
      connected: connectedIds.filter(id => byId.get(id)!.figureId === figure.id).length,
      discarded: discardedIds.filter(id => byId.get(id)!.figureId === figure.id).length,
      runs,
    };
  });
  const conflicts: string[] = [];
  if (discardedIds.length) conflicts.push(`${discardedIds.length} módulo(s) sin enlace físico en esta solución.`);
  for (const id of discardedIds.slice(0, 8)) conflicts.push(`Módulo ${byId.get(id)!.number}: ${discardedReasons[id]}`);
  if (discardedIds.length > 8) conflicts.push(`${discardedIds.length - 8} módulo(s) descartado(s) más.`);
  for (const flow of figureFlows) {
    if (flow.runs.length > 1) conflicts.push(`${flow.name}: ${flow.runs.length} tramos de flujo separados.`);
  }
  return {
    links, chains, figureFlows, connectedIds, discardedIds, discardedReasons, conflicts,
    bridgeTotalMm: links.reduce((sum, link) => sum + link.bridgeLengthMm, 0),
  };
}

/** Builds geometric paths only. Manufacturer polarity and electrical limits are separate checks. */
export function connectLeds(model: SvgModel, divisions: DivisionResult, distribution: LedDistributionResult, measurements: ModuleMeasurements,
  widthMm: number, heightMm: number, maxBridgeMm?: number): ConnectivityModes {
  createModuleGeometry(measurements);
  if (![widthMm, heightMm].every(value => Number.isFinite(value) && value > 0)) throw new Error('Indica las medidas físicas del SVG.');
  if (maxBridgeMm !== undefined && (!Number.isFinite(maxBridgeMm) || maxBridgeMm < 0)) throw new Error('El límite de puente debe ser no negativo.');
  const scale = { x: widthMm / model.viewBox.width, y: heightMm / model.viewBox.height };
  const modules = distribution.modules;
  const terminals = new Map(modules.flatMap(module => terminalsOf(module, measurements, scale).map(terminal => [terminalKey(terminal), terminal] as const)));
  const bodies = new Map(modules.map(module => [module.id, module.corners.map(point => toMm(point, scale))]));
  const contourById = new Map(model.figures.flatMap(figure => figure.contours).map(contour => [contour.id, contour]));
  const polygonCache = new Map<string, Point[]>();
  const polygon = (id: string) => {
    let points = polygonCache.get(id);
    if (!points) { points = sampleContour(contourById.get(id)!.d, scale); polygonCache.set(id, points); }
    return points;
  };
  const regions = new Map<string, Region[]>();
  for (const region of divisions.regions ?? []) {
    const list = regions.get(region.figureId) ?? [];
    list.push({ outer: region.outer.map(p => toMm(p, scale)), inner: null, holes: region.holes.map(hole => hole.map(p => toMm(p, scale))) });
    regions.set(region.figureId, list);
  }
  for (const path of divisions.paths) {
    if (divisions.regions?.some(region => region.id === path.regionId)) continue;
    const list = regions.get(path.figureId) ?? [];
    if (!list.some(region => region.outer === polygon(path.outerContourId) && region.inner === (path.innerContourId ? polygon(path.innerContourId) : null))) {
      list.push({ outer: polygon(path.outerContourId), inner: path.innerContourId ? polygon(path.innerContourId) : null });
    }
    regions.set(path.figureId, list);
  }
  const guides = new Map(divisions.paths.map(path => [path.id, makeGuide(path, scale)]));
  const insideCandidates: Candidate[] = [], betweenCandidates: Candidate[] = [];
  for (let first = 0; first < modules.length; first++) {
    for (let second = first + 1; second < modules.length; second++) {
      const aModule = modules[first], bModule = modules[second];
      for (const aSide of ['left', 'right'] as const) for (const bSide of ['left', 'right'] as const) {
        const a = terminals.get(`${aModule.id}:${aSide}`)!, b = terminals.get(`${bModule.id}:${bSide}`)!;
        const straight = distance(a.mm, b.mm);
        if (straight > a.availableMm + b.availableMm + 1e-6) continue;
        let route: Point[] | null;
        if (aModule.figureId === bModule.figureId) {
          const guide = aModule.divisionId === bModule.divisionId ? guides.get(aModule.divisionId) ?? undefined : undefined;
          route = terminalPairRoute(a, b, regions.get(aModule.figureId) ?? [], guide, bodies);
        } else {
          route = exitsBody(a, b.mm) && exitsBody(b, a.mm) && routeAvoidsBodies([a.mm, b.mm], bodies, aModule.id, bModule.id) ? [a.mm, b.mm] : null;
        }
        if (!route) continue;
        const lengthMm = routeLength(route);
        if (lengthMm > a.availableMm + b.availableMm + 1e-6) continue;
        const candidate = { a, b, routeMm: route, lengthMm, bridgeLengthMm: 0 };
        (aModule.figureId === bModule.figureId ? insideCandidates : betweenCandidates).push(candidate);
      }
    }
  }
  const rank = (a: Candidate, b: Candidate) => a.lengthMm - b.lengthMm ||
    a.a.module.number - b.a.module.number || a.b.module.number - b.b.module.number;
  insideCandidates.sort(rank);
  betweenCandidates.sort(rank);
  const allTerminals = [...terminals.values()];
  const neighborDistance = new Map(allTerminals.map(terminal => [terminalKey(terminal), allTerminals.reduce((best, other) =>
    terminal.module.figureId === other.module.figureId ? best : Math.min(best, distance(terminal.mm, other.mm)), Infinity)]));
  const neighborPenalty = (terminal: Terminal) => measurements.lengthMm * 0.6 / (1 + (neighborDistance.get(terminalKey(terminal)) ?? Infinity) / measurements.lengthMm);
  const options = [
    insideCandidates,
    [...insideCandidates].sort((a, b) => (a.lengthMm + neighborPenalty(a.a) + neighborPenalty(a.b)) - (b.lengthMm + neighborPenalty(b.a) + neighborPenalty(b.b)) || rank(a, b)),
    [...insideCandidates].sort((a, b) => a.lengthMm - b.lengthMm || b.a.module.number - a.a.module.number || b.b.module.number - a.b.module.number),
  ];
  const forests = options.map(candidates => {
    const forest = new Forest(modules.map(module => module.id));
    for (const candidate of candidates) forest.add(candidate);
    for (const candidate of betweenCandidates) forest.add(candidate);
    return forest;
  });
  const forestScore = (forest: Forest): [number, number, number, number] => {
    const connected = new Set(forest.edges.flatMap(edge => [edge.a.module.id, edge.b.module.id])).size;
    const crossFigure = forest.edges.filter(edge => edge.a.module.figureId !== edge.b.module.figureId).length;
    let nearestFree = Infinity;
    for (const a of allTerminals) {
      if (forest.used.has(terminalKey(a))) continue;
      for (const b of allTerminals) {
        if (a.module.figureId === b.module.figureId || forest.used.has(terminalKey(b)) || forest.root(a.module.id) === forest.root(b.module.id)) continue;
        nearestFree = Math.min(nearestFree, distance(a.mm, b.mm));
      }
    }
    const totalLength = forest.edges.reduce((sum, edge) => sum + edge.lengthMm, 0);
    return [connected, crossFigure, Number.isFinite(nearestFree) ? -nearestFree : 0, -totalLength];
  };
  const scored = forests.map(forest => ({ forest, score: forestScore(forest) }));
  scored.sort((a, b) => {
    for (let index = 0; index < a.score.length; index++) if (a.score[index] !== b.score[index]) return b.score[index] - a.score[index];
    return 0;
  });
  const forestA = scored[0].forest;
  const pigtailPotential = new Set([...insideCandidates, ...betweenCandidates].flatMap(candidate => [candidate.a.module.id, candidate.b.module.id]));
  const pigtails = buildResult(model, modules, forestA, terminals, scale, pigtailPotential);
  const forestB = new Forest(modules.map(module => module.id), forestA);
  const bridgeCandidates: Candidate[] = [];
  for (let first = 0; first < modules.length; first++) {
    for (let second = first + 1; second < modules.length; second++) {
      if (modules[first].figureId === modules[second].figureId) continue;
      for (const aSide of ['left', 'right'] as const) for (const bSide of ['left', 'right'] as const) {
        const a = terminals.get(`${modules[first].id}:${aSide}`)!, b = terminals.get(`${modules[second].id}:${bSide}`)!;
        if (forestB.used.has(terminalKey(a)) || forestB.used.has(terminalKey(b))) continue;
        const lengthMm = distance(a.mm, b.mm);
        const bridgeLengthMm = lengthMm - a.availableMm - b.availableMm;
        if (bridgeLengthMm <= 1e-6 || (maxBridgeMm !== undefined && bridgeLengthMm > maxBridgeMm)) continue;
        if (!exitsBody(a, b.mm) || !exitsBody(b, a.mm) || !routeAvoidsBodies([a.mm, b.mm], bodies, a.module.id, b.module.id)) continue;
        bridgeCandidates.push({ a, b, routeMm: [a.mm, b.mm], lengthMm, bridgeLengthMm });
      }
    }
  }
  bridgeCandidates.sort((a, b) => a.bridgeLengthMm - b.bridgeLengthMm || rank(a, b));
  for (const candidate of bridgeCandidates) forestB.add(candidate);
  const bridgePotential = new Set([...pigtailPotential, ...bridgeCandidates.flatMap(candidate => [candidate.a.module.id, candidate.b.module.id])]);
  const bridges = buildResult(model, modules, forestB, terminals, scale, bridgePotential);
  return { pigtails, bridges };
}
