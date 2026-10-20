import type { DivisionResult } from './divisions';
import type { LedDistributionResult, LedPlacement } from './distribution';
import type { ModuleMeasurements } from './module';
import type { Point, SvgModel } from './types';
import { createSerpentCableRouter } from './connectivity';
import type { ConnectionLink, TerminalSide } from './connectivity';
import { buildRegions } from './regions';

export interface SerpentOptions { scopeId: string; startId?: string | null; endId?: string | null; startSide?: TerminalSide | null; endSide?: TerminalSide | null; avoidModuleCollisions?: boolean; allowBridges?: boolean }
export interface SerpentStep { moduleId: string; order: number; entrySide: TerminalSide; exitSide: TerminalSide; entry: Point; exit: Point }
export interface SerpentResult {
  scopeId: string;
  steps: SerpentStep[];
  links: ConnectionLink[];
  breaks: Array<{ fromId: string; toId: string; from: Point; to: Point; reason: string }>;
  startId: string | null;
  endId: string | null;
  entry: Point | null;
  exit: Point | null;
  extraCableMm: number;
  continuous: boolean;
  warnings: string[];
}

export const serpentScope = (module: LedPlacement) => module.regionId ?? module.figureId;
const opposite = (side: TerminalSide): TerminalSide => side === 'left' ? 'right' : 'left';
const terminal = (module: LedPlacement, side: TerminalSide): Point => {
  const [a, b] = side === 'left' ? [module.corners[0], module.corners[3]] : [module.corners[1], module.corners[2]];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

/** Visit every placed LED once, keeping row segments together. Selected
 * endpoints are fixed; each internal LED uses two different terminals. */
export function planSerpent(model: SvgModel, divisions: DivisionResult, distribution: LedDistributionResult,
  measurements: ModuleMeasurements, widthMm: number, heightMm: number, options: SerpentOptions): SerpentResult {
  const modules = distribution.modules.filter(module => serpentScope(module) === options.scopeId);
  const empty: SerpentResult = { scopeId: options.scopeId, steps: [], links: [], breaks: [], startId: null, endId: null, entry: null, exit: null, extraCableMm: 0, continuous: false, warnings: [] };
  if (!modules.length) return empty;
  const scale = { x: widthMm / model.viewBox.width, y: heightMm / model.viewBox.height };
  const gap = (a: LedPlacement, b: LedPlacement) => Math.hypot((a.center.x - b.center.x) * scale.x, (a.center.y - b.center.y) * scale.y);
  const groups = new Map<string, LedPlacement[]>();
  for (const module of modules) { const row = module.rowRunId ?? module.divisionId; groups.set(row, [...(groups.get(row) ?? []), module]); }
  for (const group of groups.values()) group.sort((a, b) => (a.positionMm ?? a.number) - (b.positionMm ?? b.number));
  const pathOrigins = new Map((divisions.paths ?? []).map(path => [path.id, (path as typeof path & { origin?: string }).origin]));
  const phaseFor = (module: LedPlacement): 0 | 1 => pathOrigins.get(module.divisionId) === 'partition' ? 0 : 1;
  const partitionGroups = [...groups.values()].filter(group => phaseFor(group[0]) === 0);
  // Start on a partida when the user has not pinned a start so its rows are
  // completed before the planner enters the skeleton phase.
  const longest = [...(partitionGroups.length ? partitionGroups : groups.values())]
    .sort((a, b) => b.length - a.length || a[0].number - b[0].number)[0];
  const start = modules.find(module => module.id === options.startId) ?? longest.find(module => module.id !== options.endId) ?? longest[0];
  const end = modules.find(module => module.id === options.endId && module.id !== start.id) ?? null;
  const regions = (divisions.regions ?? buildRegions(model.figures).regions).filter(region => region.id === options.scopeId || (!modules[0].regionId && region.figureId === modules[0].figureId));
  const router = createSerpentCableRouter(regions, divisions.paths.filter(path => !path.regionId || regions.some(region => region.id === path.regionId)), modules, measurements, scale, options.avoidModuleCollisions ?? true, options.allowBridges ?? false);
  const sides: TerminalSide[] = ['left', 'right'];
  // Missing links dominate length. Evaluate terminal orientations together so
  // a nearby row does not consume the terminal needed by the following row.
  const connectionCost = (a: LedPlacement, b: LedPlacement, link: ConnectionLink | null) => link ? link.lengthMm + link.bridgeLengthMm * 4 : 1e7 + gap(a, b);
  const evaluate = (ordered: LedPlacement[]) => {
    const fixedStartSide = options.startId === ordered[0].id ? options.startSide : null;
    const fixedEndSide = options.endId === ordered.at(-1)!.id ? options.endSide : null;
    const scores = ordered.map(() => [Infinity, Infinity]);
    const previous = ordered.map(() => [-1, -1]);
    const chosenLinks: Array<Array<ConnectionLink | null>> = ordered.map(() => [null, null]);
    scores[0] = sides.map(side => !fixedStartSide || side === fixedStartSide ? 0 : Infinity);
    for (let i = 1; i < ordered.length; i++) for (let entry = 0; entry < 2; entry++) for (let preceding = 0; preceding < 2; preceding++) {
      const link = router(ordered[i - 1], opposite(sides[preceding]), ordered[i], sides[entry]);
      const score = scores[i - 1][preceding] + connectionCost(ordered[i - 1], ordered[i], link);
      if (score < scores[i][entry]) { scores[i][entry] = score; previous[i][entry] = preceding; chosenLinks[i][entry] = link; }
    }
    const side = fixedEndSide ? sides.indexOf(opposite(fixedEndSide)) : scores.at(-1)![0] <= scores.at(-1)![1] ? 0 : 1;
    return { cost: scores.at(-1)![side], side, previous, chosenLinks };
  };
  // Removing the two anchors splits a row only where the user picked an
  // interior LED. Each remaining segment retains its actual guide order.
  const pending: Array<{ modules: LedPlacement[]; phase: 0 | 1 }> = [];
  for (const group of groups.values()) {
    let run: LedPlacement[] = [];
    for (const module of group) {
      if (module.id === start.id || module.id === end?.id) { if (run.length) pending.push({ modules: run, phase: phaseFor(run[0]) }); run = []; }
      else run.push(module);
    }
    if (run.length) pending.push({ modules: run, phase: phaseFor(run[0]) });
  }
  const blocks: LedPlacement[][] = [[start]];
  const blockPhases: Array<0 | 1> = [phaseFor(start)];
  let currentPhase = phaseFor(start);
  while (pending.length) {
    const current = blocks.at(-1)!.at(-1)!;
    const eligible = pending.filter(run => run.phase >= currentPhase);
    const candidates = eligible.length ? eligible : pending;
    const phase = Math.min(...candidates.map(run => run.phase)) as 0 | 1;
    let bestIndex = -1, reverse = false, bestCost = Infinity;
    pending.forEach((item, index) => {
      if (item.phase !== phase) return;
      const run = item.modules;
      for (const backwards of [false, true]) {
        const first = backwards ? run.at(-1)! : run[0];
        const cost = Math.min(...sides.flatMap(from => sides.map(to => connectionCost(current, first, router(current, from, first, to))))) + (current.divisionId === first.divisionId ? 0 : measurements.lengthMm);
        if (cost < bestCost) { bestCost = cost; bestIndex = index; reverse = backwards; }
      }
    });
    const run = pending.splice(bestIndex, 1)[0].modules;
    blocks.push(reverse ? [...run].reverse() : run);
    blockPhases.push(phase);
    currentPhase = phase;
  }
  if (end) { blocks.push([end]); blockPhases.push(phaseFor(end)); }
  let bestCost = evaluate(blocks.flat()).cost;
  // Reverse whole row blocks, never scramble their LEDs into cross-lane zigzags.
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    const stop = blocks.length - (end ? 1 : 0);
    for (let i = 1; i < stop; i++) for (let j = i; j < stop; j++) {
      // Keep the partition rows together; only optimize row order within a
      // phase so partition-to-skeleton links cannot be interleaved.
      if (blockPhases.slice(i, j + 1).some(phase => phase !== blockPhases[i])) continue;
      const proposed = [...blocks.slice(0, i), ...blocks.slice(i, j + 1).reverse().map(run => [...run].reverse()), ...blocks.slice(j + 1)];
      const cost = evaluate(proposed.flat()).cost;
      if (cost + 1e-6 < bestCost) {
        const proposedPhases = [...blockPhases.slice(0, i), ...blockPhases.slice(i, j + 1).reverse(), ...blockPhases.slice(j + 1)];
        blocks.splice(0, blocks.length, ...proposed);
        blockPhases.splice(0, blockPhases.length, ...proposedPhases);
        bestCost = cost; improved = true;
      }
    }
    if (!improved) break;
  }
  let ordered = blocks.flat();
  // Several narrow border fragments can each hold just one body. A fixed
  // greedy start may then strand a fragment at the far end of the piece.
  // Solve these small sets exactly, including terminal orientation and free
  // endpoints. Larger rows retain their guide order and the bounded heuristic.
  if (options.allowBridges && modules.length > 2 && modules.length <= 10 &&
    !partitionGroups.length && [...groups.values()].every(group => group.length === 1)) {
    const count = modules.length, full = (1 << count) - 1;
    const scores = new Float64Array((full + 1) * count * 2).fill(Infinity);
    const preceding = new Int32Array(scores.length).fill(-1);
    const index = (mask: number, last: number, side: number) => (mask * count + last) * 2 + side;
    const fixedStart = options.startId === start.id ? start : null;
    const transitions = modules.map(a => sides.map(entry => modules.map(b => sides.map(next => a === b ? Infinity :
      connectionCost(a, b, router(a, opposite(entry), b, next))))));
    modules.forEach((module, i) => {
      if ((fixedStart && module !== fixedStart) || module === end) return;
      sides.forEach((side, entry) => {
        if (!fixedStart || !options.startSide || side === options.startSide) scores[index(1 << i, i, entry)] = 0;
      });
    });
    for (let mask = 1; mask <= full; mask++) for (let last = 0; last < count; last++) {
      if (!(mask & (1 << last))) continue;
      for (let entry = 0; entry < 2; entry++) {
        const current = index(mask, last, entry), cost = scores[current];
        if (!Number.isFinite(cost)) continue;
        for (let next = 0; next < count; next++) {
          if (mask & (1 << next)) continue;
          const nextMask = mask | (1 << next);
          if (modules[next] === end && nextMask !== full) continue;
          for (let side = 0; side < 2; side++) {
            const at = index(nextMask, next, side), proposed = cost + transitions[last][entry][next][side];
            if (proposed < scores[at]) { scores[at] = proposed; preceding[at] = current; }
          }
        }
      }
    }
    let lastState = -1, exactCost = bestCost;
    modules.forEach((module, last) => {
      if (end && module !== end) return;
      sides.forEach((entry, side) => {
        if (end && options.endSide && opposite(entry) !== options.endSide) return;
        const at = index(full, last, side);
        if (scores[at] + 1e-6 < exactCost) { exactCost = scores[at]; lastState = at; }
      });
    });
    if (lastState >= 0) {
      const exact: LedPlacement[] = [];
      for (let at = lastState; at >= 0; at = preceding[at]) exact.unshift(modules[Math.floor(at / 2) % count]);
      ordered = exact;
    }
  }
  const fixedStartSide = options.startId === ordered[0].id ? options.startSide : null;
  const fixedEndSide = options.endId === ordered.at(-1)!.id ? options.endSide : null;
  if (ordered.length === 1 && fixedStartSide && fixedEndSide === fixedStartSide) throw new Error('Inicio y salida deben usar extremos opuestos del LED.');
  const evaluation = evaluate(ordered), { previous, chosenLinks } = evaluation;
  let side = evaluation.side;
  const entries = new Array<number>(ordered.length), links: ConnectionLink[] = [], missing: SerpentResult['breaks'] = [];
  for (let i = ordered.length - 1; i >= 0; i--) {
    entries[i] = side;
    if (i > 0) {
      const link = chosenLinks[i][side];
      if (link) links.unshift({ ...link, id: `serpent-link-${options.scopeId}-${i}` });
      else missing.unshift({ fromId: ordered[i - 1].id, toId: ordered[i].id, from: terminal(ordered[i - 1], opposite(sides[previous[i][side]])), to: terminal(ordered[i], sides[side]), reason: options.allowBridges ? 'Pendiente: no se encontró una ruta libre dentro de la figura.' : `Pendiente: no se encontró una ruta libre dentro del alcance de los pigtails (máximo ${measurements.leftPigtailMm + measurements.rightPigtailMm} mm).` });
      side = previous[i][side];
    }
  }
  const steps = ordered.map((module, i): SerpentStep => ({ moduleId: module.id, order: i + 1, entrySide: sides[entries[i]], exitSide: opposite(sides[entries[i]]), entry: terminal(module, sides[entries[i]]), exit: terminal(module, opposite(sides[entries[i]])) }));
  const warnings: string[] = [];
  if (options.startId && !modules.some(module => module.id === options.startId)) warnings.push('El inicio anterior ya no existe en esta distribución; selecciona otro LED.');
  if (options.endId && !modules.some(module => module.id === options.endId)) warnings.push('La salida anterior ya no existe en esta distribución; selecciona otro LED.');
  else if (options.endId && !end && modules.length > 1) warnings.push('Selecciona una salida distinta del inicio y dentro de la misma figura.');
  const extraCableMm = links.reduce((sum, link) => sum + link.bridgeLengthMm, 0);
  if (extraCableMm > 1e-6) warnings.push(`El recorrido requiere ${extraCableMm.toFixed(1)} mm de cable adicional; los puentes no son conexiones directas de pigtails.`);
  if (missing.length) warnings.push(`${missing.length} salto(s) pendientes: no se encontró una ruta libre${options.allowBridges ? '' : ' dentro del límite de los pigtails'}; el recorrido no es continuo.`);
  return { scopeId: options.scopeId, steps, links, breaks: missing, startId: ordered[0].id, endId: ordered.at(-1)!.id,
    entry: steps[0].entry, exit: steps.at(-1)!.exit, extraCableMm, continuous: missing.length === 0, warnings };
}
