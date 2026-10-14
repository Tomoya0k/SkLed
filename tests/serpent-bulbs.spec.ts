import { test, expect } from '@playwright/test';

test('paired lanes close with a transverse cap before meeting the residual skeleton', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const modulePath = '/src/engine/serpent-guides.ts';
    const { composeSerpentGuides } = await import(modulePath);
    return [0, Math.PI / 5].map(angle => {
      const scale = { x: 2, y: 0.5 };
      const physical = (x: number, y: number) => ({ x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) });
      const svg = (x: number, y: number) => { const p = physical(x, y); return { x: p.x / scale.x, y: p.y / scale.y }; };
      const region = { id: 'region', figureId: 'figure', outerContourId: 'outer', holeContourIds: [], holes: [],
        outer: [svg(-10, -100), svg(1210, -100), svg(1210, 100), svg(-10, 100)] };
      const skeleton = { units: 'mm', scale, resolution: 1, warnings: [], regions: [region],
        nodes: [{ id: 'start', kind: 'end', radius: 100 }, { id: 'end', kind: 'end', radius: 100 }],
        edges: [{ id: 'edge', regionId: 'region', figureId: 'figure', from: 'start', to: 'end', closed: false,
          points: [physical(0, 0), physical(1200, 0)] }] };
      const paths = [-1, 1].map(lane => ({ id: `lane${lane}`, regionId: 'region', figureId: 'figure', sourceEdgeId: 'edge',
        sourceRange: [100, 1100], sourceSpans: [{ edgeId: 'edge', from: 100, to: 1100 }], lane, closed: false,
        points: [svg(100, lane * 40), svg(1100, lane * 40)] }));
      const before = JSON.stringify(paths);
      const output = composeSerpentGuides(skeleton, { paths, regions: [region], pairs: 1, warnings: [] });
      const lanes = output.paths.filter((p: any) => p.origin === 'partition');
      const joins = lanes.flatMap((p: any) => [[p.points[0], p.points[1]], [p.points.at(-1), p.points.at(-2)]]);
      return { laneCount: lanes.length, unchangedInput: before === JSON.stringify(paths),
        // The cap tangent must cross the skeleton, not follow it into a Y.
        axialFractions: joins.map(([a, b]: any[]) => {
          const dx = (b.x - a.x) * scale.x, dy = (b.y - a.y) * scale.y;
          return Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) / Math.hypot(dx, dy);
        }), sharedCaps: [0, -1].map(index => {
          const a = lanes[0].points.at(index), b = lanes[1].points.at(index);
          return Math.hypot(a.x - b.x, a.y - b.y);
        }) };
    });
  });
  for (const result of results) {
    expect(result.laneCount).toBe(2);
    expect(result.unchangedInput).toBe(true);
    for (const distance of result.sharedCaps) expect(distance).toBeLessThan(1e-6);
    for (const fraction of result.axialFractions) expect(fraction).toBeLessThan(0.1);
  }
});

test('brief paired widening restores a continuous centerline, long lanes remain', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/serpent-guides.ts';
    const { composeSerpentGuides } = await import(modulePath);
    const region = { id: 'region', figureId: 'figure', outerContourId: 'outer', holeContourIds: [], holes: [],
      outer: [{x:-10,y:-100},{x:1210,y:-100},{x:1210,y:100},{x:-10,y:100}] };
    const skeleton = { units:'mm', scale:{x:1,y:1}, resolution:1, warnings:[], regions:[region],
      nodes:[{id:'start',kind:'end',radius:100},{id:'end',kind:'end',radius:100}],
      edges:[{id:'edge',regionId:'region',figureId:'figure',from:'start',to:'end',closed:false,points:[{x:0,y:0},{x:1200,y:0}],d:'M0 0L1200 0'}] };
    const run = (from: number, to: number) => {
      const paths = [-1,1].map(lane => ({id:`lane${lane}`,regionId:'region',figureId:'figure',sourceEdgeId:'edge',
        sourceRange:[from,to],sourceSpans:[{edgeId:'edge',from,to}],lane,closed:false,
        points:[{x:from,y:lane*40},{x:to,y:lane*40}],d:`M${from} ${lane*40}L${to} ${lane*40}`}));
      const output = composeSerpentGuides(skeleton, {paths,regions:[region],pairs:1,warnings:[]});
      return {parts:output.paths.filter((p:any)=>p.origin==='partition').length,
        remaining:output.paths.filter((p:any)=>p.origin==='skeleton').map((p:any)=>p.sourceRange)};
    };
    return { short:run(500,600), oval:run(400,790), long:run(100,1100), open:run(0,100) };
  });
  expect(result.short).toEqual({parts:0,remaining:[[0,1200]]});
  expect(result.oval).toEqual({parts:0,remaining:[[0,1200]]});
  expect(result.long.parts).toBe(2);
  expect(result.long.remaining).toEqual([[0,100],[1100,1200]]);
  expect(result.open.parts).toBe(2);
});
