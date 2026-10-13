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

test('desired minimum remains configurable with unequal or short pigtails', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'figuras.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(drawing) });
  await page.getByLabel('Largo del módulo').fill('3'); await page.getByLabel('Ancho del módulo').fill('1');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('1.5'); await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('5');
  await expect(page.getByRole('heading', { name: 'Pigtails y conexiones' })).toBeVisible();
  await expect(page.getByLabel('Separación mínima deseable entre módulos')).toHaveValue('3');
  await page.getByLabel('Separación mínima deseable entre módulos').fill('9');
  await expect(page.getByLabel('Separación mínima deseable entre módulos')).toHaveValue('6.5');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('1'); await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('1');
  await expect(page.getByLabel('Separación mínima deseable entre módulos')).toHaveValue('2');
  await expect(page.getByRole('img', { name: /pigtail izquierdo 1 cm, pigtail derecho 1 cm/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true }).check();
  const through = page.locator('[data-serpent-guide]').first();
  // A perfectly horizontal SVG path has a zero-height box, despite its visible stroke.
  await expect(through).toBeAttached();
  expect(await through.evaluate(node => (node as SVGPathElement).getTotalLength())).toBeGreaterThan(0);
  await expect(page.locator('.notice.error')).toHaveCount(0);
  await expect(page.locator('[data-serpent-kind="bridge"]')).toHaveCount(0);
});

test('large SVG calculations can be cancelled without freezing the controls', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'SAINT.svg', mimeType: 'image/svg+xml', buffer: readFileSync(new URL('./fixtures/SAINT_gotico_extra_grande.svg', import.meta.url)) });
  await page.getByLabel('Largo del módulo').fill('7'); await page.getByLabel('Ancho del módulo').fill('1.5');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('3'); await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('3');
  const toggle = page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true });
  await toggle.check({ timeout: 2000 });
  await expect(page.locator('.geometry-status')).toContainText('Calculando recorridos candidatos');
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
    const paths = generatePartitions(skeleton);
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

test('snake combines geometric guides independently of module parameters and layers', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'figuras.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(drawing) });
  await page.getByLabel('Largo del módulo').fill('');
  await page.getByLabel('Ancho del módulo').fill('');
  const snake = page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true });
  const leds = page.getByRole('checkbox', { name: 'MÓDULOS LED', exact: true });
  await snake.check();
  await expect(page.locator('[data-serpent-scope]')).toHaveCount(2);
  await expect(page.locator('[data-serpent-source="partition"]').first()).toBeAttached();
  await expect(page.locator('[data-serpent-source="skeleton"]').first()).toBeAttached();
  await expect(leds).not.toBeChecked();
  await expect(page.locator('[data-led-module], .serpent-controls, [data-serpent-entry], [data-serpent-exit]')).toHaveCount(0);
  await expect(page.locator('[data-serpent-scope] polygon, [data-serpent-scope] text, [data-serpent-scope] circle, [data-serpent-scope] [marker-end]')).toHaveCount(0);
  const readGuides = () => page.locator('[data-serpent-guide]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-serpent-guide'), node.getAttribute('d'), node.getAttribute('data-serpent-source')]));
  const guides = await readGuides();
  await page.getByLabel('Largo del módulo').fill('3');
  await page.getByLabel('Ancho del módulo').fill('1');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('2');
  await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('2');
  await leds.check();
  await expect(page.locator('[data-led-module]').first()).toBeAttached();
  expect(await readGuides()).toEqual(guides);
  await leds.uncheck();
  await expect(page.locator('[data-led-module]')).toHaveCount(0);
  await expect.poll(readGuides).toEqual(guides);
  await page.getByLabel('Distancia mínima entre skeleton y borde para formar una partida', { exact: true }).fill('100');
  await expect(page.locator('[data-serpent-source="partition"]')).toHaveCount(0);
  await expect(page.locator('[data-serpent-source="skeleton"]').first()).toBeAttached();
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
    const paths = generatePartitions(skeleton);
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
