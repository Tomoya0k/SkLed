import type { SkeletonEdge, SkeletonResult } from './skeleton';
import { pointDistance } from './regions';

export const MIN_SKELETON_SPUR_MM = 30;

const edgeLength = (edge: SkeletonEdge) => edge.points.slice(1).reduce((sum, point, index) => sum + pointDistance(point, edge.points[index]), 0);

/** Remove boundary corner spokes relative to local thickness, regardless of drawing scale. */
export function usefulSkeletonEdges(skeleton: SkeletonResult): SkeletonEdge[] {
  const nodes = new Map(skeleton.nodes.map(node => [node.id, node]));
  const retained = skeleton.edges.filter(edge => {
    if (edge.closed) return true;
    const a = nodes.get(edge.from ?? ''), b = nodes.get(edge.to ?? '');
    if (!a || !b || (a.kind !== 'end' && b.kind !== 'end')) return true;
    const tip = a.kind === 'end' ? a : b, joint = tip === a ? b : a;
    return tip.radius > skeleton.resolution * 2 || edgeLength(edge) > joint.radius * 2.2;
  });
  // Preserve the directional graph of small isolated figures with no central spans.
  const regions = new Set(retained.map(edge => edge.regionId));
  return [...retained, ...skeleton.edges.filter(edge => !regions.has(edge.regionId))];
}

/** Iteratively remove short terminal branches while retaining cycles and junction-to-junction spans. */
export function filterSkeletonSpurs(skeleton: SkeletonResult, minimumLength = MIN_SKELETON_SPUR_MM): SkeletonResult {
  if (!Number.isFinite(minimumLength) || minimumLength < 0) throw new Error('La longitud mínima de ramas debe ser cero o mayor.');
  if (minimumLength === 0 || !skeleton.edges.length) return skeleton;

  let edges = [...skeleton.edges];
  let removed = 0;
  const kindById = new Map(skeleton.nodes.map(node => [node.id, node.kind]));
  while (true) {
    const degree = new Map<string, number>();
    for (const edge of edges) if (!edge.closed) for (const id of [edge.from, edge.to]) if (id) degree.set(id, (degree.get(id) ?? 0) + 1);
    const shortTerminalEdges = new Set(edges.filter(edge => !edge.closed && edgeLength(edge) < minimumLength &&
      (!edge.from || (degree.get(edge.from) ?? 0) <= 1 || kindById.get(edge.from) === 'end' ||
       !edge.to || (degree.get(edge.to) ?? 0) <= 1 || kindById.get(edge.to) === 'end')).map(edge => edge.id));
    if (!shortTerminalEdges.size) break;
    edges = edges.filter(edge => !shortTerminalEdges.has(edge.id));
    removed += shortTerminalEdges.size;
  }

  if (!removed) return skeleton;
  const referenced = new Set(edges.flatMap(edge => [edge.from, edge.to].filter((id): id is string => !!id)));
  return { ...skeleton, edges, nodes: skeleton.nodes.filter(node => node.kind === 'point' || referenced.has(node.id)),
    warnings: [...skeleton.warnings, `${removed} rama(s) terminal(es) eliminada(s) por debajo de ${minimumLength / 10} cm.`] };
}
