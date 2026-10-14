import type { SkeletonEdge, SkeletonResult } from './skeleton';
import { pointDistance } from './regions';

export const MIN_SKELETON_SPUR_MM = 30;
export const SKELETON_SPUR_RADIUS_FACTOR = 2.2;

const edgeLength = (edge: SkeletonEdge) => edge.points.slice(1).reduce((sum, point, index) => sum + pointDistance(point, edge.points[index]), 0);

/** Remove boundary corner spokes relative to local thickness, regardless of drawing scale. */
export function usefulSkeletonEdges(skeleton: SkeletonResult): SkeletonEdge[] {
  const nodes = new Map(skeleton.nodes.map(node => [node.id, node]));
  const retained = skeleton.edges.filter(edge => {
    if (edge.closed) return true;
    const a = nodes.get(edge.from ?? ''), b = nodes.get(edge.to ?? '');
    if (!a || !b || (a.kind !== 'end' && b.kind !== 'end')) return true;
    const tip = a.kind === 'end' ? a : b, joint = tip === a ? b : a;
    return tip.radius > skeleton.resolution * 2 || edgeLength(edge) > joint.radius * SKELETON_SPUR_RADIUS_FACTOR;
  });
  // Preserve the directional graph of small isolated figures with no central spans.
  const regions = new Set(retained.map(edge => edge.regionId));
  return [...retained, ...skeleton.edges.filter(edge => !regions.has(edge.regionId))];
}

/** Prune terminal branches shorter than 3 cm or 2.2 times their local junction radius.
 * Closed cycles and spans between junctions are never candidates for pruning. */
export function filterSkeletonSpurs(skeleton: SkeletonResult): SkeletonResult {
  if (!skeleton.edges.length) return skeleton;

  let edges = [...skeleton.edges];
  let removed = 0;
  const nodes = new Map(skeleton.nodes.map(node => [node.id, node]));
  while (true) {
    const degree = new Map<string, number>();
    for (const edge of edges) if (!edge.closed) for (const id of [edge.from, edge.to]) if (id) degree.set(id, (degree.get(id) ?? 0) + 1);
    const shortTerminalEdges = new Set(edges.filter(edge => {
      if (edge.closed) return false;
      const from = edge.from ? nodes.get(edge.from) : undefined;
      const to = edge.to ? nodes.get(edge.to) : undefined;
      // A junction keeps its identity after neighboring spurs are removed. Otherwise
      // iterative pruning can misclassify a junction-to-junction span as a new spur.
      const fromIsTerminal = !from || from.kind === 'end' || (from.kind !== 'junction' && (degree.get(from.id) ?? 0) <= 1);
      const toIsTerminal = !to || to.kind === 'end' || (to.kind !== 'junction' && (degree.get(to.id) ?? 0) <= 1);
      if (!fromIsTerminal && !toIsTerminal) return false;
      const tip = from?.kind === 'end' ? from : to?.kind === 'end' ? to : fromIsTerminal ? from : to;
      const junction = tip === from ? to : from;
      const threshold = Math.max(MIN_SKELETON_SPUR_MM, (junction?.radius ?? 0) * SKELETON_SPUR_RADIUS_FACTOR);
      return edgeLength(edge) < threshold;
    }).map(edge => edge.id));
    if (!shortTerminalEdges.size) break;
    edges = edges.filter(edge => !shortTerminalEdges.has(edge.id));
    removed += shortTerminalEdges.size;
  }

  if (!removed) return skeleton;
  const referenced = new Set(edges.flatMap(edge => [edge.from, edge.to].filter((id): id is string => !!id)));
  return { ...skeleton, edges, nodes: skeleton.nodes.filter(node => node.kind === 'point' || referenced.has(node.id)),
    warnings: [...skeleton.warnings, `${removed} rama(s) terminal(es) corta(s) eliminada(s) (mínimo ${MIN_SKELETON_SPUR_MM / 10} cm, ajustado al grosor local).`] };
}
