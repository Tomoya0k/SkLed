import { expect, test } from '@playwright/test';
import { selectPrincipalRoutes } from '../src/engine/principal';
import { createPigtailChecker } from '../src/engine/connectivity';
import type { LedPlacement } from '../src/engine/distribution';
import type { PartitionResult } from '../src/engine/partitions';
import type { SkeletonResult } from '../src/engine/skeleton';
import type { SvgModel } from '../src/engine/types';

function fixtures(height: number, laneY: [number, number]) {
  const figureId = 'figure-1', regionId = 'region-1';
  const model = { viewBox: { x: 0, y: 0, width: 300, height }, figures: [{ id: figureId, name: 'barra' }] } as SvgModel;
  const region = { id: regionId, figureId, outerContourId: 'outer', holeContourIds: [],
    outer: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: height }, { x: 0, y: height }], holes: [] };
  const mid = height / 2;
  const edge = { id: 'edge-1', figureId, regionId, from: null, to: null, closed: false,
    points: [{ x: 20, y: mid }, { x: 280, y: mid }], d: `M 20 ${mid} L 280 ${mid}` };
  const skeleton: SkeletonResult = { nodes: [], edges: [edge], regions: [region], scale: { x: 1, y: 1 }, units: 'mm', resolution: 1, warnings: [] };
  const paths = laneY.map((y, index) => ({ id: `part-${index}`, figureId, regionId, outerContourId: 'outer', innerContourId: '',
    sourceEdgeId: edge.id, sourceRange: [0, 260] as [number, number], lane: (index ? 1 : -1) as -1 | 1,
    closed: false, points: [{ x: 20, y }, { x: 280, y }], d: `M 20 ${y} L 280 ${y}`, index, fraction: index / 2 }));
  const partitions: PartitionResult = { paths, regions: [region], pairs: 1, warnings: [] };
  return { model, skeleton, partitions };
}

const config = { moduleLengthMm: 40, moduleWidthMm: 10, freeGapMm: 6, edgeMarginMm: 6, criticalGapMm: 30,
  leftPigtailMm: 30, rightPigtailMm: 30 };

test('principal keeps the central skeleton when it is physical despite more modules fitting on two partidas', () => {
  const { model, skeleton, partitions } = fixtures(100, [30, 70]);
  const result = selectPrincipalRoutes(model, skeleton, partitions, config, 300, 100);
  expect(result.figures[0].selected?.origin).toBe('skeleton');
  expect(result.figures[0].selected?.valid).toBe(4);
  expect(result.figures[0].selected?.minimumGapMm).toBeGreaterThanOrEqual(30);
  expect(result.figures[0].selected?.linkModules).toBe(0);
  expect(result.figures[0].selected?.links).toHaveLength(3);
  expect(result.total).toBe(4);
});

test('rejects touching paired lanes when the central skeleton cannot fit', () => {
  const { model, skeleton, partitions } = fixtures(60, [25, 35]);
  skeleton.edges[0].points = [{ x: 20, y: 9 }, { x: 280, y: 9 }];
  skeleton.edges[0].d = 'M 20 9 L 280 9';
  const result = selectPrincipalRoutes(model, skeleton, partitions, config, 300, 60);
  const combined = result.figures[0].candidates.find(candidate => candidate.id.endsWith('-partidas'))!;
  expect(combined.eligible).toBe(false);
  expect(combined.contacts).toBeGreaterThan(0);
  expect(result.figures[0].selected?.origin).toBe('partida');
  expect(result.figures[0].selected?.valid).toBe(4);
});

test('critical body clearance and edge margin reject a route without affecting skeleton', () => {
  const { model, skeleton, partitions } = fixtures(100, [38, 62]);
  skeleton.edges[0].points = [{ x: 20, y: 9 }, { x: 280, y: 9 }];
  skeleton.edges[0].d = 'M 20 9 L 280 9';
  const result = selectPrincipalRoutes(model, skeleton, partitions, config, 300, 100);
  const combined = result.figures[0].candidates.find(candidate => candidate.id.endsWith('-partidas'))!;
  expect(combined.contacts).toBe(0);
  expect(combined.criticalCount).toBe(combined.modules.length);
  expect(combined.reason).toBe('Mayoría con cercanía crítica');
  expect(result.figures[0].selected?.origin).toBe('partida');

  const boundary = fixtures(100, [9, 70]);
  boundary.skeleton.edges[0].points = [{ x: 20, y: 9 }, { x: 280, y: 9 }];
  boundary.skeleton.edges[0].d = 'M 20 9 L 280 9';
  const edge = selectPrincipalRoutes(boundary.model, boundary.skeleton, boundary.partitions, config, 300, 100);
  const nearEdge = edge.figures[0].candidates.find(candidate => candidate.id === 'part-0-solo')!;
  expect(nearEdge.borderConflicts).toBeGreaterThan(0);
  expect(nearEdge.eligible).toBe(false);
});

test('uses partidas only when the central skeleton cannot keep the module inside its margin', () => {
  const { model, skeleton, partitions } = fixtures(100, [30, 70]);
  skeleton.edges[0].points = [{ x: 20, y: 9 }, { x: 280, y: 9 }];
  skeleton.edges[0].d = 'M 20 9 L 280 9';
  const result = selectPrincipalRoutes(model, skeleton, partitions, config, 300, 100);
  expect(result.figures[0].candidates.find(candidate => candidate.origin === 'skeleton')?.borderConflicts).toBeGreaterThan(0);
  expect(result.figures[0].selected?.origin).toBe('partida');
});

test('reports unresolved pigtails instead of calling the route valid', () => {
  const { model, skeleton, partitions } = fixtures(100, [30, 70]);
  const result = selectPrincipalRoutes(model, skeleton, partitions, { ...config, leftPigtailMm: 5, rightPigtailMm: 5 }, 300, 100);
  expect(result.figures[0].selected).toBeNull();
  expect(result.figures[0].diagnostic?.origin).toBe('skeleton');
  expect(result.figures[0].diagnostic?.pendingConflicts.length).toBeGreaterThan(0);
  expect(result.figures[0].diagnostic?.reason).toBe('Conexiones pigtail pendientes');
});

test('a bend keeps two modules when their pigtails suffice and reports an impossible link', () => {
  const figureId = 'figure-1', regionId = 'region-1';
  const model = { viewBox: { x: 0, y: 0, width: 200, height: 200 }, figures: [{ id: figureId, name: 'curva' }] } as SvgModel;
  const region = { id: regionId, figureId, outerContourId: 'outer', holeContourIds: [],
    outer: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], holes: [] };
  const points = [{ x: 50, y: 100 }, { x: 115, y: 100 }, { x: 115, y: 165 }];
  const skeleton: SkeletonResult = { nodes: [], edges: [{ id: 'bend', figureId, regionId, from: null, to: null, points,
    closed: false, d: 'M 50 100 L 115 100 L 115 165' }], regions: [region], scale: { x: 1, y: 1 }, units: 'mm', resolution: 1, warnings: [] };
  const partitions: PartitionResult = { paths: [], regions: [region], pairs: 0, warnings: [] };
  const close = selectPrincipalRoutes(model, skeleton, partitions, { ...config, criticalGapMm: 6,
    leftPigtailMm: 24, rightPigtailMm: 24 }, 200, 200);
  expect(close.figures[0].selected?.links).toHaveLength(1);
  expect(close.figures[0].selected?.modules).toHaveLength(2);
  expect(close.figures[0].selected?.linkModules).toBe(0);
  const impossible = selectPrincipalRoutes(model, skeleton, partitions, { ...config, criticalGapMm: 6,
    leftPigtailMm: 8, rightPigtailMm: 8 }, 200, 200);
  expect(impossible.figures[0].selected).toBeNull();
  expect(impossible.figures[0].diagnostic?.pendingConflicts).toHaveLength(1);
});

test('adds one physical link module on a bend only when A→C→B resolves both cable gaps', () => {
  const figureId = 'figure-1', regionId = 'region-1';
  const model = { viewBox: { x: 0, y: 0, width: 220, height: 180 }, figures: [{ id: figureId, name: 'arco' }] } as SvgModel;
  const region = { id: regionId, figureId, outerContourId: 'outer', holeContourIds: [],
    outer: [{ x: 0, y: 0 }, { x: 220, y: 0 }, { x: 220, y: 180 }, { x: 0, y: 180 }], holes: [] };
  const points = [{ x: 20, y: 100 }, { x: 107.5, y: 80 }, { x: 195, y: 100 }];
  const skeleton: SkeletonResult = { nodes: [], edges: [{ id: 'curve', figureId, regionId, from: null, to: null, points,
    closed: false, d: 'M 20 100 L 107.5 80 L 195 100' }], regions: [region], scale: { x: 1, y: 1 }, units: 'mm', resolution: 1, warnings: [] };
  const partitions: PartitionResult = { paths: [], regions: [region], pairs: 0, warnings: [] };
  const result = selectPrincipalRoutes(model, skeleton, partitions, config, 220, 180);
  const route = result.figures[0].selected!;
  expect(route.linkModules).toBe(1);
  expect(route.modules).toHaveLength(3);
  expect(route.modules.find(module => module.kind === 'enlace')?.nearestGapMm).toBeGreaterThan(30);
  expect(route.links).toHaveLength(2);
  expect(route.links.every(link => link.lengthMm <= config.leftPigtailMm + config.rightPigtailMm)).toBe(true);
  expect(route.links[0].toSide).not.toBe(route.links[1].fromSide);
  expect(route.pendingConflicts).toHaveLength(0);
  const longPigtails = selectPrincipalRoutes(model, skeleton, partitions,
    { ...config, leftPigtailMm: 60, rightPigtailMm: 60 }, 220, 180);
  expect(longPigtails.figures[0].selected?.linkModules).toBe(0);
  expect(longPigtails.figures[0].selected?.modules).toHaveLength(2);
  expect(longPigtails.figures[0].selected?.links).toHaveLength(1);
});

test('checks A→C and C→B with separate terminals and actual cable lengths', () => {
  const region = { id: 'r', figureId: 'f', outerContourId: 'outer', holeContourIds: [],
    outer: [{ x: 0, y: 0 }, { x: 260, y: 0 }, { x: 260, y: 100 }, { x: 0, y: 100 }], holes: [] };
  const path = { id: 'center', figureId: 'f', regionId: 'r', outerContourId: 'outer', innerContourId: '', index: 0,
    fraction: 0, d: 'M 20 50 L 230 50' };
  const module = (id: string, x: number): LedPlacement => ({ id, figureId: 'f', divisionId: path.id, number: x, figureNumber: x,
    center: { x, y: 50 }, corners: [{ x: x - 20, y: 45 }, { x: x + 20, y: 45 },
      { x: x + 20, y: 55 }, { x: x - 20, y: 55 }], directionStart: { x, y: 50 },
    directionEnd: { x, y: 50 }, arrow: [{ x, y: 50 }, { x, y: 50 }, { x, y: 50 }], labelPoint: { x, y: 50 } });
  const a = module('A', 50), c = module('C', 120), b = module('B', 190);
  const checker = createPigtailChecker([region], [path], [a, c, b],
    { lengthMm: 40, widthMm: 10, leftPigtailMm: 20, rightPigtailMm: 20 }, { x: 1, y: 1 });
  expect(checker(a, b, c.id)).toHaveLength(0);
  const ac = checker(a, c)[0], cb = checker(c, b)[0];
  expect(ac).toBeDefined(); expect(cb).toBeDefined();
  expect(ac.lengthMm).toBeCloseTo(30);
  expect(cb.lengthMm).toBeCloseTo(30);
  expect(ac.toSide).not.toBe(cb.fromSide);
});
