import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('Medical E, A and L retain body-fitting arms and close every paired end', async ({ page }) => {
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/medical-eal.svg', import.meta.url), 'utf8');
  const result = await page.evaluate(async source => {
    const enginePath = '/src/engine/index.ts', filterPath = '/src/engine/skeleton-filter.ts';
    const { parseSvg, generateSkeleton, generatePartitions, composeSerpentGuides, distributeLeds } = await import(enginePath);
    const { filterSkeletonSpurs } = await import(filterPath);
    const model = parseSvg(source);
    const skeleton = filterSkeletonSpurs(generateSkeleton(model, { widthMm: 21500, heightMm: 3000 }));
    const parts = generatePartitions(skeleton, { minimumSectionWidthMm: 100 });
    const fit = distributeLeds(model, parts, { lengthMm: 70, widthMm: 15, leftPigtailMm: 0, rightPigtailMm: 0 }, 21500, 3000,
      { minimumGapMm: 0, maximumGapMm: 0, independentPaths: true });
    const fittingIds = new Set(fit.modules.map((module: any) => module.divisionId));
    const fittingParts = { ...parts, paths: parts.paths.filter((path: any) => fittingIds.has(path.id)) };
    const output = composeSerpentGuides(skeleton, fittingParts);
    const lanes = output.paths.filter((path: any) => path.origin === 'partition');
    const distance = (a: any, b: any) => Math.hypot((a.x - b.x) * skeleton.scale.x, (a.y - b.y) * skeleton.scale.y);
    const openEnds = lanes.filter((path: any) => !path.closed && !lanes.some((other: any) => other.id !== path.id &&
      other.regionId === path.regionId && other.lane === -path.lane &&
      ((distance(path.points[0], other.points[0]) < 1e-5 && distance(path.points.at(-1), other.points.at(-1)) < 1e-5) ||
       (distance(path.points[0], other.points.at(-1)) < 1e-5 && distance(path.points.at(-1), other.points[0]) < 1e-5)))).map((p: any) => p.id);
    return { candidates: fittingParts.paths.length, retained: lanes.length, openEnds,
      figures: model.figures.map((figure: any) => ({ bounds: figure.bounds, contours: figure.contours.map((c: any) => c.d),
        guides: output.paths.filter((p: any) => p.figureId === figure.id).map((p: any) => p.d) })) };
  }, source);
  expect(result.candidates).toBe(22);
  expect(result.retained).toBe(result.candidates);
  expect(result.openEnds).toEqual([]);
  await page.setContent(`<style>body{margin:0;background:#08160f;color:#e5ffe9;font:18px sans-serif}main{display:grid;grid-template-columns:repeat(3,1fr)}h2{text-align:center}svg{width:100%;height:920px}path{fill:none;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}</style><main>${result.figures.map((f: any, i: number) => `<section><h2>${['E', 'A', 'L'][i]} · partidas cerradas</h2><svg viewBox="${f.bounds.x - 100} ${f.bounds.y - 100} ${f.bounds.width + 200} ${f.bounds.height + 200}">${f.contours.map((d: string) => `<path d="${d}" stroke="#59ff91" stroke-width="2"/>`).join('')}${f.guides.map((d: string) => `<path d="${d}" stroke="#ff83c6" stroke-width="2"/>`).join('')}</svg></section>`).join('')}</main>`);
  await page.screenshot({ path: 'test-results/medical-eal-closed.png' });
});

test('terminal pairs close without residual skeleton, and missing return lanes restore it', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/serpent-guides.ts';
    const { composeSerpentGuides } = await import(modulePath);
    const region = { id: 'region', figureId: 'figure', outerContourId: 'outer', holeContourIds: [], holes: [],
      outer: [{ x: -10, y: -100 }, { x: 1210, y: -100 }, { x: 1210, y: 100 }, { x: -10, y: 100 }] };
    const skeleton = { units: 'mm', scale: { x: 1, y: 1 }, resolution: 1, warnings: [], regions: [region],
      nodes: [{ id: 'start', kind: 'end', radius: 100 }, { id: 'end', kind: 'end', radius: 100 }],
      edges: [{ id: 'edge', regionId: 'region', figureId: 'figure', from: 'start', to: 'end', closed: false,
        points: [{ x: 0, y: 0 }, { x: 1200, y: 0 }] }] };
    const paths = [-1, 1].map(lane => ({ id: `lane${lane}`, regionId: 'region', figureId: 'figure', sourceEdgeId: 'edge',
      sourceRange: [0, 1200], sourceSpans: [{ edgeId: 'edge', from: 0, to: 1200 }], lane, closed: false,
      points: [{ x: 0, y: lane * 40 }, { x: 1200, y: lane * 40 }] }));
    const terminal = composeSerpentGuides(skeleton, { paths, regions: [region], pairs: 1, warnings: [] });
    const missing = composeSerpentGuides(skeleton, { paths: paths.slice(0, 1), regions: [region], pairs: 1, warnings: [] });
    return { terminalOrigins: terminal.paths.map((p: any) => p.origin),
      caps: [0, -1].map(index => terminal.paths.map((p: any) => p.points.at(index))),
      restored: missing.paths.map((p: any) => ({ origin: p.origin, range: p.sourceRange })) };
  });
  expect(result.terminalOrigins).toEqual(['partition', 'partition']);
  expect(result.caps).toEqual([[{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: 1200, y: 0 }, { x: 1200, y: 0 }]]);
  expect(result.restored).toEqual([{ origin: 'skeleton', range: [0, 1200] }]);
});
