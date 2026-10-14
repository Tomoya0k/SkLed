import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function layout(page: Page, fixture: string, widthMm: number, heightMm: number) {
  await page.goto('/');
  const source = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');
  return page.evaluate(async input => {
    const enginePath = '/src/engine/index.ts', distributionPath = '/src/engine/distribution.ts';
    const { parseSvg } = await import(enginePath);
    const { insideRegion, rectangleGap, makeRectangle, pathPolyline } = await import(distributionPath);
    const model: import('../src/engine/types').SvgModel = parseSvg(input.source);
    const result = await new Promise<import('../src/engine/layout.worker').LayoutResult>((resolve, reject) => {
      const worker = new Worker('/src/engine/layout.worker.ts', { type: 'module' });
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
      worker.onmessage = event => {
        worker.terminate();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      worker.postMessage({ model, physicalSize: { widthMm: input.widthMm, heightMm: input.heightMm },
        placement: { config: { minimumSectionWidthMm: 100 },
          measurements: { lengthMm: 70, widthMm: 15, leftPigtailMm: 30, rightPigtailMm: 30 },
          options: { minimumGapMm: 50, maximumGapMm: 60 } } });
    });
    const paths = result.serpentGuides!.paths, modules = result.distribution!.modules, scale = result.skeleton.scale;
    const physical = (p: { x: number; y: number }) => ({ x: p.x * scale.x, y: p.y * scale.y });
    const bodies = modules.map(module => {
      const path = paths.find(path => path.id === module.divisionId)!;
      return makeRectangle(pathPolyline(path, scale), module.positionMm, 70, 15);
    });
    let minimumGap = Infinity;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      minimumGap = Math.min(minimumGap, rectangleGap(bodies[i], bodies[j]));
    }
    const contained = modules.every((module, i) => {
      const region = result.skeleton.regions.find(region => region.id === module.regionId)!;
      return insideRegion(bodies[i], { outer: region.outer.map(physical), inner: null,
        holes: region.holes.map(hole => hole.map(physical)) }, 0.2);
    });
    return { contained, minimumGap, paths: paths.map(path => ({ id: path.id, d: path.d,
      bridge: path.junctionBridge, corner: path.cornerBranch, points: path.points,
      modules: modules.filter(module => module.divisionId === path.id) })),
      contours: model.figures.flatMap(figure => figure.contours.map(contour => contour.d)) };
  }, { source, widthMm, heightMm });
}

test('Medical A bridge fits three LEDs before incident arms, with physical spacing intact', async ({ page }) => {
  const result = await layout(page, 'medical-eal.svg', 10600, 1480);
  const bridge = result.paths.find(path => path.points.every(p => p.y > 1600 && p.y < 1800) &&
    Math.max(...path.points.map(p => p.x)) - Math.min(...path.points.map(p => p.x)) > 1000)!;
  expect(bridge.modules).toHaveLength(3);
  expect(result.contained).toBe(true);
  expect(result.minimumGap).toBeGreaterThanOrEqual(50 - 1e-5);
  const centers = bridge.modules.map(module => module.center);
  expect(centers[1].x - centers[0].x).toBeCloseTo(centers[2].x - centers[1].x, 4);
  await page.setContent(`<style>body{margin:0;background:#08160f}svg{height:900px;width:100%}path{fill:none;stroke-width:2;vector-effect:non-scaling-stroke}</style><svg viewBox="10050 0 2520 2530">${result.contours.map(d => `<path d="${d}" stroke="#59ff91"/>`).join('')}${result.paths.map(path => `<path d="${path.d}" stroke="${path.id === bridge.id ? '#ffd064' : '#c59bf2'}"/>${path.modules.map(module => `<polygon points="${module.corners.map(p => `${p.x},${p.y}`).join(' ')}" fill="#8ae5ef"/>`).join('')}`).join('')}</svg>`);
  await page.screenshot({ path: 'test-results/medical-a-bridge-coverage.png' });
});

test('Medical M recovers both corners of each foot with one LED per branch', async ({ page }) => {
  const result = await layout(page, 'medical-m.svg', 21500, 3000);
  const feet = result.paths.filter(path => path.corner && path.points.at(-1)!.y > 2300);
  expect(feet).toHaveLength(4);
  for (const path of feet) expect(path.modules).toHaveLength(1);
  expect(result.contained).toBe(true);
  expect(result.minimumGap).toBeGreaterThanOrEqual(50 - 1e-5);
  await page.setContent(`<style>body{margin:0;background:#08160f}svg{height:900px;width:100%}path{fill:none;stroke-width:2;vector-effect:non-scaling-stroke}</style><svg viewBox="-60 0 2620 2530">${result.contours.map(d => `<path d="${d}" stroke="#59ff91"/>`).join('')}${result.paths.map(path => `<path d="${path.d}" stroke="${path.corner ? '#ffd064' : '#c59bf2'}"/>${path.modules.map(module => `<polygon points="${module.corners.map(p => `${p.x},${p.y}`).join(' ')}" fill="#8ae5ef"/>`).join('')}`).join('')}</svg>`);
  await page.screenshot({ path: 'test-results/medical-m-corner-coverage.png' });
});

test('corner branches are omitted when the physical LED cannot fit at smaller scale', async ({ page }) => {
  const result = await layout(page, 'medical-m.svg', 2150, 300);
  expect(result.paths.filter(path => path.corner)).toHaveLength(0);
  expect(result.contained).toBe(true);
  expect(result.minimumGap).toBeGreaterThanOrEqual(50 - 1e-5);
});
