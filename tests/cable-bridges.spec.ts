import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

for (const importedSize of [true, false]) test(`Carnes Premium ${importedSize ? 'EPS size' : '94 by 75 cm'} routes every LED inside its piece and measures cable`, async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/carnes-premium.svg', import.meta.url), 'utf8');
  const result = await page.evaluate(async ({ source, importedSize }) => {
    const engine = '/src/engine/index.ts', placement = '/src/engine/distribution.ts', geometry = '/src/engine/regions.ts';
    const { parseSvg, planSerpent, serpentScope } = await import(engine);
    const { makeRectangle, pathPolyline, insideRegion, rectangleGap } = await import(placement);
    const { scaleRegion, regionContains, segmentsCross } = await import(geometry);
    const model = parseSvg(source), size = importedSize ? model.physicalSize! : { widthMm: 940, heightMm: 750 };
    const measurements = { lengthMm: 70, widthMm: 15, leftPigtailMm: 30, rightPigtailMm: 30 };
    const layout: import('../src/engine/layout.worker').LayoutResult = await new Promise((resolve, reject) => {
      const worker = new Worker('/src/engine/layout.worker.ts', { type: 'module' });
      worker.onmessage = event => { worker.terminate(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ model, physicalSize: size, placement: { mode: 'full', config: { minimumSectionWidthMm: 100 },
        measurements, options: { minimumGapMm: 50, maximumGapMm: 60 } } });
    });
    const distribution = layout.distribution!, guides = layout.serpentGuides!, scale = layout.skeleton.scale;
    const physical = (p: { x: number; y: number }) => ({ x: p.x * scale.x, y: p.y * scale.y });
    const regions = new Map(guides.regions.map(region => [region.id, scaleRegion(region, scale)]));
    const bodies = distribution.modules.map(module => makeRectangle(pathPolyline(guides.paths.find(path => path.id === module.divisionId)!, scale), module.positionMm!, 70, 15)!);
    const inside = distribution.modules.every((module, i) => {
      const region = regions.get(module.regionId!)!;
      return insideRegion(bodies[i], { ...region, inner: null }, 0.2);
    });
    let minimumGap = Infinity;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) minimumGap = Math.min(minimumGap, rectangleGap(bodies[i], bodies[j]));
    const snakes: import('../src/engine/serpent').SerpentResult[] = [...new Set(distribution.modules.map(serpentScope))].map(scopeId =>
      planSerpent(model, guides, distribution, measurements, size.widthMm, size.heightMm, { scopeId, allowBridges: true }));
    const byId = new Map(distribution.modules.map(module => [module.id, module]));
    let cableSafe = true;
    const failures: unknown[] = [];
    for (const snake of snakes) for (const link of snake.links) {
      const region = regions.get(snake.scopeId)!;
      const route = link.route.map(physical);
      if (byId.get(link.fromId)!.regionId !== byId.get(link.toId)!.regionId) cableSafe = false;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i];
        // Check the whole segment against boundaries as well as interior samples.
        for (const loop of [region.outer, ...region.holes]) for (let j = 0; j < loop.length; j++)
          if (segmentsCross(a, b, loop[j], loop[(j + 1) % loop.length])) { cableSafe = false; failures.push({ reason: 'boundary', id:link.id, a,b,c:loop[j],d:loop[(j+1)%loop.length] }); }
        for (let step = 0; step <= 10; step++) {
          const p = { x: a.x + (b.x - a.x) * step / 10, y: a.y + (b.y - a.y) * step / 10 };
          if (!regionContains(p, region)) { cableSafe = false; failures.push({ reason: 'outside', id:link.id, p }); }
          for (const [index, body] of bodies.entries()) {
            if (distribution.modules[index].id === link.fromId || distribution.modules[index].id === link.toId) continue;
            const dx = p.x - body.center.x, dy = p.y - body.center.y;
            if (Math.abs(dx * body.tangent.x + dy * body.tangent.y) < 35 - 1e-4 &&
              Math.abs(dx * body.normal.x + dy * body.normal.y) < 7.5 - 1e-4) { cableSafe = false; failures.push({ reason: 'body', id:link.id, p }); }
          }
        }
      }
    }
    return { total: distribution.total, inside, minimumGap, cableSafe, snakes, failures };
  }, { source, importedSize });
  expect(result.total).toBeGreaterThanOrEqual(26);
  expect(result.inside).toBe(true);
  expect(result.minimumGap).toBeGreaterThanOrEqual(49.9999);
  expect(result.failures).toEqual([]);
  expect(result.cableSafe).toBe(true);
  expect(result.snakes).toHaveLength(10);
  let bridges = 0;
  const visited: string[] = [];
  for (const snake of result.snakes) {
    expect(snake.continuous).toBe(true);
    expect(snake.breaks).toHaveLength(0);
    expect(snake.links).toHaveLength(snake.steps.length - 1);
    visited.push(...snake.steps.map(step => step.moduleId));
    const used = snake.links.flatMap(link => [`${link.fromId}:${link.fromSide}`, `${link.toId}:${link.toSide}`]);
    expect(new Set(used).size).toBe(used.length);
    expect(snake.extraCableMm).toBeCloseTo(snake.links.reduce((sum, link) => sum + link.bridgeLengthMm, 0), 6);
    for (const link of snake.links) {
      expect(link.fromPigtailUsedMm).toBeLessThanOrEqual(30.000001);
      expect(link.toPigtailUsedMm).toBeLessThanOrEqual(30.000001);
      expect(link.lengthMm).toBeCloseTo(link.fromPigtailUsedMm + link.toPigtailUsedMm + link.bridgeLengthMm, 6);
      if (link.kind === 'bridge') { bridges++; expect(link.bridgeLengthMm).toBeGreaterThan(0); }
      else expect(link.lengthMm).toBeLessThanOrEqual(60.000001);
    }
  }
  expect(new Set(visited).size).toBe(result.total);
  expect(bridges).toBeGreaterThan(0);
});

test('a submillimeter notch cannot be crossed and unequal pigtails retain their cable budget', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const engine = '/src/engine/index.ts', geometry = '/src/engine/regions.ts', cables = '/src/engine/connectivity.ts';
    const { parseSvg } = await import(engine);
    const { buildRegions, segmentsCross } = await import(geometry);
    const { createSerpentCableRouter } = await import(cables);
    const model = parseSvg('<svg viewBox="0 0 200 200"><path d="M0 0H100.11V110H100.19V0H200V200H0Z"/></svg>');
    const regions = buildRegions(model.figures).regions;
    const modules = [40, 160].map((x, i) => ({ id: String(i), figureId: model.figures[0].id, regionId: regions[0].id,
      divisionId: 'row', number: i + 1, figureNumber: i + 1, center: { x, y: 100 },
      corners: [{ x: x - 15, y: 95 }, { x: x + 15, y: 95 }, { x: x + 15, y: 105 }, { x: x - 15, y: 105 }],
      directionStart: { x, y: 100 }, directionEnd: { x, y: 100 }, arrow: [], labelPoint: { x, y: 100 } }));
    const measurements = { lengthMm: 30, widthMm: 10, leftPigtailMm: 10, rightPigtailMm: 30 };
    const route = createSerpentCableRouter(regions, [], modules, measurements, { x: 1, y: 1 }, true, true)(modules[0], 'right', modules[1], 'left');
    const crosses = route?.route.some((b: { x: number; y: number }, i: number, points: Array<{ x: number; y: number }>) => i > 0 &&
      regions[0].outer.some((c: { x: number; y: number }, j: number, loop: Array<{ x: number; y: number }>) => segmentsCross(points[i - 1], b, c, loop[(j + 1) % loop.length])));
    return { route, crosses };
  });
  // An unresolved detour is allowed; a shortcut through the notch is not.
  if (result.route) {
    expect(result.crosses).toBe(false);
    expect(result.route.lengthMm).toBeGreaterThan(90);
    expect(result.route.fromPigtailUsedMm).toBeLessThanOrEqual(30);
    expect(result.route.toPigtailUsedMm).toBeLessThanOrEqual(10);
    expect(result.route.lengthMm - result.route.bridgeLengthMm).toBeCloseTo(40, 6);
  }
});

test('cable extensions are opt in, visible and removable without changing LED placement', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG o EPS').setInputFiles({ name: 'fila.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg viewBox="0 0 400 80" width="400mm" height="80mm"><rect x="1" y="1" width="398" height="78"/></svg>') });
  await page.getByLabel('Largo del módulo', { exact: true }).fill('3');
  await page.getByLabel('Ancho del módulo', { exact: true }).fill('1');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('0');
  await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('0');
  await page.getByRole('checkbox', { name: 'MÓDULOS LED', exact: true }).check();
  await page.getByRole('checkbox', { name: 'PIGTAILS Y CONEXIONES', exact: true }).check();
  const option = page.getByRole('checkbox', { name: 'Completar saltos con cable adicional', exact: true });
  await expect(option).not.toBeChecked();
  await expect(page.locator('[data-led-module]').first()).toBeAttached();
  const count = await page.locator('[data-led-module]').count();
  await expect(page.locator('[data-bridge]')).toHaveCount(0);
  await option.check();
  await expect(page.locator('.cable-status')).toContainText('Cable adicional:', { timeout: 30000 });
  await expect(page.locator('[data-bridge]').first()).toBeAttached();
  await expect(page.locator('[data-led-module]')).toHaveCount(count);
  await expect(page.locator('[data-wiring-order]')).toHaveCount(count);
  await expect(page.locator('[data-wiring-endpoint="entrada"]')).toHaveCount(1);
  await option.uncheck();
  await expect(page.locator('[data-bridge]')).toHaveCount(0);
  await expect(page.locator('[data-led-module]')).toHaveCount(count);
});

test('the imported Carnes design shows a complete, numbered wiring plan', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.goto('/');
  // The original PostScript without the 8 MB preview; conversion stays identical.
  await page.getByLabel('Cargar archivo SVG o EPS').setInputFiles({ name: 'Sin título-1.eps', mimeType: 'application/postscript',
    buffer: readFileSync(new URL('./fixtures/carnes-premium.eps', import.meta.url)) });
  await page.getByLabel('Largo del módulo', { exact: true }).fill('7');
  await page.getByLabel('Ancho del módulo', { exact: true }).fill('1.5');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('3');
  await page.getByRole('checkbox', { name: 'MÓDULOS LED', exact: true }).check();
  await page.getByRole('checkbox', { name: 'PIGTAILS Y CONEXIONES', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Completar saltos con cable adicional', exact: true }).check();
  await expect(page.locator('.geometry-status')).toContainText('sin saltos pendientes', { timeout: 30000 });
  const count = await page.locator('[data-led-module]').count();
  expect(count).toBeGreaterThanOrEqual(25);
  await expect(page.locator('[data-wiring-order]')).toHaveCount(count);
  expect(await page.locator('[data-connection-kind="bridge"]').count()).toBeGreaterThan(0);
  await expect(page.locator('[data-wiring-endpoint="entrada"]')).toHaveCount(10);
  await expect(page.locator('.cable-status')).toContainText(/Cable adicional: \d+\.\d cm/);
  await expect(page.locator('.notice.error')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('carnes-route.png'), fullPage: true });
});
