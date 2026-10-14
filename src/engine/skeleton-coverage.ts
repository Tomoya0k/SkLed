import type { SkeletonResult, SkeletonEdge } from './skeleton';
import type { ModuleMeasurements } from './module';
import type { SvgModel, Point } from './types';
import type { DivisionPath } from './divisions';
import { distributeLeds, pathPolyline, pointAt } from './distribution';
import { minimumPigtailSpacingMm } from './pigtail-spacing';
import { pathData, unscalePoint, scalePoint } from './regions';

// Only recover gaps larger than two normal LED pitches; ordinary terminal
// margins should not reintroduce every corner spoke removed by pruning.
export const COVERAGE_GAP_PITCH_FACTOR = 2;

/** Restore useful portions of pruned medial branches when they can host a
 * physical LED far from the retained centerlines. This is geometric coverage,
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
  const distanceToSegment = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  const added: SkeletonEdge[] = [], tips = [];
  for (const { edge, path, joint } of candidates) {
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
    });
    if (!usable.length) continue;
    const line = pathPolyline(path, source.scale);
    if (!line) continue;
    const end = Math.min(line.length, Math.max(...usable.map(module => module.positionMm ?? 0)) + measurements.lengthMm / 2);
    const points = [...line.points.filter((_, i) => line.distances[i] < end), pointAt(line, end)];
    const tipId = `${edge.id}-coverage-tip`;
    tips.push({ id: tipId, regionId: edge.regionId, figureId: edge.figureId, kind: 'end' as const,
      point: points.at(-1)!, radius: measurements.widthMm / 2 });
    added.push({ ...edge, from: joint, to: tipId, points, closed: false, coverageBranch: true,
      d: pathData(points.map(p => unscalePoint(p, source.scale))) });
  }
  return added.length ? { ...filtered, edges: [...filtered.edges, ...added], nodes: [...filtered.nodes, ...tips],
    warnings: [...filtered.warnings, `${added.length} rama(s) recuperada(s) para cubrir zonas alejadas del recorrido.`] } : filtered;
}
