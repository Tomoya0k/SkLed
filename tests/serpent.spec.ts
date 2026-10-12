import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const drawing = '<svg xmlns="http://www.w3.org/2000/svg" width="460mm" height="90mm" viewBox="0 0 460 90"><path d="M5 5H205V85H5Z M255 5H455V85H255Z"/></svg>';

test('pigtail sum is a hard limit, including detours and unequal terminals', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts', regionsPath = '/src/engine/regions.ts', cablePath = '/src/engine/connectivity.ts';
    const { parseSvg, planSerpent } = await import(enginePath);
    const { buildRegions } = await import(regionsPath);
    const { createSerpentCableRouter } = await import(cablePath);
    const model = parseSvg('<svg viewBox="0 0 200 200"><path d="M0 0H200V200H0Z"/></svg>');
    const regions = buildRegions(model.figures).regions;
    const module = (id: string, x: number, y: number, reversed = false) => {
      const corners = [{ x: x - 15, y: y - 5 }, { x: x + 15, y: y - 5 }, { x: x + 15, y: y + 5 }, { x: x - 15, y: y + 5 }];
      return { id, figureId: model.figures[0].id, regionId: regions[0].id, divisionId: 'row', rowRunId: 'row', positionMm: x,
        number: x, figureNumber: x, center: { x, y }, corners: reversed ? [corners[2], corners[3], corners[0], corners[1]] : corners,
        directionStart: { x: x - 15, y }, directionEnd: { x: x + 15, y }, arrow: [], labelPoint: { x, y } };
    };
    const modules = [module('a', 30, 40), module('b', 90, 40), module('c', 150, 40)];
    const measurements = { lengthMm: 30, widthMm: 10, leftPigtailMm: 15, rightPigtailMm: 15 };
    const distribution = { modules, byFigure: [], total: 3, unplaced: 0 };
    const divisions = { paths: [], regions, warnings: [] };
    const options = { scopeId: regions[0].id, startId: 'a', endId: 'c', startSide: 'left', endSide: 'right' };
    const boundary = planSerpent(model, divisions, distribution, measurements, 200, 200, options);
    const tooShort = planSerpent(model, divisions, distribution, { ...measurements, leftPigtailMm: 14, rightPigtailMm: 15 }, 200, 200, options);
    // Two long right leads still cannot exceed left + right as a global cap.
    const unequalModules = [module('a', 30, 40), module('b', 110, 40, true)];
    const unequal = createSerpentCableRouter(regions, [], unequalModules, { ...measurements, leftPigtailMm: 10, rightPigtailMm: 30 }, { x: 1, y: 1 })(unequalModules[0], 'right', unequalModules[1], 'right');
    const ring = parseSvg('<svg viewBox="0 0 200 200"><path fill-rule="evenodd" d="M0 0H200V200H0Z M80 80H120V120H80Z"/></svg>');
    const ringRegions = buildRegions(ring.figures).regions;
    const ringModules = [module('a', 50, 100), module('b', 150, 100)];
    const around = (pigtail: number) => createSerpentCableRouter(ringRegions, [], ringModules, { ...measurements, leftPigtailMm: pigtail, rightPigtailMm: pigtail }, { x: 1, y: 1 })(ringModules[0], 'right', ringModules[1], 'left');
    return { boundary, tooShort, unequal, shortDetour: around(40), reachableDetour: around(60) };
  });
  expect(result.boundary.continuous).toBe(true);
  expect(result.boundary.links).toHaveLength(2);
  for (const link of result.boundary.links) { expect(link.lengthMm).toBeCloseTo(30, 6); expect(link.kind).toBe('pigtail'); }
  expect(result.tooShort.continuous).toBe(false);
  expect(result.tooShort.links).toHaveLength(0);
  expect(result.tooShort.breaks).toHaveLength(2);
  expect(result.tooShort.extraCableMm).toBe(0);
  expect(result.unequal).toBeNull();
  expect(result.shortDetour).toBeNull();
  expect(result.reachableDetour).not.toBeNull();
  expect(result.reachableDetour!.lengthMm).toBeGreaterThan(80);
  expect(result.reachableDetour!.lengthMm).toBeLessThanOrEqual(120.00001);
});

test('desired minimum stays at 3 cm with unequal or short pigtails', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'figuras.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(drawing) });
  await page.getByLabel('Largo del módulo').fill('3'); await page.getByLabel('Ancho del módulo').fill('1');
  await page.getByLabel('Pigtail izquierdo').fill('1.5'); await page.getByLabel('Pigtail derecho').fill('5');
  await expect(page.locator('.size-hint').filter({ hasText: 'Separación libre' })).toHaveText('Separación libre en fila: mínima deseable 3 cm · máximo 6.5 cm');
  await page.getByLabel('Pigtail izquierdo').fill('1'); await page.getByLabel('Pigtail derecho').fill('1');
  await expect(page.locator('.size-hint').filter({ hasText: 'Separación libre' })).toContainText('máximo 2 cm. Los pigtails no alcanzan la mínima deseable.');
  await page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true }).check();
  await expect(page.locator('[data-serpent-through]').first()).toBeVisible();
  await expect(page.locator('.notice.error')).toHaveCount(0);
  await expect(page.locator('[data-serpent-kind="bridge"]')).toHaveCount(0);
});

test('large SVG calculations can be cancelled without freezing the controls', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'SAINT.svg', mimeType: 'image/svg+xml', buffer: readFileSync(new URL('./fixtures/SAINT_gotico_extra_grande.svg', import.meta.url)) });
  await page.getByLabel('Largo del módulo').fill('7'); await page.getByLabel('Ancho del módulo').fill('1.5');
  await page.getByLabel('Pigtail izquierdo').fill('3'); await page.getByLabel('Pigtail derecho').fill('3');
  const toggle = page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true });
  await toggle.check({ timeout: 2000 });
  await expect(page.locator('.geometry-status')).toContainText('Calculando guías');
  await toggle.uncheck({ timeout: 2000 });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('.geometry-status')).toHaveCount(0);
});

test('snake honors both chosen endpoints, visits one figure once, and never reuses a terminal', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async source => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, distributeLeds, planSerpent } = await import(enginePath);
    const model = parseSvg(source), measurements = { lengthMm: 30, widthMm: 10, leftPigtailMm: 20, rightPigtailMm: 20 };
    const skeleton = generateSkeleton(model, { widthMm: 460, heightMm: 90 });
    const paths = generatePartitions(skeleton, { moduleLengthMm: 30, moduleWidthMm: 10, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    const distribution = distributeLeds(model, paths, measurements, 460, 90, { minimumGapMm: 20, maximumGapMm: 40, bodyGapMm: 6, edgeMarginMm: 6 });
    const scopeId = distribution.modules[0].regionId;
    const local = distribution.modules.filter((module: { regionId: string }) => module.regionId === scopeId);
    const startId = local[1].id, endId = local.at(-2).id;
    return { localIds: local.map((module: { id: string }) => module.id), startId, endId,
      result: planSerpent(model, paths, distribution, measurements, 460, 90, { scopeId, startId, endId, startSide: 'right', endSide: 'left' }),
      stale: planSerpent(model, paths, { ...distribution, modules: [local[0]], total: 1 }, measurements, 460, 90, { scopeId, startId: 'removed-start', endId: 'removed-exit', startSide: 'right', endSide: 'right' }) };
  }, drawing);
  expect(result.result.startId).toBe(result.startId);
  expect(result.result.endId).toBe(result.endId);
  expect(result.result.steps[0].entrySide).toBe('right');
  expect(result.result.steps.at(-1).exitSide).toBe('left');
  expect(result.stale.steps).toHaveLength(1);
  expect(result.stale.warnings).toHaveLength(2);
  expect(result.stale.steps[0].entrySide).not.toBe(result.stale.steps[0].exitSide);
  expect(result.result.steps.map((step: { moduleId: string }) => step.moduleId).sort()).toEqual(result.localIds.sort());
  expect(new Set(result.result.steps.map((step: { moduleId: string }) => step.moduleId)).size).toBe(result.localIds.length);
  expect(result.result.continuous).toBe(result.result.breaks.length === 0);
  expect(result.result.links.length + result.result.breaks.length).toBe(result.localIds.length - 1);
  expect(result.result.extraCableMm).toBe(0);
  const used = result.result.links.flatMap((link: { fromId: string; toId: string; fromSide: string; toSide: string }) => [`${link.fromId}:${link.fromSide}`, `${link.toId}:${link.toSide}`]);
  expect(new Set(used).size).toBe(used.length);
  for (const step of result.result.steps) expect(step.entrySide).not.toBe(step.exitSide);
  for (const link of result.result.links) {
    expect(link.kind).toBe('pigtail');
    expect(link.lengthMm).toBeLessThanOrEqual(40.00001);
    expect(link.bridgeLengthMm).toBe(0);
    for (const point of link.route) { expect(point.x).toBeGreaterThan(5); expect(point.x).toBeLessThan(205); expect(point.y).toBeGreaterThan(5); expect(point.y).toBeLessThan(85); }
  }
});

test('snake layer shows only guides for each figure and LED bodies remain independent', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'figuras.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(drawing) });
  await page.getByLabel('Largo del módulo').fill('3');
  await page.getByLabel('Ancho del módulo').fill('1');
  await page.getByLabel('Pigtail izquierdo').fill('2');
  await page.getByLabel('Pigtail derecho').fill('2');
  const snake = page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true });
  const leds = page.getByRole('checkbox', { name: 'MÓDULOS LED', exact: true });
  await snake.check();
  await expect(page.locator('[data-serpent-scope]')).toHaveCount(2);
  await expect(page.locator('[data-serpent-link]').first()).toBeAttached();
  expect(await page.locator('[data-serpent-link]').first().evaluate((path: SVGPathElement) => path.getTotalLength())).toBeGreaterThan(0);
  await expect(leds).not.toBeChecked();
  await expect(page.locator('[data-led-module], .serpent-controls, [data-serpent-entry], [data-serpent-exit], [data-serpent-terminal], [data-serpent-module-hit]')).toHaveCount(0);
  await expect(page.locator('[data-serpent-scope] polygon, [data-serpent-scope] text, [data-serpent-scope] circle, [data-serpent-scope] [marker-end], [data-serpent-unresolved]')).toHaveCount(0);
  for (const name of ['Elegir inicio', 'Elegir salida', 'Invertir']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  const guides = await page.locator('[data-serpent-through]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-serpent-through')).sort());
  await leds.check();
  await expect(page.locator('[data-led-module]')).toHaveCount(guides.length);
  const bodies = await page.locator('[data-led-module]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-led-module')).sort());
  expect(guides).toEqual(bodies);
  const guidesMatchBodyAxes = await page.locator('.drawing').evaluate(svg => [...svg.querySelectorAll('[data-led-module]')].every(module => {
    const guide = [...svg.querySelectorAll('[data-serpent-through]')].find(node => node.getAttribute('data-serpent-through') === module.getAttribute('data-led-module')) as SVGPathElement;
    const body = module.querySelector('.led-body') as SVGPolygonElement;
    const ends = [guide.getPointAtLength(0), guide.getPointAtLength(guide.getTotalLength())];
    const left = { x: (body.points[0].x + body.points[3].x) / 2, y: (body.points[0].y + body.points[3].y) / 2 };
    const right = { x: (body.points[1].x + body.points[2].x) / 2, y: (body.points[1].y + body.points[2].y) / 2 };
    return ends.every(p => Math.min(Math.hypot(p.x - left.x, p.y - left.y), Math.hypot(p.x - right.x, p.y - right.y)) < 0.001);
  }));
  expect(guidesMatchBodyAxes).toBe(true);
  await leds.uncheck();
  await expect(page.locator('[data-led-module]')).toHaveCount(0);
  await expect(page.locator('[data-serpent-through]')).toHaveCount(guides.length);
  await snake.uncheck();
  await expect(page.locator('[data-serpent-scope]')).toHaveCount(0);
});

test('a snake around a hole keeps its entire cable route out of the void', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, distributeLeds, planSerpent } = await import(enginePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill-rule="evenodd" d="M5 5H195V195H5Z M65 65H135V135H65Z"/></svg>');
    const measurements = { lengthMm: 25, widthMm: 10, leftPigtailMm: 20, rightPigtailMm: 20 };
    const skeleton = generateSkeleton(model, { widthMm: 200, heightMm: 200 });
    const paths = generatePartitions(skeleton, { moduleLengthMm: 25, moduleWidthMm: 10, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    const distribution = distributeLeds(model, paths, measurements, 200, 200, { minimumGapMm: 20, maximumGapMm: 40, bodyGapMm: 6, edgeMarginMm: 6 });
    return planSerpent(model, paths, distribution, measurements, 200, 200, { scopeId: distribution.modules[0].regionId });
  });
  expect(result.steps.length).toBeGreaterThan(8);
  expect(result.links.length).toBeGreaterThan(0);
  expect(result.links.length + result.breaks.length).toBe(result.steps.length - 1);
  expect(result.continuous).toBe(result.breaks.length === 0);
  for (const link of result.links) { expect(link.kind).toBe('pigtail'); expect(link.lengthMm).toBeLessThanOrEqual(40.00001); }
  for (const link of result.links) for (let i = 1; i < link.route.length; i++) {
    const a = link.route[i - 1], b = link.route[i];
    const samples = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
    for (let j = 0; j <= samples; j++) {
      const x = a.x + (b.x - a.x) * j / samples, y = a.y + (b.y - a.y) * j / samples;
      expect(x > 5 && x < 195 && y > 5 && y < 195 && !(x >= 65 && x <= 135 && y >= 65 && y <= 135)).toBe(true);
    }
  }
});
