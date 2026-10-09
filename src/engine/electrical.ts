import type { ConnectivityResult } from './connectivity';
import type { LedDistributionResult } from './distribution';

export interface SupplySpecification {
  id: string;
  voltageV: number | null;
  capacityW: number | null;
  capacityA: number | null;
}

export interface ElectricalSpecifications {
  moduleVoltageV: number | null;
  modulePowerW: number | null;
  moduleCurrentA: number | null;
  supplies: SupplySpecification[];
  maxModulesPerChain: number | null;
  reservePercent: number;
}

export interface ElectricalEstimate {
  /** Always false: datasheets, polarity, wiring and voltage drop are outside this geometric engine. */
  validated: false;
  modulePowerW: number | null;
  moduleCurrentA: number | null;
  totalPowerW: number | null;
  totalCurrentA: number | null;
  byFigure: Array<{ figureId: string; name: string; modules: number; powerW: number | null; currentA: number | null }>;
  supplies: Array<{ id: string; voltageV: number | null; ratedW: number | null; usableW: number | null; voltageMatches: boolean | null }>;
  availablePowerW: number | null;
  estimatedSources: number | null;
  additionalSourcesOfSameModel: number | null;
  deficitW: number | null;
  chainSplits: Array<{ chainId: string; modules: number; maxPerChain: number; minimumSections: number; additionalInjectionPoints: number }>;
  issues: string[];
}

const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

/** Conditional arithmetic only; a power estimate is never an electrical approval. */
export function estimateElectrical(distribution: LedDistributionResult, flow: ConnectivityResult | null, specs: ElectricalSpecifications): ElectricalEstimate {
  if (!Number.isFinite(specs.reservePercent) || specs.reservePercent < 0 || specs.reservePercent >= 100) {
    throw new Error('La reserva de la fuente debe estar entre 0% y menos de 100%.');
  }
  const issues: string[] = [];
  const voltage = positive(specs.moduleVoltageV) ? specs.moduleVoltageV : null;
  const enteredPower = positive(specs.modulePowerW) ? specs.modulePowerW : null;
  const enteredCurrent = positive(specs.moduleCurrentA) ? specs.moduleCurrentA : null;
  if (!voltage) issues.push('Falta el voltaje nominal del módulo.');
  if (!enteredPower && !enteredCurrent) issues.push('Falta la potencia o corriente por módulo.');
  const powerFromCurrent = voltage && enteredCurrent ? voltage * enteredCurrent : null;
  const contradictory = enteredPower && powerFromCurrent && Math.abs(enteredPower - powerFromCurrent) / Math.max(enteredPower, powerFromCurrent) > 0.05;
  if (contradictory) issues.push('Potencia y corriente del módulo no coinciden con su voltaje.');
  const modulePowerW = contradictory ? null : enteredPower ?? powerFromCurrent;
  const moduleCurrentA = contradictory ? null : enteredCurrent ?? (modulePowerW && voltage ? modulePowerW / voltage : null);
  const totalPowerW = modulePowerW === null ? null : distribution.total * modulePowerW;
  const totalCurrentA = moduleCurrentA === null ? null : distribution.total * moduleCurrentA;
  const byFigure = distribution.byFigure.map(figure => ({
    figureId: figure.figureId, name: figure.name, modules: figure.placed,
    powerW: modulePowerW === null ? null : figure.placed * modulePowerW,
    currentA: moduleCurrentA === null ? null : figure.placed * moduleCurrentA,
  }));
  if (!specs.supplies.length) issues.push('Agrega al menos una fuente con voltaje y capacidad.');
  const supplies = specs.supplies.map(supply => {
    const supplyVoltage = positive(supply.voltageV) ? supply.voltageV : null;
    const watts = positive(supply.capacityW) ? supply.capacityW : null;
    const amps = positive(supply.capacityA) ? supply.capacityA : null;
    const ratedW = watts ?? (supplyVoltage && amps ? supplyVoltage * amps : null);
    const voltageMatches = voltage && supplyVoltage ? Math.abs(voltage - supplyVoltage) < 1e-6 : null;
    if (!supplyVoltage || !ratedW) issues.push(`Fuente ${supply.id}: faltan voltaje o capacidad.`);
    if (voltageMatches === false) issues.push(`Fuente ${supply.id}: el voltaje no coincide con el módulo.`);
    const contradictorySupply = !!(watts && amps && supplyVoltage && Math.abs(watts - supplyVoltage * amps) / Math.max(watts, supplyVoltage * amps) > 0.05);
    if (contradictorySupply) {
      issues.push(`Fuente ${supply.id}: potencia y corriente nominales no coinciden.`);
    }
    return { id: supply.id, voltageV: supplyVoltage, ratedW: contradictorySupply ? null : ratedW, usableW: contradictorySupply || ratedW === null ? null : ratedW * (1 - specs.reservePercent / 100), voltageMatches };
  });
  const readySupplies = supplies.every(supply => supply.usableW !== null && supply.voltageMatches === true);
  const availablePowerW = readySupplies && supplies.length ? supplies.reduce((sum, supply) => sum + supply.usableW!, 0) : null;
  let estimatedSources: number | null = null;
  let additionalSourcesOfSameModel: number | null = null;
  let deficitW: number | null = null;
  if (totalPowerW !== null && availablePowerW !== null) {
    deficitW = Math.max(0, totalPowerW - availablePowerW);
    if (deficitW > 1e-6) issues.push(`Las fuentes ingresadas tienen un déficit de ${Number(deficitW.toFixed(2))} W con la reserva aplicada.`);
    let cumulative = 0;
    if (totalPowerW === 0) estimatedSources = 0;
    for (const [index, capacity] of supplies.map(supply => supply.usableW!).sort((a, b) => b - a).entries()) {
      cumulative += capacity;
      if (cumulative >= totalPowerW - 1e-6) { estimatedSources = index + 1; break; }
    }
    // Count supplied units largest first; if insufficient, do not invent an additional source model.
    if (supplies.length === 1 && supplies[0].usableW! > 0) {
      const allOfSameModel = Math.ceil(totalPowerW / supplies[0].usableW!);
      additionalSourcesOfSameModel = Math.max(0, allOfSameModel - 1);
      if (estimatedSources === null) estimatedSources = allOfSameModel;
    }
  }
  const maxPerChain = specs.maxModulesPerChain !== null && Number.isInteger(specs.maxModulesPerChain) && specs.maxModulesPerChain > 0 ? specs.maxModulesPerChain : null;
  if (maxPerChain === null) issues.push('Falta el máximo de módulos por cadena del fabricante.');
  if (!flow) issues.push('Falta calcular un flujo de conexión.');
  const chainSplits = flow && maxPerChain ? flow.chains.filter(chain => chain.moduleIds.length > maxPerChain).map(chain => {
    const minimumSections = Math.ceil(chain.moduleIds.length / maxPerChain);
    issues.push(`${chain.id}: supera el límite del fabricante; requiere dividir la cadena o añadir alimentación.`);
    return { chainId: chain.id, modules: chain.moduleIds.length, maxPerChain, minimumSections, additionalInjectionPoints: minimumSections - 1 };
  }) : [];
  if (flow?.discardedIds.length) issues.push(`${flow.discardedIds.length} módulo(s) distribuidos siguen fuera del flujo propuesto.`);
  issues.push('La capacidad total no asigna fuentes a cadenas ni verifica cada punto de alimentación.');
  issues.push('Pendiente: polaridad, tipo de driver, calibre, caída de tensión y ficha técnica del fabricante.');
  return {
    validated: false, modulePowerW, moduleCurrentA, totalPowerW, totalCurrentA, byFigure, supplies,
    availablePowerW, estimatedSources, additionalSourcesOfSameModel, deficitW, chainSplits, issues,
  };
}
