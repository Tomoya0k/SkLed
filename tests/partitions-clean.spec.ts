import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

for (const minimum of [0, 100]) test(`letter candidates have no crossing or corner spokes at minimum ${minimum} mm`, async ({ page }) => {
  await page.goto('/');
  const source = readFileSync(new URL('./fixtures/01-letras-3d.svg', import.meta.url), 'utf8');
  const result = await page.evaluate(async ({ source, minimum }) => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(enginePath);
    const model = parseSvg(source);
    const skeleton = generateSkeleton(model, { widthMm: 3600, heightMm: 1260 });
    const parts = generatePartitions(skeleton, { minimumSectionWidthMm: minimum });
    const segments = parts.paths.flatMap((path: any) => {
      const points = path.closed ? [...path.points, path.points[0]] : path.points;
      return points.slice(1).map((b: any, i: number) => ({ id: path.id, figureId: path.figureId, a: points[i], b }));
    });
    const crossings: string[] = [];
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      const { a, b } = segments[i], { a: c, b: d } = segments[j];
      if (segments[i].figureId !== segments[j].figureId) continue;
      const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
      const den = ux * vy - uy * vx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / den;
      const s = ((c.x - a.x) * uy - (c.y - a.y) * ux) / den;
      if (t > 1e-5 && t < 1 - 1e-5 && s > 1e-5 && s < 1 - 1e-5) crossings.push(`${segments[i].id}/${segments[j].id}`);
    }
    return { crossings, paths: parts.paths, contours: model.figures.flatMap((f: any) => f.contours.map((c: any) => c.d)), skeleton: skeleton.edges.map((edge: any) => edge.d), firstFigureId: model.figures[0].id };
  }, { source, minimum });
  await page.setContent(`<style>body{margin:0;background:#08160f}svg{width:100%;height:auto}path{fill:none;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}</style><svg viewBox="0 0 1200 420">${result.contours.map((d: string) => `<path d="${d}" stroke="#59ff91" stroke-width="2"/>`).join('')}${result.skeleton.map((d: string) => `<path d="${d}" stroke="#c59bf2" stroke-width="1.3"/>`).join('')}${result.paths.map((p: any) => `<path d="${p.d}" stroke="#ffbd61" stroke-width="1.8"/>`).join('')}</svg>`);
  await page.screenshot({ path: `test-results/partitions-clean-${minimum}.png` });
  expect(result.crossings).toEqual([]);
  const letterD = result.paths.filter((path: any) => path.figureId === result.firstFigureId);
  expect(letterD).toHaveLength(2);
  expect(letterD.every((path: any) => path.closed)).toBe(true);
});
