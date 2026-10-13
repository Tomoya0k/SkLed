import type { PartitionPath } from './partitions';
import type { GeometryRegion, GeometryScale } from './regions';
import { pathData, scaleRegion, unscalePoint } from './regions';
import { insideRegion, makeRectangle, pathPolyline, pointAt } from './distribution';

/** Keep only spans supported by at least one complete, physical LED body.
 * A long line or a wide cross-section alone does not establish body fit. */
export function filterPartitionsForBody(paths: PartitionPath[], regions: GeometryRegion[], scale: GeometryScale,
  config: { moduleLengthMm?: number; moduleWidthMm: number; edgeMarginMm: number }): PartitionPath[] {
  const lengthMm = config.moduleLengthMm;
  if (!lengthMm) return paths;
  const physicalRegions = new Map(regions.map(region => [region.id, scaleRegion(region, scale)]));
  return paths.flatMap(path => {
    const line = pathPolyline(path, scale), region = physicalRegions.get(path.regionId);
    if (!line || !region || line.length + 1e-6 < lengthMm) return [];
    const half = lengthMm / 2;
    const first = line.closed ? 0 : half, last = line.closed ? line.length : line.length - half;
    const count = Math.max(1, Math.ceil((last - first) / Math.max(0.25, Math.min(1, lengthMm / 40))));
    const supported: Array<[number, number]> = [];
    for (let i = 0; i <= count; i++) {
      if (line.closed && i === count) continue;
      const at = first + (last - first) * i / count;
      const body = makeRectangle(line, at, lengthMm, config.moduleWidthMm);
      if (!body || !insideRegion(body, { outer: region.outer, inner: null, holes: region.holes }, config.edgeMarginMm)) continue;
      const from = at - half, to = at + half;
      supported.push([Math.max(0, from), Math.min(line.length, to)]);
      if (line.closed && from < 0) supported.push([line.length + from, line.length]);
      if (line.closed && to > line.length) supported.push([0, to - line.length]);
    }
    const spans: Array<[number, number]> = [];
    for (const span of supported.sort((a, b) => a[0] - b[0])) {
      const previous = spans.at(-1);
      if (previous && span[0] <= previous[1] + 1e-6) previous[1] = Math.max(previous[1], span[1]);
      else spans.push([...span]);
    }
    if (!spans.length) return [];
    if (spans.length === 1 && spans[0][0] <= 1e-6 && spans[0][1] >= line.length - 1e-6) return [{ ...path, bodyFiltered: true }];
    // A closed guide has no arbitrary break at its SVG seam.
    if (line.closed && spans.length > 1 && spans[0][0] <= 1e-6 && spans.at(-1)![1] >= line.length - 1e-6) {
      const head = spans.shift()!, tail = spans.pop()!;
      spans.push([tail[0], line.length + head[1]]);
    }
    return spans.filter(([from, to]) => to - from + 1e-6 >= lengthMm).map(([from, to], index): PartitionPath => {
      const middle = line.points.flatMap((point, i) => [0, line.length].map(offset => ({ point, at: line.distances[i] + offset })))
        .filter(item => item.at > from + 1e-6 && item.at < to - 1e-6).sort((a, b) => a.at - b.at);
      const points = [pointAt(line, from), ...middle.map(item => item.point), pointAt(line, to)].map(point => unscalePoint(point, scale));
      const sourceLength = path.sourceRange[1] - path.sourceRange[0];
      return { ...path, id: `${path.id}-fit-${index}`, bodyFiltered: true, closed: false, points, d: pathData(points),
        sourceRange: [path.sourceRange[0] + from / line.length * sourceLength, path.sourceRange[0] + to / line.length * sourceLength] };
    });
  });
}
