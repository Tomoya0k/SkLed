import { test, expect } from '@playwright/test';

test('partition filter rejects short, narrow and hole-crossing guides and trims unsupported tails', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const fitPath = '/src/engine/partition-fit.ts', geometryPath = '/src/engine/distribution.ts';
    const { filterPartitionsForBody } = await import(fitPath);
    const { pathPolyline, makeRectangle, insideRegion } = await import(geometryPath);
    const region = { id: 'region', figureId: 'figure', outerContourId: 'outer', holeContourIds: ['hole'],
      outer: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 140 }, { x: 0, y: 140 }],
      holes: [[{ x: 98, y: 55 }, { x: 102, y: 55 }, { x: 102, y: 65 }, { x: 98, y: 65 }]] };
    const path = (id: string, x: number, y: number, end: number) => ({ id, regionId: 'region', figureId: 'figure', outerContourId: 'outer', innerContourId: 'hole', index: 1, fraction: 0.5,
      sourceEdgeId: id, sourceRange: [0, end - x], lane: 0, closed: false, points: [{ x, y }, { x: end, y }], d: `M${x} ${y}L${end} ${y}` });
    const input = [path('valid', 10, 20, 230), path('short', 10, 120, 40), path('narrow', 10, 4, 230), path('hole', 70, 60, 160), path('tail', 0, 120, 230)];
    const config = { moduleLengthMm: 70, moduleWidthMm: 15, edgeMarginMm: 6, freeGapMm: 6, maxLanes: 2 };
    const before = JSON.stringify(input);
    const filtered = filterPartitionsForBody(input, [region], { x: 1, y: 1 }, config);
    const check = (candidate: typeof input[number]) => {
      const line = pathPolyline(candidate, { x: 1, y: 1 });
      let fits = false;
      for (let at = 35; at <= line.length - 35; at += 0.1) {
        const body = makeRectangle(line, at, 70, 15);
        if (body && insideRegion(body, { outer: region.outer, holes: region.holes, inner: null }, 6)) { fits = true; break; }
      }
      return { id: candidate.id, length: line.length, fits, first: line.points[0].x };
    };
    // Physical length uses both SVG axes, rather than the raw SVG-unit length.
    const shortScaled = filterPartitionsForBody([input[1]], [region], { x: 0.5, y: 1 }, { ...config, moduleLengthMm: 20 });
    return { unchanged: before === JSON.stringify(input), paths: filtered.map(check), shortScaled: shortScaled.length };
  });
  const paths = result.paths as Array<{ id: string; length: number; fits: boolean; first: number }>;
  expect(result.unchanged).toBe(true);
  expect(paths.some(path => path.id === 'valid')).toBe(true);
  expect(paths.some(path => /short|narrow|hole/.test(path.id))).toBe(false);
  const tail = paths.find(path => path.id.startsWith('tail'))!;
  expect(tail.first).toBeGreaterThanOrEqual(6);
  expect(result.shortScaled).toBe(0);
  for (const path of paths) { expect(path.length).toBeGreaterThanOrEqual(69.99999); expect(path.fits).toBe(true); }
});

test('body filter preserves a usable closed guide across its seam', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(enginePath);
    const model = parseSvg('<svg viewBox="0 0 300 300"><path fill-rule="evenodd" d="M290 150A140 140 0 1 1 10 150A140 140 0 1 1 290 150Z M210 150A60 60 0 1 1 90 150A60 60 0 1 1 210 150Z"/></svg>');
    const skeleton = generateSkeleton(model, { widthMm: 300, heightMm: 300 });
    const filtered = generatePartitions(skeleton);
    return filtered.paths.map((path: { closed: boolean; d: string }) => ({ closed: path.closed, d: path.d }));
  });
  expect(result.length).toBeGreaterThan(0);
  expect(result.every((path: { closed: boolean; d: string }) => path.closed && /Z$/i.test(path.d))).toBe(true);
});
