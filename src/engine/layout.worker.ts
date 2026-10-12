import { generateSkeleton } from './skeleton';
import type { SkeletonResult } from './skeleton';
import { generatePartitions } from './partitions';
import type { PartitionConfig, PartitionResult } from './partitions';
import { distributeLeds } from './distribution';
import type { LedDistributionResult, PlacementOptions } from './distribution';
import type { ModuleMeasurements } from './module';
import type { SvgModel } from './types';
import type { buildRegions } from './regions';

export interface LayoutResult { skeleton: SkeletonResult; divisions: PartitionResult | null; distribution: LedDistributionResult | null }
export interface LayoutPlacement { config: PartitionConfig; measurements: ModuleMeasurements | null; options: PlacementOptions }
export interface LayoutInput { model: SvgModel; geometry?: ReturnType<typeof buildRegions>; physicalSize?: { widthMm: number; heightMm: number }; skeleton?: SkeletonResult; placement: LayoutPlacement | null }

self.onmessage = (event: MessageEvent<LayoutInput>) => {
  try {
    const { model, geometry, physicalSize, placement } = event.data;
    const skeleton = event.data.skeleton ?? generateSkeleton(model, physicalSize, geometry);
    const divisions = placement && physicalSize ? generatePartitions(skeleton, placement.config) : null;
    const distribution = divisions && placement?.measurements && physicalSize ? distributeLeds(model, divisions, placement.measurements, physicalSize.widthMm, physicalSize.heightMm, placement.options) : null;
    self.postMessage({ result: { skeleton, divisions, distribution } satisfies LayoutResult });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo calcular la distribución.' });
  }
};
