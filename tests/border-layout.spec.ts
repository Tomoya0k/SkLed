import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('variable border spacing covers Carnes and preserves fragments, holes and clearances', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/carnes-premium.svg', import.meta.url), 'utf8');
  const results = await page.evaluate(async source => {
    const e = '/src/engine/index.ts', b = '/src/engine/border-layout.ts', r = '/src/engine/regions.ts', p = '/src/engine/distribution.ts';
    const { parseSvg, planSerpent, serpentScope } = await import(e), { buildRegions, scaleRegion } = await import(r);
    const { generateBorderLayout } = await import(b), { makeRectangle, pathPolyline, insideRegion, rectangleGap } = await import(p);
    const model: import('../src/engine/types').SvgModel = parseSvg(source), size = model.physicalSize!;
    const geometry: ReturnType<typeof import('../src/engine/regions').buildRegions> = buildRegions(model.figures);
    const measurements = { lengthMm: 70, widthMm: 15, leftPigtailMm: 30, rightPigtailMm: 30 };
    return [50, 10, 5].map(gap => {
      const { guides, distribution }: ReturnType<typeof import('../src/engine/border-layout').generateBorderLayout> =
        generateBorderLayout(model, geometry, size, measurements, { minimumGapMm: gap, maximumGapMm: 60, flexibleSpacing: gap !== 50 });
      const d = distribution!, scale = { x: size.widthMm / model.viewBox.width, y: size.heightMm / model.viewBox.height };
      const bodies = d.modules.map(module => makeRectangle(pathPolyline(guides.paths.find(path => path.id === module.divisionId)!, scale), module.positionMm!, 70, 15));
      const inside = bodies.every((body, i) => {
        const region = scaleRegion(geometry.regions.find(region => region.id === d.modules[i].regionId)!, scale);
        return insideRegion(body, { ...region, inner: null }, 0.1999);
      });
      let minimumGap = Infinity;
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) minimumGap = Math.min(minimumGap, rectangleGap(bodies[i], bodies[j]));
      const word = geometry.regions.find(region => region.figureId === model.figures[2].id)!;
      const wordBodies = d.modules.filter(module => module.regionId === word.id);
      const minX = Math.min(...word.outer.map(p => p.x)), maxX = Math.max(...word.outer.map(p => p.x));
      const snakes: import('../src/engine/serpent').SerpentResult[] = gap === 10 ? [...new Set(d.modules.map(serpentScope))].map(scopeId =>
        planSerpent(model, guides, d, measurements, size.widthMm, size.heightMm, { scopeId, allowBridges: true })) : [];
      return { gap, total: d.total, inside, minimumGap, wordCount: wordBodies.length,
        pending: snakes.reduce((sum, snake) => sum + snake.breaks.length, 0), visited: snakes.reduce((sum, snake) => sum + snake.steps.length, 0),
        wordXs: wordBodies.map(module => (module.center.x - minX) / (maxX - minX)),
        wordFragments: guides.paths.filter(path => path.regionId === word.id).length,
        occupiedRegions: new Set(d.modules.map(module => module.regionId)).size,
        routedOnce: d.modules.every(module => d.routeRuns!.filter(run => run.moduleIds.includes(module.id)).length === 1) };
    });
  }, source);
  for (const result of results) {
    expect(result.inside).toBe(true);
    expect(result.minimumGap).toBeGreaterThanOrEqual(result.gap - 1e-4);
    expect(result.occupiedRegions).toBe(10);
    expect(result.routedOnce).toBe(true);
  }
  const flexible = results[1];
  expect(flexible.pending).toBe(0);
  expect(flexible.visited).toBe(flexible.total);
  expect(flexible.total).toBeGreaterThanOrEqual(45);
  expect(flexible.total).toBeGreaterThan(results[0].total * 1.7);
  expect(flexible.minimumGap).toBeLessThan(20);
  expect(flexible.wordCount).toBeGreaterThanOrEqual(7);
  expect(flexible.wordFragments).toBeGreaterThan(1);
  expect(Math.min(...flexible.wordXs)).toBeLessThan(0.2);
  expect(Math.max(...flexible.wordXs)).toBeGreaterThan(0.8);
  expect(results[2].total).toBeGreaterThanOrEqual(flexible.total);
});

test('bridging separate fragments preserves pinned terminals and visits each LED once', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const e = '/src/engine/index.ts', r = '/src/engine/regions.ts';
    const { parseSvg, planSerpent } = await import(e), { buildRegions } = await import(r);
    const model = parseSvg('<svg viewBox="0 0 240 100"><rect width="240" height="100"/></svg>');
    const regions = buildRegions(model.figures).regions;
    const modules = [30, 90, 150, 210].map((x, i): import('../src/engine/distribution').LedPlacement => ({
      id: `m${i}`, figureId: model.figures[0].id, regionId: regions[0].id, divisionId: `fragment-${i}`,
      number: i + 1, figureNumber: i + 1, center: { x, y: 50 },
      corners: [{ x: x - 15, y: 45 }, { x: x + 15, y: 45 }, { x: x + 15, y: 55 }, { x: x - 15, y: 55 }],
      directionStart: { x, y: 50 }, directionEnd: { x, y: 50 }, labelPoint: { x, y: 50 },
      arrow: [{ x, y: 50 }, { x, y: 50 }, { x, y: 50 }],
    }));
    return planSerpent(model, { paths: [], regions, warnings: [] }, { modules, byFigure: [], total: 4, unplaced: 0 },
      { lengthMm: 30, widthMm: 10, leftPigtailMm: 15, rightPigtailMm: 15 }, 240, 100,
      { scopeId: regions[0].id, allowBridges: true, startId: 'm1', endId: 'm2', startSide: 'right', endSide: 'right' }) as import('../src/engine/serpent').SerpentResult;
  });
  expect(result.continuous).toBe(true);
  expect(result.steps[0].moduleId).toBe('m1'); expect(result.steps[0].entrySide).toBe('right');
  expect(result.steps.at(-1)!.moduleId).toBe('m2'); expect(result.steps.at(-1)!.exitSide).toBe('right');
  expect(new Set(result.steps.map(step => step.moduleId)).size).toBe(4);
  const terminals = result.links.flatMap(link => [`${link.fromId}:${link.fromSide}`, `${link.toId}:${link.toSide}`]);
  expect(new Set(terminals).size).toBe(6);
  expect(result.extraCableMm).toBeGreaterThan(0);
});

test('narrow necks retain both sides and hole boundaries do not generate extra rows', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const e = '/src/engine/index.ts', b = '/src/engine/border-layout.ts', r = '/src/engine/regions.ts';
    const { parseSvg } = await import(e), { buildRegions } = await import(r), { generateBorderLayout } = await import(b);
    const split = parseSvg('<svg viewBox="0 0 600 200"><path d="M0 0H220V80H380V0H600V200H380V120H220V200H0Z"/></svg>');
    const measurements = { lengthMm: 70, widthMm: 50, leftPigtailMm: 30, rightPigtailMm: 30 };
    const row = generateBorderLayout(split, buildRegions(split.figures), { widthMm: 600, heightMm: 200 }, measurements,
      { minimumGapMm: 10, maximumGapMm: 60, flexibleSpacing: true });
    const ring = parseSvg('<svg viewBox="10000 -30000 600 600"><path fill-rule="evenodd" d="M10000 -30000H10600V-29400H10000Z M10150 -29850V-29550H10450V-29850Z"/></svg>');
    const ringRow = generateBorderLayout(ring, buildRegions(ring.figures), { widthMm: 900, heightMm: 600 },
      { ...measurements, widthMm: 15 }, { minimumGapMm: 10, maximumGapMm: 60, flexibleSpacing: true });
    return { splitPaths: row.guides.paths.length, left: row.distribution.modules.some((m: { center: { x: number } }) => m.center.x < 220),
      right: row.distribution.modules.some((m: { center: { x: number } }) => m.center.x > 380),
      scopes: new Set(row.distribution.modules.map((m: { regionId: string }) => m.regionId)).size,
      ringPaths: ringRow.guides.paths.length, ringHoles: ringRow.guides.regions[0].holes.length, ringTotal: ringRow.distribution.total };
  });
  expect(result.splitPaths).toBe(2);
  expect(result.left).toBe(true); expect(result.right).toBe(true);
  expect(result.scopes).toBe(1);
  expect(result.ringPaths).toBe(1); expect(result.ringHoles).toBe(1);
  expect(result.ringTotal).toBeGreaterThan(10);
});

test('SOLO BORDE spacing is editable and full layout keeps its previous hardware and spacing', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG o EPS').setInputFiles({ name: 'Sin título-1.eps', mimeType: 'application/postscript',
    buffer: readFileSync(new URL('./fixtures/carnes-premium.eps', import.meta.url)) });
  await expect(page.locator('.canvas-corner')).toHaveText('Sin título-1.eps', { timeout: 25000 });
  await page.getByLabel('Largo del módulo', { exact: true }).fill('7');
  await page.getByLabel('Ancho del módulo', { exact: true }).fill('1.5');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('3');
  await page.getByRole('checkbox', { name: 'MÓDULOS LED', exact: true }).check();
  await expect(page.getByRole('button', { name: /TOTAL LED \d+/ })).toBeEnabled({ timeout: 20000 });
  const fullCount = await page.locator('[data-led-module]').count();
  const border = page.getByRole('button', { name: 'SOLO BORDE', exact: true });
  await border.click();
  const minimum = page.getByRole('spinbutton', { name: 'Separación mínima en SOLO BORDE', exact: true });
  await expect(minimum).toHaveValue('1');
  await expect.poll(() => page.locator('[data-led-module]').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(45);
  const flexibleCount = await page.locator('[data-led-module]').count();
  await minimum.fill('0.5');
  await expect(page.getByRole('button', { name: /TOTAL LED \d+/ })).toBeEnabled({ timeout: 20000 });
  expect(await page.locator('[data-led-module]').count()).toBeGreaterThanOrEqual(flexibleCount);
  await minimum.fill('1');
  await expect.poll(() => page.locator('[data-led-module]').count(), { timeout: 20000 }).toBe(flexibleCount);
  await page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true }).check();
  await expect(page.locator('[data-serpent-guide]').first()).toBeAttached();
  await page.screenshot({ path: testInfo.outputPath('borde-mejorado.png'), fullPage: true });
  await border.click();
  await expect(page.getByLabel('Separación mínima automática entre módulos')).toHaveText('5');
  await expect.poll(() => page.locator('[data-led-module]').count(), { timeout: 20000 }).toBe(fullCount);
  await border.click();
  await expect(minimum).toHaveValue('1');
  await expect(page.getByLabel('Largo del módulo', { exact: true })).toHaveValue('7');
  await expect(page.getByLabel('Ancho del módulo', { exact: true })).toHaveValue('1.5');
  await expect(page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true })).toHaveValue('3');
  await expect(page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true })).toHaveValue('3');
  await page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Completar saltos con cable adicional', exact: true }).check();
  await page.getByRole('checkbox', { name: 'PIGTAILS Y CONEXIONES', exact: true }).check();
  await expect(page.locator('.geometry-status')).toContainText('sin saltos pendientes', { timeout: 30000 });
  await expect(page.locator('[data-wiring-order]')).toHaveCount(flexibleCount);
  await page.screenshot({ path: testInfo.outputPath('borde-cableado.png'), fullPage: true });
});
