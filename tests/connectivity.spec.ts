import { test, expect } from '@playwright/test';

test('forms a pigtail chain without reusing either terminal', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, distributeLeds, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 120 120"><path id="aro" fill-rule="evenodd" d="M50 0 A50 50 0 1 1 -50 0 A50 50 0 1 1 50 0 Z M30 0 A30 30 0 1 1 -30 0 A30 30 0 1 1 30 0 Z"/></svg>');
    const divisions = generateDivisions(model.figures, 1);
    const measurements = { lengthMm: 12, widthMm: 5, leftPigtailMm: 4, rightPigtailMm: 4 };
    const distribution = distributeLeds(model, divisions, measurements, 120, 120);
    return { placed: distribution.total, modes: connectLeds(model, divisions, distribution, measurements, 120, 120) };
  });
  const mode = result.modes.pigtails;
  expect(mode.links.length).toBeGreaterThan(0);
  expect(mode.bridgeTotalMm).toBe(0);
  expect(mode.connectedIds.length + mode.discardedIds.length).toBe(result.placed);
  const terminals = mode.links.flatMap((link: { fromId: string; fromSide: string; toId: string; toSide: string }) =>
    [`${link.fromId}:${link.fromSide}`, `${link.toId}:${link.toSide}`]);
  expect(new Set(terminals).size).toBe(terminals.length);
  for (const link of mode.links) {
    expect(link.lengthMm).toBeLessThanOrEqual(8.001);
    expect(link.bridgeLengthMm).toBe(0);
  }
  for (const chain of mode.chains) {
    expect(chain.entry).toBeTruthy();
    expect(chain.exit).toBeTruthy();
    expect(chain.moduleNumbers.length).toBeGreaterThan(1);
  }
});

test('bridge mode preserves pigtail links and adds only the measured extra cable between figures', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 100"><rect id="izquierda" x="0" y="0" width="100" height="100"/><rect id="derecha" x="150" y="0" width="100" height="100"/></svg>');
    const divisions = generateDivisions(model.figures, 1);
    const placement = (id: string, figureId: string, divisionId: string, number: number, x: number) => ({
      id, figureId, divisionId, number, figureNumber: number, center: { x, y: 50 },
      corners: [{ x: x - 5, y: 47.5 }, { x: x + 5, y: 47.5 }, { x: x + 5, y: 52.5 }, { x: x - 5, y: 52.5 }],
      directionStart: { x, y: 50 }, directionEnd: { x: x + 3, y: 50 }, arrow: [], labelPoint: { x, y: 50 },
    });
    const distribution = { modules: [
      placement('a', model.figures[0].id, divisions.paths[0].id, 1, 40),
      placement('b', model.figures[0].id, divisions.paths[0].id, 2, 60),
      placement('c', model.figures[1].id, divisions.paths[1].id, 3, 190),
      placement('d', model.figures[1].id, divisions.paths[1].id, 4, 210),
    ], byFigure: [], total: 4, unplaced: 0 };
    const measurements = { lengthMm: 10, widthMm: 5, leftPigtailMm: 10, rightPigtailMm: 10 };
    return {
      modes: connectLeds(model, divisions, distribution, measurements, 250, 100),
      limited: connectLeds(model, divisions, distribution, measurements, 250, 100, 50),
    };
  });
  expect(result.modes.pigtails.links).toHaveLength(2);
  expect(result.modes.pigtails.chains).toHaveLength(2);
  expect(result.modes.bridges.links).toHaveLength(3);
  const bridge = result.modes.bridges.links.find((link: { kind: string }) => link.kind === 'bridge');
  expect(bridge).toBeTruthy();
  expect(bridge.bridgeLengthMm).toBeCloseTo(100, 4);
  expect(bridge.bridgeSegment).toHaveLength(2);
  expect(result.modes.bridges.chains).toHaveLength(1);
  expect(result.modes.bridges.figureFlows[0].runs[0].sequence).toEqual([1, 2]);
  expect(result.modes.bridges.figureFlows[1].runs[0].sequence).toEqual([3, 4]);
  expect(result.limited.bridges.links).toHaveLength(2);
});

test('a cable inside a ring follows its division instead of cutting through the hole', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 120 120"><path id="aro" fill-rule="evenodd" d="M50 0 A50 50 0 1 1 -50 0 A50 50 0 1 1 50 0 Z M30 0 A30 30 0 1 1 -30 0 A30 30 0 1 1 30 0 Z"/></svg>');
    const divisions = generateDivisions(model.figures, 1);
    const placement = (id: string, number: number, y: number) => ({
      id, figureId: model.figures[0].id, divisionId: divisions.paths[0].id, number, figureNumber: number,
      center: { x: 0, y }, corners: [{ x: -5, y: y - 2.5 }, { x: 5, y: y - 2.5 }, { x: 5, y: y + 2.5 }, { x: -5, y: y + 2.5 }],
      directionStart: { x: 0, y }, directionEnd: { x: 3, y }, arrow: [], labelPoint: { x: 0, y },
    });
    const distribution = { modules: [placement('top', 1, -40), placement('bottom', 2, 40)], byFigure: [], total: 2, unplaced: 0 };
    return connectLeds(model, divisions, distribution, { lengthMm: 10, widthMm: 5, leftPigtailMm: 80, rightPigtailMm: 80 }, 120, 120).pigtails;
  });
  expect(result.links).toHaveLength(1);
  expect(result.links[0].lengthMm).toBeGreaterThan(100);
  expect(result.links[0].route.length).toBeGreaterThan(2);
  expect(result.links[0].bridgeLengthMm).toBe(0);
});

test('reverses terminal order when useful and leaves an unreachable module in the distribution', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect id="placa" width="120" height="60"/></svg>');
    const divisions = generateDivisions(model.figures, 1);
    const placement = (id: string, number: number, x: number, reversed: boolean) => ({
      id, number, figureNumber: number, figureId: model.figures[0].id, divisionId: divisions.paths[0].id,
      center: { x, y: 30 }, corners: reversed
        ? [{ x: x + 5, y: 27.5 }, { x: x - 5, y: 27.5 }, { x: x - 5, y: 32.5 }, { x: x + 5, y: 32.5 }]
        : [{ x: x - 5, y: 27.5 }, { x: x + 5, y: 27.5 }, { x: x + 5, y: 32.5 }, { x: x - 5, y: 32.5 }],
      directionStart: { x, y: 30 }, directionEnd: { x: x + 3, y: 30 }, arrow: [], labelPoint: { x, y: 30 },
    });
    const distribution = { modules: [placement('a', 1, 20, false), placement('b', 2, 40, true), placement('c', 3, 90, false)], byFigure: [], total: 3, unplaced: 0 };
    return connectLeds(model, divisions, distribution, { lengthMm: 10, widthMm: 5, leftPigtailMm: 5, rightPigtailMm: 5 }, 120, 60);
  });
  expect(result.pigtails.links).toHaveLength(1);
  expect([result.pigtails.links[0].fromSide, result.pigtails.links[0].toSide]).toEqual(['right', 'right']);
  expect(result.pigtails.discardedIds).toEqual(['c']);
  expect(result.bridges.discardedIds).toEqual(['c']);
  expect(result.pigtails.figureFlows[0].runs[0].sequence).toEqual([1, 2]);
});

test('connects modules from different divisions of the same figure when the route fits', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateDivisions, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="figura" width="100" height="100"/></svg>');
    const divisions = generateDivisions(model.figures, 2);
    const placement = (id: string, number: number, x: number, divisionId: string) => ({
      id, number, figureNumber: number, figureId: model.figures[0].id, divisionId,
      center: { x, y: 50 }, corners: [{ x: x - 5, y: 47.5 }, { x: x + 5, y: 47.5 }, { x: x + 5, y: 52.5 }, { x: x - 5, y: 52.5 }],
      directionStart: { x, y: 50 }, directionEnd: { x: x + 3, y: 50 }, arrow: [], labelPoint: { x, y: 50 },
    });
    const distribution = { modules: [placement('a', 1, 35, divisions.paths[0].id), placement('b', 2, 55, divisions.paths[1].id)], byFigure: [], total: 2, unplaced: 0 };
    return connectLeds(model, divisions, distribution, { lengthMm: 10, widthMm: 5, leftPigtailMm: 6, rightPigtailMm: 6 }, 100, 100).pigtails;
  });
  expect(result.links).toHaveLength(1);
  expect(result.links[0].lengthMm).toBeCloseTo(10, 4);
  expect(result.chains[0].moduleNumbers).toEqual([1, 2]);
});
