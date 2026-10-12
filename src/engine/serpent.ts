import type { DivisionResult } from './divisions';
import type { LedDistributionResult, LedPlacement } from './distribution';
import type { ModuleMeasurements } from './module';
import type { Point, SvgModel } from './types';
import { createSerpentCableRouter } from './connectivity';
import type { ConnectionLink, TerminalSide } from './connectivity';
import { buildRegions } from './regions';

export interface SerpentOptions { scopeId: string; startId?: string | null; endId?: string | null; startSide?: TerminalSide | null; endSide?: TerminalSide | null }
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
  const longest = [...groups.values()].sort((a, b) => b.length - a.length || a[0].number - b[0].number)[0];
  const start = modules.find(module => module.id === options.startId) ?? longest.find(module => module.id !== options.endId) ?? longest[0];
  const end = modules.find(module => module.id === options.endId && module.id !== start.id) ?? null;
  const regions = (divisions.regions ?? buildRegions(model.figures).regions).filter(region => region.id === options.scopeId || (!modules[0].regionId && region.figureId === modules[0].figureId));
  const router = createSerpentCableRouter(regions, divisions.paths.filter(path => !path.regionId || regions.some(region => region.id === path.regionId)), modules, measurements, scale);
  const sides: TerminalSide[] = ['left', 'right'];
  // Missing links dominate length. Evaluate terminal orientations together so
  // a nearby row does not consume the terminal needed by the following row.
  const connectionCost = (a: LedPlacement, b: LedPlacement, link: ConnectionLink | null) => link ? link.lengthMm : 1e7 + gap(a, b);
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
  const pending: LedPlacement[][] = [];
  for (const group of groups.values()) {
    let run: LedPlacement[] = [];
    for (const module of group) {
      if (module.id === start.id || module.id === end?.id) { if (run.length) pending.push(run); run = []; }
      else run.push(module);
    }
    if (run.length) pending.push(run);
  }
  const blocks: LedPlacement[][] = [[start]];
  while (pending.length) {
    const current = blocks.at(-1)!.at(-1)!;
    let bestIndex = 0, reverse = false, bestCost = Infinity;
    pending.forEach((run, index) => {
      for (const backwards of [false, true]) {
        const first = backwards ? run.at(-1)! : run[0];
        const cost = Math.min(...sides.flatMap(from => sides.map(to => connectionCost(current, first, router(current, from, first, to))))) + (current.divisionId === first.divisionId ? 0 : measurements.lengthMm);
        if (cost < bestCost) { bestCost = cost; bestIndex = index; reverse = backwards; }
      }
    });
    const run = pending.splice(bestIndex, 1)[0];
    blocks.push(reverse ? [...run].reverse() : run);
  }
  if (end) blocks.push([end]);
  let bestCost = evaluate(blocks.flat()).cost;
  // Reverse whole row blocks, never scramble their LEDs into cross-lane zigzags.
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    const stop = blocks.length - (end ? 1 : 0);
    for (let i = 1; i < stop; i++) for (let j = i; j < stop; j++) {
      const proposed = [...blocks.slice(0, i), ...blocks.slice(i, j + 1).reverse().map(run => [...run].reverse()), ...blocks.slice(j + 1)];
      const cost = evaluate(proposed.flat()).cost;
      if (cost + 1e-6 < bestCost) { blocks.splice(0, blocks.length, ...proposed); bestCost = cost; improved = true; }
    }
    if (!improved) break;
  }
  const ordered = blocks.flat();
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
      if (link) links.unshift({ ...link, id: `serpent-link-${i}` });
      else missing.unshift({ fromId: ordered[i - 1].id, toId: ordered[i].id, from: terminal(ordered[i - 1], opposite(sides[previous[i][side]])), to: terminal(ordered[i], sides[side]), reason: `Pendiente: no se encontró una ruta libre dentro del alcance de los pigtails (máximo ${measurements.leftPigtailMm + measurements.rightPigtailMm} mm).` });
      side = previous[i][side];
    }
  }
  const steps = ordered.map((module, i): SerpentStep => ({ moduleId: module.id, order: i + 1, entrySide: sides[entries[i]], exitSide: opposite(sides[entries[i]]), entry: terminal(module, sides[entries[i]]), exit: terminal(module, opposite(sides[entries[i]])) }));
  const warnings: string[] = [];
  if (options.startId && !modules.some(module => module.id === options.startId)) warnings.push('El inicio anterior ya no existe en esta distribución; selecciona otro LED.');
  if (options.endId && !modules.some(module => module.id === options.endId)) warnings.push('La salida anterior ya no existe en esta distribución; selecciona otro LED.');
  else if (options.endId && !end && modules.length > 1) warnings.push('Selecciona una salida distinta del inicio y dentro de la misma figura.');
  if (missing.length) warnings.push(`${missing.length} salto(s) pendientes: no se encontró una ruta libre dentro del límite de los pigtails; el recorrido no es continuo.`);
  return { scopeId: options.scopeId, steps, links, breaks: missing, startId: ordered[0].id, endId: ordered.at(-1)!.id,
    entry: steps[0].entry, exit: steps.at(-1)!.exit, extraCableMm: 0, continuous: missing.length === 0, warnings };
}
