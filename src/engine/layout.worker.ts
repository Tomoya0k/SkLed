import { generateSkeleton } from './skeleton';
import type { SkeletonResult } from './skeleton';
import { generatePartitions, extendShortPartitionPaths } from './partitions';
import type { PartitionConfig, PartitionResult } from './partitions';
import { distributeLeds } from './distribution';
import type { LedDistributionResult, PlacementOptions } from './distribution';
import type { ModuleMeasurements } from './module';
import type { SvgModel } from './types';
import type { buildRegions } from './regions';
import { composeSerpentGuides, singleLedPartitionIds } from './serpent-guides';
import type { SerpentGuide, SerpentGuides } from './serpent-guides';
import { filterSkeletonSpurs } from './skeleton-filter';
import { recoverMissingCoverageGuides, restoreCoverageBranches } from './skeleton-coverage';

export interface LayoutResult { skeleton: SkeletonResult; sourceSkeleton: SkeletonResult; divisions: PartitionResult | null; serpentGuides: SerpentGuides | null; distribution: LedDistributionResult | null }
export interface LayoutPlacement { config: PartitionConfig; measurements: ModuleMeasurements | null; options: PlacementOptions }
export interface LayoutInput { model: SvgModel; geometry?: ReturnType<typeof buildRegions>; physicalSize?: { widthMm: number; heightMm: number }; skeleton?: SkeletonResult; placement: LayoutPlacement | null; coverageMeasurements?: ModuleMeasurements }

self.onmessage = (event: MessageEvent<LayoutInput>) => {
  try {
    const { model, geometry, physicalSize, placement } = event.data;
    const sourceSkeleton = event.data.skeleton ?? generateSkeleton(model, physicalSize, geometry);
    let skeleton = sourceSkeleton.units === 'mm' ? filterSkeletonSpurs(sourceSkeleton) : sourceSkeleton;
    const coverageMeasurements = event.data.coverageMeasurements ?? placement?.measurements;
    if (coverageMeasurements && physicalSize) {
      skeleton = restoreCoverageBranches(model, sourceSkeleton, skeleton, coverageMeasurements, physicalSize);
    }
    let divisions = placement && physicalSize ? generatePartitions(skeleton, placement.config) : null;
    if (divisions && placement?.measurements && physicalSize) {
      divisions = extendShortPartitionPaths(divisions, skeleton, placement.measurements.lengthMm);
      const bodyOnly = { ...placement.measurements, leftPigtailMm: 0, rightPigtailMm: 0 };
      const fit = distributeLeds(model, divisions, bodyOnly, physicalSize.widthMm, physicalSize.heightMm,
        { minimumGapMm: 0, maximumGapMm: 0, independentPaths: true });
      const fittingIds = new Set(fit.modules.map(module => module.divisionId));
      const paths = divisions.paths.filter(path => fittingIds.has(path.id));
      const removed = divisions.paths.length - paths.length;
      if (removed) divisions = { ...divisions, paths, pairs: paths.filter(path => path.lane === -1).length,
        warnings: [...divisions.warnings, `${removed} partida(s) oculta(s): no cabe físicamente el cuerpo de un módulo LED en el trazo.`] };
    }
    let serpentGuides = divisions ? composeSerpentGuides(skeleton, divisions) : null;
    let distribution = serpentGuides && placement?.measurements && physicalSize ? distributeLeds(model, serpentGuides, placement.measurements, physicalSize.widthMm, physicalSize.heightMm, placement.options) : null;
    if (divisions && serpentGuides && distribution && placement?.measurements && physicalSize) {
      let supplementalGuides: SerpentGuide[] = [];
      let coverageRecovered = false;
      // Every pass removes paths, so this converges without toggling a partida
      // back on. Rebuild from source spans to restore the actual centerline,
      // then rerun all body, spacing and collision checks on the new layout.
      while (true) {
        const singleIds = singleLedPartitionIds(serpentGuides, distribution);
        if (singleIds.size) {
          const paths: PartitionResult['paths'] = divisions.paths.filter(path => !singleIds.has(path.id));
          if (paths.length !== divisions.paths.length) {
            divisions = { ...divisions, paths, pairs: paths.filter(path => path.lane === -1).length };
            serpentGuides = composeSerpentGuides(skeleton, divisions);
            if (supplementalGuides.length) serpentGuides = { ...serpentGuides,
              paths: [...supplementalGuides, ...serpentGuides.paths] };
            distribution = distributeLeds(model, serpentGuides, placement.measurements, physicalSize.widthMm, physicalSize.heightMm, placement.options);
            continue;
          }
        }
        if (!coverageRecovered) {
          coverageRecovered = true;
          supplementalGuides = recoverMissingCoverageGuides(skeleton, serpentGuides, distribution, placement.measurements);
          if (supplementalGuides.length) {
            serpentGuides = { ...serpentGuides, paths: [...supplementalGuides, ...serpentGuides.paths] };
            distribution = distributeLeds(model, serpentGuides, placement.measurements, physicalSize.widthMm, physicalSize.heightMm, placement.options);
            continue;
          }
        }
        break;
      }
    }
    self.postMessage({ result: { skeleton, sourceSkeleton, divisions, serpentGuides, distribution } satisfies LayoutResult });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo calcular la distribución.' });
  }
};
