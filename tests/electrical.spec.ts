import { test, expect } from '@playwright/test';
import { estimateElectrical } from '../src/engine/electrical';
import type { LedDistributionResult } from '../src/engine/distribution';
import type { ConnectivityResult } from '../src/engine/connectivity';

const distribution = {
  modules: Array.from({ length: 10 }, (_, index) => ({ id: `m${index + 1}` })),
  byFigure: [{ figureId: 'a', name: 'figura A', placed: 6, unplaced: 0 }, { figureId: 'b', name: 'figura B', placed: 4, unplaced: 0 }],
  total: 10, unplaced: 0,
} as LedDistributionResult;
const flow = {
  chains: [{ id: 'chain-1', moduleIds: Array.from({ length: 8 }, (_, index) => `m${index + 1}`) }],
  discardedIds: ['m9', 'm10'],
} as ConnectivityResult;

test('keeps electrical status unresolved when specifications are missing', () => {
  const result = estimateElectrical(distribution, flow, {
    moduleVoltageV: null, modulePowerW: null, moduleCurrentA: null,
    supplies: [], maxModulesPerChain: null, reservePercent: 20,
  });
  expect(result.validated).toBe(false);
  expect(result.totalPowerW).toBeNull();
  expect(result.availablePowerW).toBeNull();
  expect(result.estimatedSources).toBeNull();
  expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('Falta el voltaje'), expect.stringContaining('Falta el máximo')]));
});

test('uses 20 percent reserve and manufacturer chain limit without treating it as approval', () => {
  const result = estimateElectrical(distribution, flow, {
    moduleVoltageV: 12, modulePowerW: 1.5, moduleCurrentA: null,
    supplies: [{ id: '1', voltageV: 12, capacityW: 20, capacityA: null }],
    maxModulesPerChain: 6, reservePercent: 20,
  });
  expect(result.validated).toBe(false);
  expect(result.moduleCurrentA).toBeCloseTo(0.125);
  expect(result.totalPowerW).toBe(15);
  expect(result.byFigure.map(figure => figure.powerW)).toEqual([9, 6]);
  expect(result.supplies[0].usableW).toBe(16);
  expect(result.availablePowerW).toBe(16);
  expect(result.estimatedSources).toBe(1);
  expect(result.chainSplits[0].additionalInjectionPoints).toBe(1);
});

test('does not count an incompatible source or contradictory module specifications', () => {
  const mismatch = estimateElectrical(distribution, flow, {
    moduleVoltageV: 12, modulePowerW: null, moduleCurrentA: 0.1,
    supplies: [{ id: '1', voltageV: 24, capacityW: null, capacityA: 2 }],
    maxModulesPerChain: null, reservePercent: 20,
  });
  expect(mismatch.totalPowerW).toBeCloseTo(12);
  expect(mismatch.availablePowerW).toBeNull();
  expect(mismatch.estimatedSources).toBeNull();
  expect(mismatch.issues).toEqual(expect.arrayContaining([expect.stringContaining('voltaje no coincide')]));

  const contradictory = estimateElectrical(distribution, flow, {
    moduleVoltageV: 12, modulePowerW: 5, moduleCurrentA: 0.1,
    supplies: [{ id: '1', voltageV: 12, capacityW: 100, capacityA: null }],
    maxModulesPerChain: 10, reservePercent: 20,
  });
  expect(contradictory.totalPowerW).toBeNull();
  expect(contradictory.issues).toEqual(expect.arrayContaining([expect.stringContaining('no coinciden')]));
});
