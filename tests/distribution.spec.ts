import { test, expect } from '@playwright/test';

const ringSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 120 120"><path id="aro" fill-rule="evenodd" d="M50 0 A50 50 0 1 1 -50 0 A50 50 0 1 1 50 0 Z M30 0 A30 30 0 1 1 -30 0 A30 30 0 1 1 30 0 Z"/></svg>';

test('places physical module bodies inside a curved band with orientation and counts', async ({ page }) => {
  await page.goto('/');
  const { result, noPigtails, unequalPigtails } = await page.evaluate(async source => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, distributeLeds } = await import(modulePath);
    const model = parseSvg(source);
    const divisions = generateDivisions(model.figures, 1);
    return {
      result: distributeLeds(model, divisions, { lengthMm: 12, widthMm: 5, leftPigtailMm: 4, rightPigtailMm: 4 }, 120, 120),
      noPigtails: distributeLeds(model, divisions, { lengthMm: 12, widthMm: 5, leftPigtailMm: 0, rightPigtailMm: 0 }, 120, 120),
      unequalPigtails: distributeLeds(model, divisions, { lengthMm: 12, widthMm: 5, leftPigtailMm: 4, rightPigtailMm: 40 }, 120, 120),
    };
  }, ringSvg);
  expect(result.total).toBeGreaterThan(5);
  expect(noPigtails.total + noPigtails.unplaced).toBeGreaterThan(result.total + result.unplaced);
  expect(unequalPigtails.total).toBe(result.total);
  expect(unequalPigtails.unplaced).toBe(result.unplaced);
  expect(result.byFigure[0].placed).toBe(result.total);
  expect(result.byFigure[0].unplaced).toBe(result.unplaced);
  expect(result.modules.map((module: { number: number }) => module.number)).toEqual(Array.from({ length: result.total }, (_, index) => index + 1));
  for (const module of result.modules) {
    for (const corner of module.corners) {
      const radius = Math.hypot(corner.x, corner.y);
      expect(radius).toBeGreaterThan(30);
      expect(radius).toBeLessThan(50);
    }
  }
});

test('reports failed positions when neighboring division paths cannot both fit module bodies', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, distributeLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path id="banda" fill-rule="evenodd" d="M10 10 H190 V90 H10 Z M30 30 H170 V70 H30 Z"/></svg>');
    const divisions = generateDivisions(model.figures, 2);
    return distributeLeds(model, divisions, { lengthMm: 18, widthMm: 13, leftPigtailMm: 4, rightPigtailMm: 4 }, 200, 100);
  });
  expect(result.total).toBeGreaterThan(0);
  expect(result.unplaced).toBeGreaterThan(0);
  for (const module of result.modules) {
    for (const point of module.corners) {
      expect(point.x).toBeGreaterThan(10);
      expect(point.x).toBeLessThan(190);
      expect(point.y).toBeGreaterThan(10);
      expect(point.y).toBeLessThan(90);
      expect(point.x <= 30 || point.x >= 170 || point.y <= 30 || point.y >= 70).toBe(true);
    }
  }
});

test('module dimensions stay physical when SVG width and height use different scales', async ({ page }) => {
  await page.goto('/');
  const corners = await page.evaluate(async source => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, distributeLeds } = await import(modulePath);
    const model = parseSvg(source);
    return distributeLeds(model, generateDivisions(model.figures, 1),
      { lengthMm: 12, widthMm: 5, leftPigtailMm: 4, rightPigtailMm: 4 }, 240, 120).modules[0].corners;
  }, ringSvg);
  const physicalDistance = (a: typeof corners[number], b: typeof corners[number]) => Math.hypot((a.x - b.x) * 2, a.y - b.y);
  expect(physicalDistance(corners[0], corners[1])).toBeCloseTo(12, 4);
  expect(physicalDistance(corners[1], corners[2])).toBeCloseTo(5, 4);
});

test('LED layer waits for physical dimensions and reacts to module sizes and partitions', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'aro.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(ringSvg) });
  await page.getByRole('checkbox', { name: 'MÓDULOS LED' }).check();
  await expect(page.locator('.geometry-status')).toContainText('Indica ancho y alto del SVG');
  await page.getByLabel('Ancho del SVG').fill('24');
  await page.getByLabel('Largo del módulo').fill('1.2');
  await page.getByLabel('Ancho del módulo').fill('0.5');
  await page.getByLabel('Pigtail izquierdo').fill('3');
  await page.getByLabel('Pigtail derecho').fill('3');
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
  await expect(page.locator('[data-division]')).toHaveCount(0);
  const firstCount = await page.locator('[data-led-module]').count();
  expect(firstCount).toBeGreaterThan(0);
  await page.getByLabel('Largo del módulo').fill('2');
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
  const secondCount = await page.locator('[data-led-module]').count();
  expect(secondCount).toBeLessThan(firstCount);
  await page.getByLabel('Separación libre entre recorridos').fill('0');
  await page.getByLabel('Margen objetivo al borde').fill('0');
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
});

test('route layer draws only the guides used by placed LEDs beneath their modules', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'aro.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(ringSvg) });
  await page.getByLabel('Ancho del SVG').fill('12');
  await page.getByLabel('Largo del módulo').fill('1.2');
  await page.getByLabel('Ancho del módulo').fill('0.5');
  await page.getByLabel('Pigtail izquierdo').fill('0.4');
  await page.getByLabel('Pigtail derecho').fill('0.4');

  const routes = page.locator('[data-led-route]');
  const modules = page.locator('[data-led-module]');
  await page.getByRole('checkbox', { name: 'PARTIDAS' }).check();
  await expect(routes.first()).toBeVisible();
  await expect(modules).toHaveCount(0);

  await page.getByRole('checkbox', { name: 'MÓDULOS LED' }).check();
  await expect(modules.first()).toBeVisible();
  const routeIds = await routes.evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-led-route')))].sort());
  const usedIds = await modules.evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-led-route-id')))].sort());
  expect(routeIds).toEqual(usedIds);
  const routesAreUnderModules = await page.locator('.drawing').evaluate(svg => {
    const route = svg.querySelector('[data-led-route]'), module = svg.querySelector('[data-led-module]');
    return !!route && !!module && !!(route.compareDocumentPosition(module) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(routesAreUnderModules).toBe(true);

  const moduleCount = await modules.count();
  await page.getByRole('checkbox', { name: 'PARTIDAS' }).uncheck();
  await expect(routes).toHaveCount(0);
  await expect(modules).toHaveCount(moduleCount);
});

test('keeps placed modules from every SVG figure without a figure list', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({
    name: 'dos-aros.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 120" width="260mm" height="120mm"><path id="uno" fill-rule="evenodd" d="M10 10 H110 V110 H10 Z M30 30 H90 V90 H30 Z"/><path id="dos" fill-rule="evenodd" d="M150 10 H250 V110 H150 Z M170 30 H230 V90 H170 Z"/></svg>'),
  });
  await page.getByLabel('Largo del módulo').fill('1.2');
  await page.getByLabel('Ancho del módulo').fill('0.5');
  await page.getByLabel('Pigtail izquierdo').fill('0.4');
  await page.getByLabel('Pigtail derecho').fill('0.4');
  await page.getByRole('checkbox', { name: 'MÓDULOS LED' }).check();
  const modules = page.locator('[data-led-module]');
  await expect(modules.first()).toBeVisible();
  expect(await modules.count()).toBeGreaterThan(0);
  const figureIds = await modules.evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-figure')))]);
  expect(figureIds).toHaveLength(2);
  await expect(page.locator('.figures-section, .led-summary')).toHaveCount(0);
});
