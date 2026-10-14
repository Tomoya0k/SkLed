import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('Medical M keeps paired lanes on both sides after spur pruning at 2150 by 300 cm', async ({ page }) => {
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/medical-m.svg', import.meta.url), 'utf8');
  const result = await page.evaluate(async source => {
    const enginePath = '/src/engine/index.ts', filterPath = '/src/engine/skeleton-filter.ts';
    const { parseSvg, generateSkeleton, generatePartitions, composeSerpentGuides } = await import(enginePath);
    const { filterSkeletonSpurs } = await import(filterPath);
    const model = parseSvg(source);
    const skeleton = filterSkeletonSpurs(generateSkeleton(model, { widthMm: 21500, heightMm: 3000 }));
    const parts = generatePartitions(skeleton, { minimumSectionWidthMm: 100 });
    const output = composeSerpentGuides(skeleton, parts);
    const lanes = output.paths.filter((p: any) => p.origin === 'partition');
    const sides = [0, 0];
    for (const lane of lanes) {
      const centerX = lane.points.reduce((sum: number, point: any) => sum + point.x, 0) / lane.points.length;
      sides[centerX < 1248 ? 0 : 1]++;
    }
    return { candidates: parts.paths.length, retained: lanes.length, sides,
      contours: model.figures.flatMap((f: any) => f.contours.map((c: any) => c.d)),
      guides: output.paths.map((p: any) => p.d) };
  }, source);
  expect(result.candidates).toBe(8);
  expect(result.retained).toBe(8);
  expect(result.sides).toEqual([4, 4]);
  await page.setContent(`<style>body{margin:0;background:#08160f;color:#d9f5df;font:18px sans-serif}p{padding:0 24px}svg{height:930px;width:100%}path{fill:none;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}</style><p>Medical · M · dibujo completo a 2150 × 300 cm · cierre de partidas</p><svg viewBox="-100 -20 2700 2600">${result.contours.map((d: string) => `<path d="${d}" stroke="#59ff91" stroke-width="2"/>`).join('')}${result.guides.map((d: string) => `<path d="${d}" stroke="#ff83c6" stroke-width="2"/>`).join('')}</svg>`);
  await page.screenshot({ path: 'test-results/medical-m-caps.png' });
});

for (const minimum of [0, 100, 140, 10000]) test(`serpent replaces only partition source intervals at ${minimum} mm`, async ({ page }) => {
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/01-letras-3d.svg', import.meta.url), 'utf8');
  const result = await page.evaluate(async ({ source, minimum }) => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, composeSerpentGuides } = await import(enginePath);
    const filterPath = '/src/engine/skeleton-filter.ts';
    const { usefulSkeletonEdges } = await import(filterPath);
    const model = parseSvg(source);
    const skeleton = generateSkeleton(model, { widthMm: 3600, heightMm: 1260 });
    const parts = generatePartitions(skeleton, { minimumSectionWidthMm: minimum });
    const combined = composeSerpentGuides(skeleton, parts);
    const residuals = combined.paths.filter((p: any) => p.origin === 'skeleton');
    const retainedParts = parts.paths.filter((part: any) => combined.paths.some((p: any) => p.origin === 'partition' && p.id === part.id));
    const errors: string[] = [];
    let coveredTotal = 0, remainingTotal = 0;
    const usefulEdges = usefulSkeletonEdges(skeleton);
    for (const edge of usefulEdges) {
      const points = edge.closed ? [...edge.points, edge.points[0]] : edge.points;
      const length = points.slice(1).reduce((sum: number, b: any, i: number) => sum + Math.hypot(b.x - points[i].x, b.y - points[i].y), 0);
      const spans = retainedParts.flatMap((p: any) => p.sourceSpans).filter((span: any) => span.edgeId === edge.id).sort((a: any, b: any) => a.from - b.from);
      const merged: number[][] = [];
      for (const span of spans) {
        if (span.from < -1e-6 || span.to > length + 1e-6) errors.push(`Invalid source interval: ${edge.id}`);
        const last = merged.at(-1);
        if (last && span.from <= last[1]) last[1] = Math.max(last[1], span.to);
        else merged.push([span.from, span.to]);
      }
      const remaining = residuals.filter((p: any) => p.sourceEdgeId === edge.id);
      let residualLength = 0;
      for (const path of remaining) {
        const [from, to] = path.sourceRange;
        if (merged.some(([a, b]) => Math.min(b, to) - Math.max(a, from) > 1e-6)) errors.push(`Overlap: ${edge.id}`);
        // Validate actual output geometry, not just its bookkeeping.
        const line = path.closed ? [...path.points, path.points[0]] : path.points;
        const physicalLength = line.slice(1).reduce((sum: number, b: any, i: number) => sum + Math.hypot((b.x - line[i].x) * skeleton.scale.x, (b.y - line[i].y) * skeleton.scale.y), 0);
        if (Math.abs(physicalLength - (to - from)) > 1e-5) errors.push(`Wrong residual geometry: ${edge.id}`);
        residualLength += physicalLength;
      }
      const covered = merged.reduce((sum, [from, to]) => sum + to - from, 0);
      if (Math.abs(length - covered - residualLength) > 1e-5) errors.push(`Missing source length: ${edge.id}`);
      coveredTotal += covered; remainingTotal += residualLength;
    }
    return { errors, coveredTotal, remainingTotal,
      partitionPaths: parts.paths.map((p: any) => p.d),
      openPartitionCount: retainedParts.filter((p: any) => !p.closed).length,
      preservedPartitions: retainedParts.every((part: any) => {
        const output = combined.paths.find((p: any) => p.id === part.id)!;
        return output.origin === 'partition' && output.closed === part.closed &&
          JSON.stringify(output.sourceSpans) === JSON.stringify(part.sourceSpans);
      }),
      removedCorners: skeleton.edges.length - usefulEdges.length,
      attachedEnds: combined.paths.filter((p: any) => p.origin === 'partition' && !p.closed).flatMap((p: any) => [p.points[0], p.points.at(-1)]).filter((point: any) => residuals.some((p: any) => [p.points[0], p.points.at(-1)].some((end: any) => Math.hypot(point.x - end.x, point.y - end.y) < 1e-6))).length,
      hasJoinedSources: parts.paths.some((p: any) => new Set(p.sourceSpans.map((s: any) => s.edgeId)).size > 1),
      skeletonCount: usefulEdges.length, remainingCount: residuals.length,
      contours: model.figures.flatMap((f: any) => f.contours.map((c: any) => c.d)),
      guides: combined.paths.map((p: any) => p.d) };
  }, { source, minimum });
  expect(result.errors).toEqual([]);
  expect(result.preservedPartitions).toBe(true);
  expect(result.removedCorners).toBeGreaterThan(0);
  expect(result.remainingTotal).toBeGreaterThan(0);
  if (minimum === 10000) {
    expect(result.partitionPaths).toHaveLength(0);
    expect(result.coveredTotal).toBe(0);
    expect(result.remainingCount).toBe(result.skeletonCount);
  } else {
    expect(result.coveredTotal).toBeGreaterThan(0);
    // Closed cycles have no residual endpoints to attach. The explicit paired
    // lane regression covers the transverse joins independently of this fixture.
    if (result.openPartitionCount) expect(result.attachedEnds).toBeGreaterThan(0);
    else expect(result.attachedEnds).toBe(0);
    if (minimum === 0) expect(result.hasJoinedSources).toBe(true);
  }
  if (minimum === 0 || minimum === 100 || minimum === 140) {
    await page.setContent(`<style>body{margin:0;background:#08160f}svg{width:100%;height:auto}path{fill:none;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}</style><svg viewBox="0 0 1200 420">${result.contours.map((d: string) => `<path d="${d}" stroke="#59ff91" stroke-width="2"/>`).join('')}${result.guides.map((d: string) => `<path d="${d}" stroke="#ff83c6" stroke-width="1.8"/>`).join('')}</svg>`);
    await page.screenshot({ path: `test-results/serpent-composite-${minimum}.png` });
  }
});

test('a closed skeleton is completely replaced and nearby regions stay independent', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, composeSerpentGuides } = await import(enginePath);
    const filterPath = '/src/engine/skeleton-filter.ts';
    const { usefulSkeletonEdges } = await import(filterPath);
    const model = parseSvg('<svg viewBox="0 0 450 200"><path fill-rule="evenodd" d="M0 0H200V200H0Z M60 60H140V140H60Z"/><path d="M210 0H230V200H210Z"/></svg>');
    const skeleton = generateSkeleton(model, { widthMm: 900, heightMm: 200 });
    const partitions = generatePartitions(skeleton, { minimumSectionWidthMm: 25 });
    const combined = composeSerpentGuides(skeleton, partitions);
    const coveredEdges = new Set(partitions.paths.flatMap((p: any) => p.sourceSpans.map((s: any) => s.edgeId)));
    return {
      parts: partitions.paths.length,
      closedParts: partitions.paths.filter((p: any) => p.closed).length,
      replacedResiduals: combined.paths.filter((p: any) => p.origin === 'skeleton' && coveredEdges.has(p.sourceEdgeId)).length,
      narrowSkeleton: usefulSkeletonEdges(skeleton).filter((p: any) => p.figureId === model.figures[1].id).length,
      narrowResiduals: combined.paths.filter((p: any) => p.origin === 'skeleton' && p.figureId === model.figures[1].id).length,
    };
  });
  expect(result.closedParts).toBe(2);
  expect(result.parts).toBe(2);
  expect(result.replacedResiduals).toBe(0);
  expect(result.narrowResiduals).toBe(result.narrowSkeleton);
  expect(result.narrowResiduals).toBeGreaterThan(0);
});
