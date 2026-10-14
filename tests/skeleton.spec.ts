import { test, expect } from '@playwright/test';

test('near-identical raster paths at a junction collapse while real spans and cycles remain', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const skeletonModulePath = '/src/engine/skeleton.ts';
    const { deduplicateRasterEdges } = await import(skeletonModulePath);
    const edge = (id: string, from: string, to: string, points: Array<{x:number;y:number}>, closed = false) => ({
      id, regionId: 'r', figureId: 'f', from, to, points, closed, d: '',
    });
    const edges = [
      edge('centerline-a', 'j1', 'j2', [{x:0,y:0},{x:5,y:2},{x:10,y:0}]),
      edge('centerline-b', 'j2', 'j1', [{x:10,y:0},{x:5,y:1},{x:0,y:0}]),
      edge('separate-span', 'j1', 'j2', [{x:0,y:0},{x:5,y:8},{x:10,y:0}]),
      edge('cycle', 'j3', 'j3', [{x:0,y:0},{x:4,y:4},{x:0,y:0}], true),
    ];
    return deduplicateRasterEdges(edges, 2).map((item: {id:string}) => item.id);
  });
  expect(result).toEqual(['centerline-b', 'separate-span', 'cycle']);
});

test('duplicate fill and stroke boundaries retain holes without solid skeleton overlays', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const enginePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton } = await import(enginePath);
    const ring = 'M180 100 A80 80 0 1 1 20 100 A80 80 0 1 1 180 100 Z M150 100 A50 50 0 1 1 50 100 A50 50 0 1 1 150 100 Z';
    const rect = 'M220 20H380V180H220Z M250 50H350V150H250Z';
    // The rectangle duplicate uses a different starting vertex and winding.
    const reversed = 'M380 180V20H220V180Z M350 150V50H250V150Z';
    const make = (extra: string) => generateSkeleton(parseSvg(`<svg viewBox="0 0 400 200"><path d="${ring}"/><path d="${rect}"/>${extra}</svg>`), { widthMm: 400, heightMm: 200 });
    const plain = make('');
    const duplicate = make(`<path fill="none" stroke="black" d="${ring}"/><path fill="none" stroke="black" d="${reversed}"/>`);
    return {
      holes: duplicate.regions.map((r: any) => r.holes.length),
      points: duplicate.nodes.filter((n: any) => n.kind === 'point').length,
      geometry: duplicate.edges.map((e: any) => e.d), original: plain.edges.map((e: any) => e.d),
    };
  });
  expect(result.holes).toEqual([1, 1]);
  expect(result.points).toBe(0);
  expect(result.geometry).toEqual(result.original);
});

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

test('spur pruning scales with local thickness and keeps cycles and spans between junctions', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const skeletonFilterModule = '/src/engine/skeleton-filter.ts';
    const { filterSkeletonSpurs } = await import(skeletonFilterModule);
    const node = (id: string, kind: string, x: number, y: number, radius: number) => ({
      id, regionId: 'r', figureId: 'f', kind, point: { x, y }, radius,
    });
    const edge = (id: string, from: string, to: string, a: {x:number;y:number}, b: {x:number;y:number}, closed = false) => ({
      id, regionId: 'r', figureId: 'f', from, to, points: [a, b], closed, d: '',
    });
    const nodes = [
      node('thick-junction', 'junction', 0, 0, 30), node('thick-tip', 'end', 50, 0, 0),
      node('thin-junction', 'junction', 100, 0, 5), node('long-tip', 'end', 145, 0, 0),
      node('j3', 'junction', 200, 0, 10), node('j4', 'junction', 220, 0, 10),
      node('j3a', 'end', 200, 20, 0), node('j3b', 'end', 200, -20, 0),
      node('j4a', 'end', 220, 20, 0), node('j4b', 'end', 220, -20, 0),
      node('cycle', 'junction', 300, 0, 10),
    ];
    const edges = [
      edge('short-relative-to-width', 'thick-junction', 'thick-tip', {x:0,y:0}, {x:50,y:0}),
      edge('long-enough-terminal', 'thin-junction', 'long-tip', {x:100,y:0}, {x:145,y:0}),
      edge('junction-span', 'j3', 'j4', {x:200,y:0}, {x:220,y:0}),
      edge('j3-branch-a', 'j3', 'j3a', {x:200,y:0}, {x:200,y:20}),
      edge('j3-branch-b', 'j3', 'j3b', {x:200,y:0}, {x:200,y:-20}),
      edge('j4-branch-a', 'j4', 'j4a', {x:220,y:0}, {x:220,y:20}),
      edge('j4-branch-b', 'j4', 'j4b', {x:220,y:0}, {x:220,y:-20}),
      edge('closed-cycle', 'cycle', 'cycle', {x:300,y:0}, {x:305,y:5}, true),
    ];
    const skeleton = { nodes, edges, regions: [], scale: {x:1,y:1}, units: 'mm', resolution: 1, warnings: [] };
    const filtered = filterSkeletonSpurs(skeleton as any);
    return { retained: filtered.edges.map((item: {id:string}) => item.id), warnings: filtered.warnings };
  });
  expect(result.retained).toContain('long-enough-terminal');
  expect(result.retained).toContain('junction-span');
  expect(result.retained).toContain('closed-cycle');
  expect(result.retained).not.toContain('short-relative-to-width');
  expect(result.retained).not.toContain('j3-branch-a');
  expect(result.retained).not.toContain('j3-branch-b');
  expect(result.warnings.join(' ')).toContain('ajustado al grosor local');
});

test('candidate partidas stay halfway between the skeleton and both local boundaries', async ({ page }) => {
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
    const partitions = generatePartitions(skeleton);
    const modules = { lengthMm: 10, widthMm: 15, leftPigtailMm: 6, rightPigtailMm: 6 };
    const distribution = distributeLeds(model, partitions, modules, 300, 60);
    const connections = connectLeds(model, partitions, distribution, modules, 300, 60);
    return { cycles, unchanged: before === JSON.stringify(skeleton), paths: partitions.paths, total: distribution.total, connected: connections.pigtails.connectedIds.length, discarded: connections.pigtails.discardedIds.length };
  });
  expect(result.unchanged).toBe(true);
  expect(result.cycles).toBe(0);
  const middleLanes = result.paths.filter((p: {lane:number;points:Array<{x:number;y:number}>}) => p.points.some(q => q.x > 140 && q.x < 160));
  expect([...new Set(middleLanes.map((p: {lane:number}) => p.lane))].sort()).toEqual([-1, 1]);
  expect(result.paths.every((p: {lane:number}) => p.lane !== 0)).toBe(true);
  for (const path of result.paths) {
    expect(path.closed, JSON.stringify({id:path.id,points:path.points})).toBe(false);
    expect(path.d).not.toMatch(/Z$/i);
    expect(path.points[0]).not.toEqual(path.points.at(-1));
  }
  expect(result.total).toBeGreaterThan(0);
  expect(result.connected + result.discarded).toBe(result.total);
});

test('rotated stripes produce two midpoint candidates and preserve real square branches', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(modulePath);
    const stripes = [30, 45].flatMap(angle => [47, 49].map(width => {
      const model = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect x="50" y="${200-width/2}" width="300" height="${width}" transform="rotate(${angle} 200 200)"/></svg>`);
      const skeleton = generateSkeleton(model, { widthMm: 400, heightMm: 400 });
      const parts = generatePartitions(skeleton);
      return {angle,width,lanes:[...new Set<number>(parts.paths.map((p:{lane:number})=>p.lane))].sort()};
    }));
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
    const square = generateSkeleton(model,{widthMm:100,heightMm:100});
    return {stripes, squareEnds:square.nodes.filter((n:{kind:string})=>n.kind==='end').length, squareJunctions:square.nodes.filter((n:{kind:string})=>n.kind==='junction').length};
  });
  expect(result.stripes.map((r:{lanes:number[]})=>r.lanes),JSON.stringify(result.stripes)).toEqual([[-1,1],[-1,1],[-1,1],[-1,1]]);
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
    const partitions = generatePartitions(skeleton);
    return { skeleton: skeleton.edges.map((e: {closed:boolean;points:unknown[]}) => ({closed:e.closed,count:e.points.length})), paths: partitions.paths.map((p: {lane:number;closed:boolean;points:Array<{x:number;y:number}>}) => ({lane:p.lane,closed:p.closed,radius:p.points.reduce((sum:number, q:{x:number;y:number})=>sum+Math.hypot(q.x,q.y),0)/p.points.length})) };
  });
  expect(result.paths, JSON.stringify(result)).toHaveLength(2);
  expect(result.paths.every((p: {closed:boolean}) => p.closed)).toBe(true);
  const radii = result.paths.map((p: {radius:number}) => p.radius).sort((a:number,b:number)=>a-b);
  expect(radii[0]).toBeCloseTo(55, 0);
  expect(radii[1]).toBeCloseTo(85, 0);
});

test('multiple holes share region validation and scaling happens before width analysis', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions, distributeLeds } = await import(modulePath);
    const model = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"><path fill-rule="evenodd" d="M0 0H300V120H0Z M60 30H100V90H60Z M200 30H240V90H200Z"/></svg>');
    const skeleton = generateSkeleton(model, { widthMm: 300, heightMm: 120 });
    const partitions = generatePartitions(skeleton);
    const distribution = distributeLeds(model, partitions, { lengthMm: 12, widthMm: 8, leftPigtailMm: 4, rightPigtailMm: 4 }, 300, 120);
    const stripe = parseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 49"><rect width="300" height="49"/></svg>');
    const narrow = generatePartitions(generateSkeleton(stripe, { widthMm: 600, heightMm: 40 }), { minimumSectionWidthMm: 25 });
    const wide = generatePartitions(generateSkeleton(stripe, { widthMm: 600, heightMm: 60 }), { minimumSectionWidthMm: 25 });
    return { regions: skeleton.regions.length, holes: skeleton.regions[0].holes.length, modules: distribution.modules,
      narrow: narrow.paths,wide:wide.paths };
  });
  expect(result.regions).toBe(1); expect(result.holes).toBe(2);
  expect(result.modules.length).toBeGreaterThan(0);
  for (const module of result.modules) for (const p of module.corners) {
    expect((p.x > 60 && p.x < 100 || p.x > 200 && p.x < 240) && p.y > 30 && p.y < 90).toBe(false);
  }
  expect(result.narrow.length).toBe(0); expect(result.wide.length).toBeGreaterThan(0);
});

test('module settings leave the visible skeleton unchanged without a partition layer', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name:'franja.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60" width="300mm" height="60mm"><rect width="300" height="60"/></svg>') });
  await expect(page.getByRole('group',{name:'Capas principales'}).getByRole('checkbox')).toHaveCount(6);
  await page.getByRole('checkbox',{name:'SKELETON',exact:true}).check();
  await expect(page.locator('[data-skeleton-edge]').first()).toBeVisible();
  const skeleton = await page.locator('[data-skeleton-edge]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d')));
  await page.getByLabel('Largo del módulo').fill('1.2');
  await page.getByLabel('Ancho del módulo').fill('1.5');
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('0.4');
  await page.getByRole('spinbutton', { name: 'Pigtail derecho', exact: true }).fill('0.4');
  await page.getByRole('checkbox',{name:'MÓDULOS LED',exact:true}).check();
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
  await expect(page.getByLabel('Máximo de recorridos')).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'Pigtail izquierdo', exact: true }).fill('4.5');
  await expect.poll(() => page.locator('[data-skeleton-edge]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('d'))), { timeout: 15_000 }).toEqual(skeleton);
  await page.getByLabel('Distancia mínima entre skeleton y borde para formar una partida').fill('2');
  await expect(page.locator('[data-partition]')).toHaveCount(0);
  await page.getByRole('checkbox',{name:'SKELETON',exact:true}).uncheck();
  await expect(page.locator('[data-skeleton-edge]')).toHaveCount(0);
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
});

test('minimum local width filters midpoint guide candidates', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/engine/index.ts';
    const { parseSvg, generateSkeleton, generatePartitions } = await import(modulePath);
    return [47, 48, 49].map(width => {
      const model = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 ${width}"><rect width="300" height="${width}"/></svg>`);
      const skeleton = generateSkeleton(model, { widthMm: 300, heightMm: width });
      const partitions = generatePartitions(skeleton);
      const minimumAccepted = generatePartitions(skeleton, { minimumSectionWidthMm: width / 2 - 1 });
      const minimumFiltered = generatePartitions(skeleton, { minimumSectionWidthMm: 1000 });
      return { width,
        paths: partitions.paths.map((p: {lane: number; closed: boolean; points: Array<{x:number;y:number}>}) => ({ lane: p.lane, closed: p.closed, points: p.points })),
        minAcceptedCount: minimumAccepted.paths.length, minFilteredCount: minimumFiltered.paths.length };
    });
  });
  expect(result.every((r: {minAcceptedCount:number;minFilteredCount:number}) => r.minAcceptedCount > 0 && r.minFilteredCount === 0)).toBe(true);
  for (const item of result) {
    expect(item.paths.every((p: {closed:boolean}) => !p.closed)).toBe(true);
    expect(new Set(item.paths.map((p: {lane:number}) => p.lane))).toEqual(new Set([-1, 1]));
    for (const path of item.paths.filter((candidate: {points:Array<{x:number;y:number}>}) => Math.abs(candidate.points.at(-1)!.x - candidate.points[0].x) > 200)) {
      const expectedY = path.lane === -1 ? item.width / 4 : item.width * 3 / 4;
      expect(path.points.filter((point: {x:number}) => point.x > 20 && point.x < 280).every((point: {y:number}) => Math.abs(point.y - expectedY) < 1)).toBe(true);
    }
  }
});
