import type { Point, SvgModel } from './types';
import { buildRegions, pathData, pointDistance, polygonContains, scaleRegion, unscalePoint } from './regions';
import type { GeometryRegion, GeometryScale } from './regions';

export interface SkeletonNode { id: string; regionId: string; figureId: string; kind: 'point' | 'end' | 'junction'; point: Point; radius: number }
export interface SkeletonEdge { id: string; regionId: string; figureId: string; from: string | null; to: string | null; points: Point[]; closed: boolean; d: string }
/** Points/radii use the declared working units. d and regions remain in SVG coordinates. */
export interface SkeletonResult { nodes: SkeletonNode[]; edges: SkeletonEdge[]; regions: GeometryRegion[]; scale: GeometryScale; units: 'mm' | 'svg'; resolution: number; warnings: string[] }

// Exact squared Euclidean distance transform of a raster, using parabolic envelopes.
function edtLine(values: Float64Array, length: number): Float64Array {
  const sites = new Int32Array(length), limits = new Float64Array(length + 1), result = new Float64Array(length);
  let k = 0; sites[0] = 0; limits[0] = -Infinity; limits[1] = Infinity;
  for (let q = 1; q < length; q++) {
    let s = ((values[q] + q * q) - (values[sites[k]] + sites[k] * sites[k])) / (2 * (q - sites[k]));
    while (s <= limits[k]) { k--; s = ((values[q] + q * q) - (values[sites[k]] + sites[k] * sites[k])) / (2 * (q - sites[k])); }
    sites[++k] = q; limits[k] = s; limits[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < length; q++) { while (limits[k + 1] < q) k++; result[q] = (q - sites[k]) ** 2 + values[sites[k]]; }
  return result;
}

function distances(mask: Uint8Array, columns: number, rows: number): Float64Array {
  const result = new Float64Array(mask.length), buffer = new Float64Array(Math.max(columns, rows));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) buffer[x] = mask[y * columns + x] ? 1e12 : 0;
    result.set(edtLine(buffer, columns), y * columns);
  }
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < rows; y++) buffer[y] = result[y * columns + x];
    const line = edtLine(buffer, rows);
    for (let y = 0; y < rows; y++) result[y * columns + x] = line[y];
  }
  return result;
}

function components(pattern: number): number {
  let count = 0, remaining = pattern;
  while (remaining) {
    const first = Math.floor(Math.log2(remaining & -remaining)), queue = [first];
    remaining &= ~(1 << first); count++;
    while (queue.length) {
      const p = queue.pop()!, x = p % 3, y = Math.floor(p / 3);
      for (let q = 0; q < 9; q++) if ((remaining & (1 << q)) && Math.abs(q % 3 - x) <= 1 && Math.abs(Math.floor(q / 3) - y) <= 1) {
        remaining &= ~(1 << q); queue.push(q);
      }
    }
  }
  return count;
}
const countBits = (n: number) => { let count = 0; for (; n; n &= n - 1) count++; return count; };
const keep = Uint8Array.from({ length: 512 }, (_, pattern) => Number(!!(pattern & 16) && (countBits(pattern) < 3 || components(pattern) !== components(pattern & ~16))));

function simplify(points: Point[], tolerance: number): Point[] {
  const keepIndices = new Set([0, points.length - 1]), stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!, a = points[first], b = points[last];
    const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
    let farthest = -1, error = tolerance;
    for (let i = first + 1; i < last; i++) {
      const p = points[i], t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared)) : 0;
      const gap = Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
      if (gap > error) { error = gap; farthest = i; }
    }
    if (farthest >= 0) { keepIndices.add(farthest); stack.push([first, farthest], [farthest, last]); }
  }
  return [...keepIndices].sort((a, b) => a - b).map(i => points[i]);
}

function medialMask(mask: Uint8Array, columns: number, distance: Float64Array): Uint8Array {
  const result = mask.slice(), offsets = [-columns - 1, -columns, -columns + 1, -1, 0, 1, columns - 1, columns, columns + 1];
  const patternAt = (index: number, pixels: Uint8Array) => offsets.reduce((pattern, offset, bit) => pattern | ((pixels[index + offset] ?? 0) << bit), 0);
  const foreground = Array.from(mask.keys()).filter(i => mask[i]);
  const corners = new Uint8Array(mask.length);
  for (const i of foreground) corners[i] = 9 - countBits(patternAt(i, mask));
  // Stable tie ordering prevents run-to-run geometry changes; no random state.
  const tie = (i: number) => Math.imul(i ^ (i >>> 16), 0x45d9f3b) >>> 0;
  foreground.sort((a, b) => distance[a] - distance[b] || corners[a] - corners[b] || tie(a) - tie(b));
  for (const i of foreground) result[i] = keep[patternAt(i, result)];
  return result;
}

function raster(region: GeometryRegion, step: number) {
  const minX = Math.min(...region.outer.map(p => p.x)), minY = Math.min(...region.outer.map(p => p.y));
  const width = Math.max(...region.outer.map(p => p.x)) - minX, height = Math.max(...region.outer.map(p => p.y)) - minY;
  const columns = Math.ceil(width / step) + 6, rows = Math.ceil(height / step) + 6;
  const x = minX - 2.5 * step, y = minY - 2.5 * step, mask = new Uint8Array(columns * rows);
  for (let row = 1; row < rows - 1; row++) {
    const py = y + row * step, cuts: number[] = [];
    for (const loop of [region.outer, ...region.holes]) for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      if ((a.y > py) !== (b.y > py)) cuts.push(a.x + (py - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i += 2) {
      const start = Math.max(1, Math.ceil((cuts[i] - x) / step)), end = Math.min(columns - 2, Math.floor((cuts[i + 1] - x) / step));
      for (let col = start; col <= end; col++) mask[row * columns + col] = 1;
    }
  }
  return { mask, columns, rows, x, y };
}

function vectorize(region: GeometryRegion, scale: GeometryScale, step: number): { nodes: SkeletonNode[]; edges: SkeletonEdge[] } {
  const grid = raster(region, step), distance = distances(grid.mask, grid.columns, grid.rows);
  const pixels = medialMask(grid.mask, grid.columns, distance), ids = Array.from(pixels.keys()).filter(i => pixels[i]);
  const point = (i: number): Point => ({ x: grid.x + i % grid.columns * step, y: grid.y + Math.floor(i / grid.columns) * step });
  const radius = (i: number) => Math.sqrt(distance[i]) * step;
  if (!ids.length) return { nodes: [], edges: [] };
  const adjacency = new Map<number, number[]>();
  for (const i of ids) {
    const neighbors: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = i + dy * grid.columns + dx;
      if (!pixels[j] || (dx && dy && (pixels[i + dx] || pixels[i + dy * grid.columns]))) continue;
      neighbors.push(j);
    }
    adjacency.set(i, neighbors);
  }
  // Numerical spokes of a disk are contained in the same maximal disk. Never collapse holes.
  const deepest = ids.reduce((a, b) => distance[a] >= distance[b] ? a : b);
  const center = point(deepest), maxRadius = radius(deepest);
  if (!region.holes.length && ids.every(i => pointDistance(point(i), center) + radius(i) <= maxRadius + step * 2.5)) {
    return { nodes: [{ id: `${region.id}-point`, regionId: region.id, figureId: region.figureId, kind: 'point', point: center, radius: maxRadius }], edges: [] };
  }
  const nodeOf = new Map<number, SkeletonNode>(), nodes: SkeletonNode[] = [], members = new Map<string, number[]>();
  for (const i of ids) {
    const degree = adjacency.get(i)!.length;
    if (degree === 2 || nodeOf.has(i)) continue;
    const cluster = [i], visited = new Set([i]);
    if (degree > 2) for (let head = 0; head < cluster.length; head++) for (const j of adjacency.get(cluster[head])!) {
      if (adjacency.get(j)!.length > 2 && !visited.has(j)) { visited.add(j); cluster.push(j); }
    }
    const position = cluster.map(point).reduce((a, b) => ({ x: a.x + b.x / cluster.length, y: a.y + b.y / cluster.length }), { x: 0, y: 0 });
    const node: SkeletonNode = { id: `${region.id}-node-${nodes.length}`, regionId: region.id, figureId: region.figureId,
      kind: degree === 0 ? 'point' : degree === 1 ? 'end' : 'junction', point: position, radius: Math.max(...cluster.map(radius)) };
    nodes.push(node); members.set(node.id, cluster); for (const j of cluster) nodeOf.set(j, node);
  }
  const used = new Set<string>(), edges: SkeletonEdge[] = [];
  const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  function walk(start: number, next: number, from: SkeletonNode | null) {
    const line: Point[] = [from?.point ?? point(start)];
    let previous = start, current = next, to: SkeletonNode | null = null, closed = false;
    used.add(key(previous, current));
    for (let guard = 0; guard <= ids.length; guard++) {
      if (current === start) { closed = true; break; }
      to = nodeOf.get(current) ?? null;
      line.push(to?.point ?? point(current));
      if (to) break;
      const target = adjacency.get(current)!.find(i => i !== previous && !used.has(key(current, i)));
      if (target === undefined) break;
      previous = current; current = target; used.add(key(previous, current));
    }
    if (line.length < 2) return;
    const length = line.slice(1).reduce((sum, p, i) => sum + pointDistance(p, line[i]), 0);
    // Only sub-resolution terminal spurs may be discarded; genuine medial branches survive.
    if (!closed && length <= step * 2 && (from?.kind === 'end' || to?.kind === 'end')) return;
    if (from && to?.id === from.id) { closed = true; line.pop(); }
    // A medial cycle must surround an actual hole. Pixel clusters at junctions can
    // leave tiny self-loops; they are numerical artifacts, not figure topology.
    if (closed && !region.holes.some(hole => polygonContains(hole[0], line))) return;
    const simplified = simplify(closed ? [...line, line[0]] : line, step * 0.6);
    if (closed) simplified.pop();
    edges.push({ id: `${region.id}-edge-${edges.length}`, regionId: region.id, figureId: region.figureId,
      from: from?.id ?? null, to: to?.id ?? null, points: simplified, closed, d: pathData(simplified.map(p => unscalePoint(p, scale)), closed) });
  }
  for (const node of nodes) for (const i of members.get(node.id)!) for (const j of adjacency.get(i)!) {
    if (nodeOf.get(j)?.id === node.id) { used.add(key(i, j)); continue; }
    if (!used.has(key(i, j))) walk(i, j, node);
  }
  for (const i of ids) for (const j of adjacency.get(i)!) if (!used.has(key(i, j))) walk(i, j, null);
  const referenced = new Set(edges.flatMap(e => [e.from, e.to]));
  return { nodes: nodes.filter(n => n.kind === 'point' || referenced.has(n.id)), edges };
}

export function generateSkeleton(model: SvgModel, physicalSize?: { widthMm: number; heightMm: number }): SkeletonResult {
  if (physicalSize && ![physicalSize.widthMm, physicalSize.heightMm].every(n => Number.isFinite(n) && n > 0)) throw new Error('Las medidas físicas deben ser positivas.');
  const scale = physicalSize ? { x: physicalSize.widthMm / model.viewBox.width, y: physicalSize.heightMm / model.viewBox.height } : { x: 1, y: 1 };
  const { regions, warnings } = buildRegions(model.figures);
  const nodes: SkeletonNode[] = [], edges: SkeletonEdge[] = [];
  let resolution = 0;
  for (const original of regions) {
    const physicalRegion = scaleRegion(original, scale);
    // Align the sampling frame with dominant boundary directions. This is a
    // numerical coordinate change, not a new axis or route in the figure.
    let cosine = 0, sine = 0, perimeter = 0;
    for (let i = 0; i < physicalRegion.outer.length; i++) {
      const a = physicalRegion.outer[i], b = physicalRegion.outer[(i + 1) % physicalRegion.outer.length];
      const length = pointDistance(a, b), angle = Math.atan2(b.y - a.y, b.x - a.x);
      cosine += length * Math.cos(4 * angle); sine += length * Math.sin(4 * angle); perimeter += length;
    }
    const angle = Math.hypot(cosine, sine) > perimeter * 0.3 ? Math.atan2(sine, cosine) / 4 : 0;
    const c = Math.cos(angle), s = Math.sin(angle);
    const align = (p: Point): Point => ({ x: p.x * c + p.y * s, y: -p.x * s + p.y * c });
    const restore = (p: Point): Point => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });
    const region = { ...physicalRegion, outer: physicalRegion.outer.map(align), holes: physicalRegion.holes.map(hole => hole.map(align)) };
    const span = Math.max(Math.max(...region.outer.map(p => p.x)) - Math.min(...region.outer.map(p => p.x)), Math.max(...region.outer.map(p => p.y)) - Math.min(...region.outer.map(p => p.y)));
    if (!(span > 0)) continue;
    const step = Math.max(span / 768, Math.min(physicalSize ? 0.25 : span / 512, span / 256));
    resolution = Math.max(resolution, step);
    const result = vectorize(region, scale, step);
    nodes.push(...result.nodes.map(node => ({ ...node, point: restore(node.point) })));
    edges.push(...result.edges.map(edge => { const points = edge.points.map(restore); return { ...edge, points, d: pathData(points.map(p => unscalePoint(p, scale)), edge.closed) }; }));
    if (!result.edges.length && result.nodes.length) warnings.push(`${model.figures.find(f => f.id === region.figureId)?.name}: Skeleton puntual, sin recorrido direccional.`);
  }
  if (physicalSize && resolution > 0.5) warnings.push(`Skeleton aproximado con resolución de ${resolution.toFixed(2)} mm.`);
  return { nodes, edges, regions, scale, units: physicalSize ? 'mm' : 'svg', resolution, warnings };
}
