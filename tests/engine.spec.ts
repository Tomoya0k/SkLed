import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { SvgModel } from '../src/engine/types';

const svg = (body: string, attrs = 'viewBox="0 0 500 400"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

async function parse(page: Page, source: string): Promise<SvgModel> {
  return page.evaluate(async source => {
    const modulePath = '/src/engine/index.ts';
    return (await import(modulePath)).parseSvg(source);
  }, source);
}

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('normalizes SVG primitives without flattening curves', async ({ page }) => {
  const model = await parse(page, svg(`
    <rect x="10" y="20" width="30" height="40"/>
    <rect x="50" y="20" width="30" height="40" rx="5"/>
    <circle cx="120" cy="50" r="10"/>
    <ellipse cx="160" cy="50" rx="20" ry="10"/>
    <line x1="0" y1="0" x2="30" y2="40"/>
    <polyline points="0,0 30,0 30,40"/>
    <polygon points="0,0 30,0 30,40"/>
  `));
  expect(model.figures).toHaveLength(7);
  expect(model.figures[0].length).toBeCloseTo(140, 4);
  expect(model.figures[1].d).toContain('A');
  expect(model.figures[1].length).toBeCloseTo(100 + 10 * Math.PI, 1);
  expect(model.figures[2].length).toBeCloseTo(20 * Math.PI, 1);
  expect(model.figures[3].d).toContain('A');
  expect(model.figures[4].length).toBeCloseTo(50, 5);
  expect(model.figures[5].length).toBeCloseTo(70, 5);
  expect(model.figures[5].contours[0].closed).toBe(false);
  expect(model.figures[6].length).toBeCloseTo(120, 5);
});

test('splits compound paths and relative moveto without bridging holes', async ({ page }) => {
  const model = await parse(page, svg('<path fill-rule="evenodd" d="m10 10h100v100h-100z m20 20h60v60h-60z M300 200 l30 40"/>'));
  expect(model.figures).toHaveLength(1);
  expect(model.figures[0].contours).toHaveLength(3);
  expect(model.figures[0].contours.map(c => c.length)).toEqual([400, 240, 50]);
  expect(model.figures[0].contours[1].start).toEqual({ x: 30, y: 30 });
  expect(model.figures[0].length).toBe(690);
  expect(model.figures[0].fillRule).toBe('evenodd');
});

test('nested transforms preserve arcs under nonuniform scale and reflection', async ({ page }) => {
  const model = await parse(page, svg('<g transform="translate(100 50)"><g transform="scale(-2 3)"><circle cx="0" cy="0" r="10"/></g></g>'));
  const figure = model.figures[0];
  expect(figure.d).toContain('A');
  expect(figure.bounds.x).toBeCloseTo(80, 3);
  expect(figure.bounds.y).toBeCloseTo(20, 3);
  expect(figure.bounds.width).toBeCloseTo(40, 3);
  expect(figure.bounds.height).toBeCloseTo(60, 3);
});

test('keeps cubic/quadratic and smooth curves through affine transforms', async ({ page }) => {
  const model = await parse(page, svg('<path transform="translate(10 20) scale(2)" d="M0 0 C10 20 20 20 30 0 S50 -20 60 0 Q70 20 80 0 T100 0"/>'));
  const contour = model.figures[0].contours[0];
  expect(contour.start).toEqual({ x: 10, y: 20 });
  expect(contour.end).toEqual({ x: 210, y: 20 });
  expect(contour.d.match(/C/g)).toHaveLength(2);
  expect(contour.d.match(/Q/g)).toHaveLength(2);
  expect(contour.d).not.toMatch(/[ST]/);
});

test('resolves nested viewBoxes, root offsets, units, and percentages', async ({ page }) => {
  const nested = await parse(page, svg('<svg x="20" y="30" width="200" height="100" viewBox="0 0 100 50"><line x2="100" y2="50"/></svg>', 'viewBox="10 20 400 200" width="800" height="400"'));
  expect(nested.figures[0].contours[0].start).toEqual({ x: 20, y: 30 });
  expect(nested.figures[0].contours[0].end).toEqual({ x: 220, y: 130 });
  const units = await parse(page, svg('<rect x="10%" y="10%" width="1in" height="50%"/>', 'width="200" height="100"'));
  expect(units.figures[0].bounds).toEqual({ x: 20, y: 10, width: 96, height: 50 });
});

test('reads complete physical SVG dimensions and keeps the viewBox ratio separate', async ({ page }) => {
  const explicit = await parse(page, svg('<rect width="400" height="200"/>', 'viewBox="0 0 400 200" width="10cm" height="2in"'));
  expect(explicit.physicalSize?.widthMm).toBe(100);
  expect(explicit.physicalSize?.heightMm).toBeCloseTo(50.8, 8);
  expect(explicit.aspectRatio).toBe(2);
  const pixels = await parse(page, svg('<rect width="400" height="200"/>', 'viewBox="0 0 400 200" width="192" height="96px"'));
  expect(pixels.physicalSize?.widthMm).toBeCloseTo(50.8, 8);
  expect(pixels.physicalSize?.heightMm).toBeCloseTo(25.4, 8);
  const missing = await parse(page, svg('<rect width="400" height="200"/>', 'viewBox="0 0 400 200" width="100%" height="100%"'));
  expect(missing.physicalSize).toBeNull();
  expect(missing.aspectRatio).toBe(2);
  const noViewBox = await parse(page, svg('<rect x="10" y="20" width="80" height="40"/>', ''));
  expect(noViewBox.physicalSize).toBeNull();
  expect(noViewBox.aspectRatio).toBe(2);
});

test('retains root transform in output coordinates', async ({ page }) => {
  const model = await parse(page, svg('<line x2="10"/>', 'viewBox="0 0 100 100" transform="translate(10 20) scale(2)"'));
  expect(model.figures[0].contours[0].start).toEqual({ x: 10, y: 20 });
  expect(model.figures[0].contours[0].end).toEqual({ x: 30, y: 20 });
});

test('expands local use and symbol viewports while preserving independent routes', async ({ page }) => {
  const model = await parse(page, svg('<defs><path id="p" d="M0 0h10"/><symbol id="s" viewBox="0 0 10 10"><path d="M0 0h10"/></symbol></defs><use href="#p" x="20" y="30"/><use href="#p" x="70"/><use href="#s" x="100" y="30" width="20" height="20"/>'));
  expect(model.figures).toHaveLength(3);
  expect(model.figures[0].contours[0].start).toEqual({ x: 20, y: 30 });
  expect(model.figures[1].contours[0].start).toEqual({ x: 70, y: 0 });
  expect(model.figures[2].contours[0].start).toEqual({ x: 100, y: 30 });
  expect(model.figures[2].length).toBe(20);
  expect(new Set(model.figures.map(f => f.id)).size).toBe(3);
});

test('ignores definitions and hidden geometry, scopes styles, and measures visible paths', async ({ page }) => {
  const before = await page.locator('body').evaluate(node => getComputedStyle(node).display);
  const model = await parse(page, svg('<style>body {display:none} path {display:none} .visible {display:inline}</style><defs><rect width="90" height="90"/></defs><path d="M0 0H10"/><path class="visible" d="M20 10H70"/><g display="none"><circle r="10"/></g><line visibility="hidden" x2="20"/>'));
  expect(model.figures).toHaveLength(1);
  expect(model.figures[0].length).toBe(50);
  expect(model.figures[0].bounds.width).toBe(50);
  expect(await page.locator('body').evaluate(node => getComputedStyle(node).display)).toBe(before);
});

test('rejects malformed XML, invalid paths, recursive uses, and clipping', async ({ page }) => {
  for (const source of [
    '<svg><path></svg>',
    svg('<path d="M 10 potato"/>'),
    svg('<defs><g id="p"><use href="#p"/></g></defs><use href="#p"/>'),
    svg('<rect width="10" height="10" clip-path="url(#clip)"/>'),
    svg('<rect width="10" height="10"/>', 'viewBox="0 0 0 100"'),
  ]) {
    await expect(parse(page, source)).rejects.toThrow();
  }
  expect(await page.locator('body > div').count()).toBe(1);
});

test('strips active content and external references before attaching the SVG', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('example.invalid')) requests.push(request.url()); });
  const model = await parse(page, svg('<script>window.svgExecuted=true</script><foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="https://example.invalid/x"/></foreignObject><image href="https://example.invalid/a.png"/><rect onload="window.svgExecuted=true" width="10" height="20" fill="url(https://example.invalid/a.svg)"/>'));
  expect(model.figures).toHaveLength(1);
  expect(model.warnings.length).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).svgExecuted)).toBeUndefined();
  expect(requests).toEqual([]);
});
