import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

for (const size of ['medio', 'grande', 'extra_grande']) {
  test(`SAINT ${size} keeps physical row gaps and combines central tips with paired lanes`, async ({ page }) => {
    test.setTimeout(90000);
    await page.goto('/');
    const source = readFileSync(new URL(`./fixtures/SAINT_gotico_${size}.svg`, import.meta.url), 'utf8');
    const result = await page.evaluate(async source => {
      const enginePath = '/src/engine/index.ts', distributionPath = '/src/engine/distribution.ts';
      const { parseSvg, generateSkeleton, generatePartitions, distributeLeds, planSerpent, serpentScope } = await import(enginePath);
      const { rectangleGap, insideRegion, pathPolyline } = await import(distributionPath);
      const model = parseSvg(source), { widthMm, heightMm } = model.physicalSize;
      const measurements = { lengthMm: 70, widthMm: 15, leftPigtailMm: 30, rightPigtailMm: 30 };
      const skeleton = generateSkeleton(model, { widthMm, heightMm });
      const partitions = generatePartitions(skeleton, { moduleLengthMm: 70, moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
      const distribution = distributeLeds(model, partitions, measurements, widthMm, heightMm, { minimumGapMm: 30, maximumGapMm: 60, bodyGapMm: 6, edgeMarginMm: 6 });
      const rectangles = distribution.modules.map((m: { corners: Array<{ x: number; y: number }>; center: { x: number; y: number } }) => {
        const tangent = { x: (m.corners[1].x - m.corners[0].x) / 70, y: (m.corners[1].y - m.corners[0].y) / 70 };
        return { center: m.center, corners: m.corners, tangent, normal: { x: -tangent.y, y: tangent.x }, halfLength: 35, halfWidth: 7.5 };
      });
      let minBodyGap = Infinity, minRowGap = Infinity, maxRunGap = 0;
      for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
        const gap = rectangleGap(rectangles[i], rectangles[j]); minBodyGap = Math.min(minBodyGap, gap);
        if (distribution.modules[i].divisionId === distribution.modules[j].divisionId) minRowGap = Math.min(minRowGap, gap);
      }
      const inside = rectangles.every((rectangle: unknown, i: number) => {
        const region = partitions.regions.find((r: { id: string }) => r.id === distribution.modules[i].regionId);
        return insideRegion(rectangle, { outer: region.outer, inner: null, holes: region.holes }, 6);
      });
      const central = distribution.modules.filter((module: { divisionId: string }) => partitions.paths.find((path: { id: string }) => path.id === module.divisionId).lane === 0).length;
      const centralTips = distribution.modules.filter((module: { divisionId: string }) => {
        const path = partitions.paths.find((p: { id: string }) => p.id === module.divisionId);
        const edge = skeleton.edges.find((e: { id: string }) => e.id === path.sourceEdgeId);
        return path.lane === 0 && skeleton.nodes.some((node: { id: string; kind: string }) => node.kind === 'end' && (node.id === edge.from || node.id === edge.to));
      }).length;
      for (const run of distribution.routeRuns) for (let i = 1; i < run.moduleIds.length; i++) {
        const a = distribution.modules.findIndex((module: { id: string }) => module.id === run.moduleIds[i - 1]);
        const b = distribution.modules.findIndex((module: { id: string }) => module.id === run.moduleIds[i]);
        maxRunGap = Math.max(maxRunGap, rectangleGap(rectangles[a], rectangles[b]));
      }
      const snakes = [...new Set(distribution.modules.map(serpentScope))].map(scopeId => {
        const snake = planSerpent(model, partitions, distribution, measurements, widthMm, heightMm, { scopeId });
        return { steps: snake.steps.length, links: snake.links.length, breaks: snake.breaks.length, continuous: snake.continuous,
          valid: snake.links.every((link: { lengthMm: number; kind: string; bridgeLengthMm: number }) => link.lengthMm <= 60.000001 && link.kind === 'pigtail' && link.bridgeLengthMm === 0) };
      });
      const minPartitionLength = Math.min(...partitions.paths.map((path: unknown) => pathPolyline(path, skeleton.scale).length));
      const minRunLength = Math.min(...distribution.routeRuns.map((run: unknown) => pathPolyline(run, skeleton.scale).length));
      const allFiltered = partitions.paths.every((path: { bodyFiltered: boolean }) => path.bodyFiltered);
      return { total: distribution.total, central, centralTips, paired: distribution.total - central, minBodyGap, minRowGap, maxRunGap, inside, breaks: distribution.rowBreaks, snakes, minPartitionLength, minRunLength, allFiltered };
    }, source);
    expect(result.total).toBeGreaterThan(10);
    expect(result.inside).toBe(true);
    expect(result.minBodyGap).toBeGreaterThanOrEqual(5.9999);
    expect(result.minRowGap).toBeGreaterThanOrEqual(29.9999);
    expect(result.central).toBeGreaterThan(0);
    expect(result.centralTips).toBeGreaterThan(0);
    expect(result.maxRunGap).toBeLessThanOrEqual(60.0001);
    expect(result.allFiltered).toBe(true);
    expect(result.minPartitionLength).toBeGreaterThanOrEqual(69.9999);
    expect(result.minRunLength).toBeGreaterThanOrEqual(69.9999);
    if (size !== 'medio') expect(result.paired).toBeGreaterThan(0);
    for (const gap of result.breaks) expect(gap.gapMm).toBeGreaterThan(60);
    for (const snake of result.snakes) {
      expect(snake.valid).toBe(true);
      expect(snake.links + snake.breaks).toBe(snake.steps - 1);
      expect(snake.continuous).toBe(snake.breaks === 0);
    }
  });
}
