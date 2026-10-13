import { generateSkeleton } from './skeleton';
import type { SkeletonResult } from './skeleton';
import { generatePartitions } from './partitions';
import type { PartitionConfig, PartitionResult } from './partitions';
import { distributeLeds } from './distribution';
import type { LedDistributionResult, PlacementOptions } from './distribution';
import type { ModuleMeasurements } from './module';
import type { SvgModel } from './types';
import type { buildRegions } from './regions';
import { composeSerpentGuides } from './serpent-guides';
import type { SerpentGuides } from './serpent-guides';
import { filterSkeletonSpurs, MIN_SKELETON_SPUR_MM } from './skeleton-filter';

export interface LayoutResult { skeleton: SkeletonResult; sourceSkeleton: SkeletonResult; divisions: PartitionResult | null; serpentGuides: SerpentGuides | null; distribution: LedDistributionResult | null }
export interface LayoutPlacement { config: PartitionConfig; measurements: ModuleMeasurements | null; options: PlacementOptions }
export interface LayoutInput { model: SvgModel; geometry?: ReturnType<typeof buildRegions>; physicalSize?: { widthMm: number; heightMm: number }; skeleton?: SkeletonResult; placement: LayoutPlacement | null }

self.onmessage = (event: MessageEvent<LayoutInput>) => {
  try {
    const { model, geometry, physicalSize, placement } = event.data;
    const sourceSkeleton = event.data.skeleton ?? generateSkeleton(model, physicalSize, geometry);
    const skeleton = sourceSkeleton.units === 'mm' ? filterSkeletonSpurs(sourceSkeleton, MIN_SKELETON_SPUR_MM) : sourceSkeleton;
    let divisions = placement && physicalSize ? generatePartitions(skeleton, placement.config) : null;
    if (divisions && placement?.measurements && physicalSize) {
      const bodyOnly = { ...placement.measurements, leftPigtailMm: 0, rightPigtailMm: 0 };
      const fit = distributeLeds(model, divisions, bodyOnly, physicalSize.widthMm, physicalSize.heightMm,
        { minimumGapMm: 0, maximumGapMm: 0, independentPaths: true });
      const fittingIds = new Set(fit.modules.map(module => module.divisionId));
      const paths = divisions.paths.filter(path => fittingIds.has(path.id));
      const removed = divisions.paths.length - paths.length;
      if (removed) divisions = { ...divisions, paths, pairs: paths.filter(path => path.lane === -1).length,
        warnings: [...divisions.warnings, `${removed} partida(s) oculta(s): no cabe físicamente el cuerpo de un módulo LED en el trazo.`] };
    }
    const serpentGuides = divisions ? composeSerpentGuides(skeleton, divisions) : null;
    const distribution = serpentGuides && placement?.measurements && physicalSize ? distributeLeds(model, serpentGuides, placement.measurements, physicalSize.widthMm, physicalSize.heightMm, placement.options) : null;
    self.postMessage({ result: { skeleton, sourceSkeleton, divisions, serpentGuides, distribution } satisfies LayoutResult });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo calcular la distribución.' });
  }
};
