import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('a coverage position plan cannot bypass body fit, holes or pigtail spacing', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts', distributionPath = '/src/engine/distribution.ts';
    const { parseSvg } = await import(enginePath);
    const { distributeLeds } = await import(distributionPath);
    const measurements = { lengthMm: 70, widthMm: 15, leftPigtailMm: 30, rightPigtailMm: 30 };
    const attempt = (positions: number[], hole = false) => {
      const model = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><path fill-rule="evenodd" d="M0 0H300V100H0Z${hole ? ' M100 30H200V70H100Z' : ''}"/></svg>`);
      const contours = model.figures[0].contours;
      const path = { id: 'row', figureId: model.figures[0].id, outerContourId: contours[0].id,
        innerContourId: hole ? contours[1].id : '', index: 0, fraction: 0.5, bodyFiltered: true, d: 'M10 50 L290 50' };
      try {
        return distributeLeds(model, { paths: [path], pairs: 0, warnings: [] }, measurements, 300, 100,
          { maximumGapMm: 60, positionsByGuideMm: { row: positions } }).total;
      } catch { return 'rejected'; }
    };
    return { valid: attempt([35, 155]), empty: attempt([]), spacing: attempt([35, 80]),
      boundary: attempt([0]), hole: attempt([140], true) };
  });
  expect(result).toEqual({ valid: 2, empty: 0, spacing: 'rejected', boundary: 'rejected', hole: 'rejected' });
});

for (const variant of [
  { name: 'cropped SVG bounds', viewBox: '11977 3119', jCount: 6 },
  { name: 'EPS physical page bounds', viewBox: '11990.551181102363 3146.456692913386', jCount: 5 },
]) test(`Mercado tips and stems gain LEDs with ${variant.name}, preserving bodies, holes, spacing and rows`, async ({ page }) => {
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/mercado-coverage.svg', import.meta.url), 'utf8')
    .replace('11977 3119', variant.viewBox);
  const result = await page.evaluate(async source => {
    const enginePath = '/src/engine/index.ts', distributionPath = '/src/engine/distribution.ts';
    const { parseSvg } = await import(enginePath);
    const { distributeLeds, insideRegion, rectangleGap, makeRectangle, pathPolyline } = await import(distributionPath);
    const model: import('../src/engine/types').SvgModel = parseSvg(source);
    const measurements = { lengthMm: 70, widthMm: 15, leftPigtailMm: 30, rightPigtailMm: 30 };
    const options = { minimumGapMm: 50, maximumGapMm: 60 };
    const layout = await new Promise<import('../src/engine/layout.worker').LayoutResult>((resolve, reject) => {
      const worker = new Worker('/src/engine/layout.worker.ts', { type: 'module' });
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
      worker.onmessage = event => {
        worker.terminate();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      worker.postMessage({ model, physicalSize: { widthMm: 4230, heightMm: 1110 },
        placement: { config: { minimumSectionWidthMm: 100 }, measurements, options } });
    });
    const guides = layout.serpentGuides!, distribution = layout.distribution!, scale = layout.skeleton.scale;
    const original: import('../src/engine/distribution').LedDistributionResult = distributeLeds(model, { ...guides, paths: guides.paths.filter(path => !path.id.startsWith('coverage-refit-')) },
      measurements, 4230, 1110, options);
    const physical = (p: { x: number; y: number }) => ({ x: p.x * scale.x, y: p.y * scale.y });
    const bodies = distribution.modules.map(module => {
      const guide = guides.paths.find(path => path.id === module.divisionId)!;
      return makeRectangle(pathPolyline(guide, scale), module.positionMm, 70, 15);
    });
    let minimumGap = Infinity;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      minimumGap = Math.min(minimumGap, rectangleGap(bodies[i], bodies[j]));
    }
    const contained = distribution.modules.every((module, i) => {
      const region = layout.skeleton.regions.find(region => region.id === module.regionId)!;
      return insideRegion(bodies[i], { outer: region.outer.map(physical), inner: null,
        holes: region.holes.map(hole => hole.map(physical)) }, 0.2);
    });
    return { contained, minimumGap,
      allRouted: distribution.modules.every(module => distribution.routeRuns?.some(run =>
        run.id === module.rowRunId && run.moduleIds.includes(module.id))),
      figures: model.figures.map(figure => ({ name: figure.sourceId!,
        baseline: original.modules.filter(module => module.figureId === figure.id).length,
        modules: distribution.modules.filter(module => module.figureId === figure.id).map(module => ({
          x: (module.center.x - figure.bounds.x) / figure.bounds.width,
          y: (module.center.y - figure.bounds.y) / figure.bounds.height,
        })) })) };
  }, source);
  expect(result.contained).toBe(true);
  expect(result.minimumGap).toBeGreaterThanOrEqual(50 - 1e-5);
  expect(result.allRouted).toBe(true);
  for (const figure of result.figures) expect(figure.modules.length).toBeGreaterThan(figure.baseline);
  const byName = Object.fromEntries(result.figures.map(figure => [figure.name, figure.modules]));
  expect(byName['mercado-m']).toHaveLength(9);
  expect(byName['mercado-a']).toHaveLength(9);
  expect(byName['mercado-j']).toHaveLength(variant.jCount);
  expect(byName['mercado-u']).toHaveLength(7);
  for (const name of ['mercado-m', 'mercado-u']) {
    expect(byName[name].some(body => body.x < 0.2 && body.y < 0.2)).toBe(true);
    expect(byName[name].some(body => body.x > 0.8 && body.y < 0.2)).toBe(true);
  }
  expect(byName['mercado-a'].some(body => body.x > 0.8 && body.y > 0.3 && body.y < 0.7)).toBe(true);
  expect(byName['mercado-j'].some(body => body.y < 0.1)).toBe(true);
});
