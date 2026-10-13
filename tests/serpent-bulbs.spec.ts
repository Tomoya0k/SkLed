import { test, expect } from '@playwright/test';

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
