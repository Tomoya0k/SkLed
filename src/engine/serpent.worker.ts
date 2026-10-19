import { planSerpent, serpentScope } from './serpent';
import type { SvgModel } from './types';
import type { DivisionResult } from './divisions';
import type { LedDistributionResult } from './distribution';
import type { ModuleMeasurements } from './module';

self.onmessage = (event: MessageEvent<{ model: SvgModel; divisions: DivisionResult; distribution: LedDistributionResult; measurements: ModuleMeasurements; widthMm: number; heightMm: number; avoidModuleCollisions?: boolean; allowBridges?: boolean }>) => {
  try {
    const { model, divisions, distribution, measurements, widthMm, heightMm } = event.data;
    const scopes = [...new Set(distribution.modules.map(serpentScope))];
    self.postMessage({ result: scopes.map(scopeId => planSerpent(model, divisions, distribution, measurements, widthMm, heightMm,
      { scopeId, avoidModuleCollisions: event.data.avoidModuleCollisions ?? true, allowBridges: event.data.allowBridges ?? false })) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo calcular el recorrido serpiente.' });
  }
};
