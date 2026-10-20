import ClipperLib from 'clipper-lib';
import { distributeLeds } from './distribution';
import type { LedDistributionResult, PlacementOptions } from './distribution';
import type { ModuleMeasurements } from './module';
import { pathData, pointDistance, scaleRegion, unscalePoint } from './regions';
import type { GeometryRegion, GeometryScale } from './regions';
import type { SerpentGuide, SerpentGuides } from './serpent-guides';
import type { Point, SvgModel } from './types';

const INTEGER_SCALE = 1000; // One integer unit is 0.001 mm, regardless of SVG units.

function insetContours(region: GeometryRegion, insetMm: number): Point[][] {
  // Translate before quantizing so a distant SVG origin does not waste precision.
  const origin = region.outer[0];
  const polygon = (points: Point[], outer: boolean): ClipperLib.Path => {
    const result = points.map(point => ({ X: Math.round((point.x - origin.x) * INTEGER_SCALE),
      Y: Math.round((point.y - origin.y) * INTEGER_SCALE) }));
    if (ClipperLib.Clipper.Orientation(result) !== outer) result.reverse();
    return result;
  };
  const paths = [polygon(region.outer, true), ...region.holes.map(hole => polygon(hole, false))];
  const offset = new ClipperLib.ClipperOffset(2, 0.1 * INTEGER_SCALE);
  offset.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const tree = new ClipperLib.PolyTree();
  offset.Execute(tree, -insetMm * INTEGER_SCALE);
  // The hole loops constrain the inset but do not become extra LED rows.
  return tree.Childs().filter(node => !node.IsHole()).map(node => node.Contour().map(point => ({
    x: point.X / INTEGER_SCALE + origin.x, y: point.Y / INTEGER_SCALE + origin.y,
  }))).filter(points => points.length >= 3);
}

const perimeter = (points: Point[]) => points.reduce((length, point, i) =>
  length + pointDistance(point, points[(i + 1) % points.length]), 0);

function borderGuide(region: GeometryRegion, physical: Point[], scale: GeometryScale, fragment = 0): SerpentGuide {
  const id = `border-${region.id}${fragment ? `-fragment-${fragment}` : ''}`, points = physical.map(point => unscalePoint(point, scale));
  return { id, figureId: region.figureId, regionId: region.id, outerContourId: region.outerContourId,
    innerContourId: '', index: 0, fraction: 0, points, d: pathData(points, true), closed: true,
    bodyFiltered: true, sourceEdgeId: id, sourceRange: [0, perimeter(physical)], lane: 0, origin: 'border' };
}

/** One inset exterior trace per filled piece, calculated entirely from its
 * original boundary and holes. The medial graph and coverage branches do not
 * participate in this arrangement. Narrow necks may split that same exterior
 * row into useful fragments; none of the hole loops become extra rows. */
export function generateBorderLayout(model: SvgModel, geometry: { regions: GeometryRegion[]; warnings: string[] },
  size: { widthMm: number; heightMm: number }, measurements: ModuleMeasurements | null,
  options: PlacementOptions): { guides: SerpentGuides; distribution: LedDistributionResult | null } {
  const scale = { x: size.widthMm / model.viewBox.width, y: size.heightMm / model.viewBox.height };
  const guides: SerpentGuides = { regions: geometry.regions, paths: [], pairs: 0, warnings: [...geometry.warnings] };
  const clearance = options.edgeMarginMm ?? Math.min(0.2, (measurements?.widthMm ?? 4) * 0.05);
  const baseInset = measurements ? measurements.widthMm / 2 + clearance + 0.25 : 1;
  // Tangent bodies need more retreat on convex curves than on straight edges.
  // Compare physical retreats, maximizing usable LEDs and preferring the
  // closest to the edge on a tie. Each piece still gets a single trace.
  const extraStep = measurements ? Math.max(measurements.widthMm, measurements.lengthMm / 4) : 0;
  const retreats = measurements ? [0, 0.25, 0.5, 1, 1.5, 2].map(fraction => baseInset + extraStep * fraction) : [baseInset];
  for (const region of geometry.regions) {
    const physical = scaleRegion(region, scale);
    let best: { paths: SerpentGuide[]; count: number; split: boolean } | null = null;
    for (const inset of retreats) {
      const loops = insetContours(physical, inset).sort((a, b) => perimeter(b) - perimeter(a));
      if (!loops.length) continue;
      const paths = loops.map((loop, i) => borderGuide(region, loop, scale, i));
      const distribution = measurements ? distributeLeds(model, { ...guides, paths }, measurements,
        size.widthMm, size.heightMm, options) : null;
      const occupied = new Set(distribution?.modules.map(module => module.divisionId));
      const useful = distribution ? paths.filter(path => occupied.has(path.id)) : paths;
      const count = distribution?.total ?? 0;
      if (!best || count > best.count) best = { paths: useful, count, split: loops.length > 1 };
    }
    const name = model.figures.find(figure => figure.id === region.figureId)?.name ?? region.figureId;
    if (!best || (measurements && !best.count)) {
      guides.warnings.push(`${name}: no cabe un módulo LED sobre el recorrido del borde con estas medidas.`);
      continue;
    }
    guides.paths.push(...best.paths);
    if (best.split) guides.warnings.push(`${name}: las zonas estrechas separan la fila del borde; se conservan ${best.paths.length} fragmento(s) útil(es). Las conexiones se comprueban por separado.`);
  }
  return { guides, distribution: measurements ? distributeLeds(model, guides, measurements,
    size.widthMm, size.heightMm, options) : null };
}
