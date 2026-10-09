import { test, expect } from '@playwright/test';

test('medial graph preserves real branches, a disk point and a ring cycle', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton } = await import(modulePath);
    return ['<rect x="10" y="10" width="180" height="80"/>', '<circle cx="100" cy="100" r="70"/>', '<path fill-rule="evenodd" d="M180 100 A80 80 0 1 1 20 100 A80 80 0 1 1 180 100 Z M150 100 A50 50 0 1 1 50 100 A50 50 0 1 1 150 100 Z"/>'].map(shape => {
      const model = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${shape}</svg>`);
      const skeleton = generateSkeleton(model, { widthMm: 200, heightMm: 200 });
      return { nodes: skeleton.nodes.map((n: {kind: string}) => n.kind), edges: skeleton.edges.map((e: {closed: boolean; points: unknown[]}) => ({ closed: e.closed, points: e.points.length })) };
    });
  });
  expect(results[0].nodes, JSON.stringify(results)).toContain('junction');
  expect(results[0].edges.every((edge: {closed: boolean}) => !edge.closed)).toBe(true);
  expect(results[1].nodes, JSON.stringify(results)).toEqual(['point']);
  expect(results[1].edges).toHaveLength(0);
  expect(results[2].edges.some((edge: {closed: boolean}) => edge.closed), JSON.stringify(results)).toBe(true);
});

test('wide to narrow transitions produce separate open lanes and preserve central skeleton', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, distributeLeds, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60"><path d="M0 15H100V0H200V15H300V45H200V60H100V45H0Z"/></svg>');
    const skeleton = generateSkeleton(model, { widthMm: 300, heightMm: 60 });
    const parents = new Map<string, string>(skeleton.nodes.map((n: {id:string}) => [n.id, n.id]));
    const root = (id: string): string => parents.get(id) === id ? id : root(parents.get(id)!);
    let cycles = 0;
    for (const edge of skeleton.edges) {
      if (!edge.from || !edge.to || root(edge.from) === root(edge.to)) cycles++;
      else parents.set(root(edge.from), root(edge.to));
    }
    const before = JSON.stringify(skeleton);
    const partitions = generatePartitions(skeleton, { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    const modules = { lengthMm: 10, widthMm: 15, leftPigtailMm: 6, rightPigtailMm: 6 };
    const distribution = distributeLeds(model, partitions, modules, 300, 60);
    const connections = connectLeds(model, partitions, distribution, modules, 300, 60);
    return { cycles, unchanged: before === JSON.stringify(skeleton), paths: partitions.paths, total: distribution.total, connected: connections.pigtails.connectedIds.length, discarded: connections.pigtails.discardedIds.length };
  });
  expect(result.unchanged).toBe(true);
  expect(result.cycles).toBe(0);
  expect(result.paths.some((p: {lane:number}) => p.lane === -1)).toBe(true);
  const middleLanes = result.paths.filter((p: {lane:number;points:Array<{x:number;y:number}>}) => p.lane !== 0 && p.points.some(q => q.x > 140 && q.x < 160));
  expect(middleLanes.length).toBeGreaterThanOrEqual(2);
  expect(result.paths.some((p: {lane:number}) => p.lane === 0)).toBe(true);
  for (const path of result.paths) {
    expect(path.closed, JSON.stringify({id:path.id,points:path.points})).toBe(false);
    expect(path.d).not.toMatch(/Z$/i);
    expect(path.points[0]).not.toEqual(path.points.at(-1));
  }
  expect(result.total).toBeGreaterThan(0);
  expect(result.connected + result.discarded).toBe(result.total);
});

test('rotated stripes preserve the physical threshold and real square branches', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(modulePath);
    const stripes = [30, 45].flatMap(angle => [47, 49].map(width => {
      const model = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect x="50" y="${200-width/2}" width="300" height="${width}" transform="rotate(${angle} 200 200)"/></svg>`);
      const skeleton = generateSkeleton(model, { widthMm: 400, heightMm: 400 });
      const parts = generatePartitions(skeleton, { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
      return {angle,width,doubled:parts.paths.some((p:{lane:number})=>p.lane!==0)};
    }));
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
    const square = generateSkeleton(model,{widthMm:100,heightMm:100});
    return {stripes, squareEnds:square.nodes.filter((n:{kind:string})=>n.kind==='end').length, squareJunctions:square.nodes.filter((n:{kind:string})=>n.kind==='junction').length};
  });
  expect(result.stripes.map((r:{doubled:boolean})=>r.doubled),JSON.stringify(result.stripes)).toEqual([false,true,false,true]);
  expect(result.squareEnds).toBe(4); expect(result.squareJunctions).toBeGreaterThanOrEqual(1);
});

test('distribution and connectivity accept a two-point open guide', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, distributeLeds, connectLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40"/></svg>');
    const divisions = { paths: [{ id:'line',figureId:model.figures[0].id,outerContourId:model.figures[0].contours[0].id,innerContourId:'',index:1,fraction:0.5,d:'M20 20 L100 20' }],pairs:0,warnings:[] };
    const measurements = {lengthMm:12,widthMm:5,leftPigtailMm:6,rightPigtailMm:6};
    const distribution = distributeLeds(model,divisions,measurements,120,40);
    const connectivity = connectLeds(model,divisions,distribution,measurements,120,40);
    return {total:distribution.total,connected:connectivity.pigtails.connectedIds.length,links:connectivity.pigtails.links.length};
  });
  expect(result.total).toBeGreaterThan(1); expect(result.connected).toBe(result.total); expect(result.links).toBe(result.total-1);
});

test('wide ring yields two independent natural cycles with balanced physical spacing', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-110 -110 220 220"><path fill-rule="evenodd" d="M100 0 A100 100 0 1 1 -100 0 A100 100 0 1 1 100 0Z M40 0 A40 40 0 1 1 -40 0 A40 40 0 1 1 40 0Z"/></svg>');
    const skeleton = generateSkeleton(model, { widthMm: 220, heightMm: 220 });
    const partitions = generatePartitions(skeleton, { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    return { skeleton: skeleton.edges.map((e: {closed:boolean;points:unknown[]}) => ({closed:e.closed,count:e.points.length})), paths: partitions.paths.map((p: {lane:number;closed:boolean;points:Array<{x:number;y:number}>}) => ({lane:p.lane,closed:p.closed,radius:p.points.reduce((sum:number, q:{x:number;y:number})=>sum+Math.hypot(q.x,q.y),0)/p.points.length})) };
  });
  expect(result.paths, JSON.stringify(result)).toHaveLength(2);
  expect(result.paths.every((p: {closed:boolean}) => p.closed)).toBe(true);
  const radii = result.paths.map((p: {radius:number}) => p.radius).sort((a:number,b:number)=>a-b);
  expect(radii[0]).toBeCloseTo(57.5, 0);
  expect(radii[1]).toBeCloseTo(82.5, 0);
});

test('multiple holes share region validation and scaling happens before width analysis', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, distributeLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"><path fill-rule="evenodd" d="M0 0H300V120H0Z M60 30H100V90H60Z M200 30H240V90H200Z"/></svg>');
    const skeleton = generateSkeleton(model, { widthMm: 300, heightMm: 120 });
    const partitions = generatePartitions(skeleton, { moduleWidthMm: 8, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    const distribution = distributeLeds(model, partitions, { lengthMm: 12, widthMm: 8, leftPigtailMm: 4, rightPigtailMm: 4 }, 300, 120);
    const stripe = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 49"><rect width="300" height="49"/></svg>');
    const narrow = generatePartitions(generateSkeleton(stripe, { widthMm: 600, heightMm: 40 }), { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    const wide = generatePartitions(generateSkeleton(stripe, { widthMm: 600, heightMm: 60 }), { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
    return { regions: skeleton.regions.length, holes: skeleton.regions[0].holes.length, modules: distribution.modules,
      narrow: narrow.paths.some((p:{lane:number})=>p.lane!==0),wide:wide.paths.some((p:{lane:number})=>p.lane!==0) };
  });
  expect(result.regions).toBe(1); expect(result.holes).toBe(2);
  expect(result.modules.length).toBeGreaterThan(0);
  for (const module of result.modules) for (const p of module.corners) {
    expect((p.x > 60 && p.x < 100 || p.x > 200 && p.x < 240) && p.y > 30 && p.y < 90).toBe(false);
  }
  expect(result.narrow).toBe(false); expect(result.wide).toBe(true);
});

test('module settings leave the visible skeleton unchanged without a partition layer', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name:'franja.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60" width="300mm" height="60mm"><rect width="300" height="60"/></svg>') });
  await expect(page.getByRole('group',{name:'Capas principales'}).getByRole('checkbox')).toHaveCount(4);
  await page.getByRole('checkbox',{name:'SKELETON',exact:true}).check();
  await expect(page.locator('[data-skeleton-edge]').first()).toBeVisible();
  const skeleton = await page.locator('[data-skeleton-edge]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d')));
  await page.getByLabel('Largo del módulo').fill('12');
  await page.getByLabel('Ancho del módulo').fill('15');
  await page.getByLabel('Pigtail izquierdo').fill('4');
  await page.getByLabel('Pigtail derecho').fill('4');
  await page.getByRole('checkbox',{name:'MÓDULOS LED',exact:true}).check();
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
  await page.getByLabel('Máximo de recorridos').selectOption('1');
  await page.getByLabel('Máximo de recorridos').selectOption('2');
  await page.getByLabel('Pigtail izquierdo').fill('45');
  expect(await page.locator('[data-skeleton-edge]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d')))).toEqual(skeleton);
  await page.getByLabel('Margen objetivo al borde').fill('20');
  await expect(page.locator('[data-partition]')).toHaveCount(0);
  await page.getByRole('checkbox',{name:'SKELETON',exact:true}).uncheck();
  await expect(page.locator('[data-skeleton-edge]')).toHaveCount(0);
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
});

test('physical 47/48/49 mm stripes split only at the configurable threshold', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(modulePath);
    return [47, 48, 49].map(width => {
      const model = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 ${width}"><rect width="300" height="${width}"/></svg>`);
      const skeleton = generateSkeleton(model, { widthMm: 300, heightMm: width });
      const partitions = generatePartitions(skeleton, { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 2 });
      const limited = generatePartitions(skeleton, { moduleWidthMm: 15, freeGapMm: 6, edgeMarginMm: 6, maxLanes: 1 });
      return { width, threshold: partitions.requiredWidthMm, nodes: skeleton.nodes.length, edges: skeleton.edges.length,
        paths: partitions.paths.map((p: {lane: number; closed: boolean; points: Array<{x:number;y:number}>}) => ({ lane: p.lane, closed: p.closed, points: p.points })), limited: limited.paths.map((p: {lane:number}) => p.lane) };
    });
  });
  expect(result.map((r: {threshold:number}) => r.threshold)).toEqual([48, 48, 48]);
  expect(result.map((r: {paths:Array<{lane:number}>}) => r.paths.some(p => p.lane !== 0)), JSON.stringify(result.map((r: {width:number;nodes:number;edges:number;paths:unknown[]}) => ({width:r.width,nodes:r.nodes,edges:r.edges,paths:r.paths.length})))).toEqual([false, true, true]);
  for (const item of result) {
    expect(item.paths.every((p: {closed:boolean}) => !p.closed)).toBe(true);
    expect(item.limited.every((lane:number) => lane === 0)).toBe(true);
  }
});
