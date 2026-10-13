import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const eps = readFileSync(new URL('./fixtures/vector-design.eps', import.meta.url));

test('imports EPS vectors, holes, curves and physical dimensions into the normal layers', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG o EPS').setInputFiles({ name: 'diseño.EPS', mimeType: 'application/postscript', buffer: eps });
  await expect(page.getByText('diseño.EPS', { exact: true })).toBeVisible({ timeout: 25000 });
  await expect(page.locator('.notice.error')).toHaveCount(0);
  await expect(page.getByLabel('Ancho del SVG', { exact: true })).toHaveValue('13');
  await expect(page.getByLabel('Alto del SVG', { exact: true })).toHaveValue('7');
  await expect(page.locator('.figure-hit')).toHaveCount(2);
  await expect(page.locator('[data-contour]')).toHaveCount(3);
  await page.getByRole('checkbox', { name: 'SKELETON', exact: true }).check();
  await expect(page.locator('[data-skeleton-edge]').first()).toBeAttached();
  await page.getByRole('checkbox', { name: 'RECORRIDO SERPIENTE', exact: true }).check();
  await expect(page.locator('[data-serpent-guide]').first()).toBeAttached();
  await page.locator('.figure-hit').first().scrollIntoViewIfNeeded();
  const ring = await page.locator('.figure-hit').first().boundingBox();
  await page.mouse.click(ring!.x + ring!.width * 0.2, ring!.y + ring!.height / 2);
  await expect(page.locator('[data-dimension="width"] text')).toHaveText('3 cm');
});

test('accepts binary EPS preview wrappers and bounding boxes in the trailer', async ({ page }) => {
  const source = Buffer.from(eps.toString().replace('%%BoundingBox: 10 20 370 200', '%%BoundingBox: (atend)').replace('%%HiResBoundingBox: 10.0 20.0 370.0 200.0', '').replace('%%EOF', '%%Trailer\n%%BoundingBox: 10 20 370 200\n%%EOF'));
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0xc6d3d0c5, 0); header.writeUInt32LE(30, 4); header.writeUInt32LE(source.length, 8);
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG o EPS').setInputFiles({ name: 'preview.eps', mimeType: 'application/octet-stream', buffer: Buffer.concat([header, source]) });
  await expect(page.getByText('preview.eps', { exact: true })).toBeVisible({ timeout: 25000 });
  await expect(page.getByLabel('Ancho del SVG', { exact: true })).toHaveValue('13');
  await expect(page.locator('.figure-hit')).toHaveCount(2);
});

test('a broken EPS preserves the current drawing and the next SVG still loads', async ({ page }) => {
  await page.goto('/');
  const upload = page.getByLabel('Cargar archivo SVG o EPS');
  await upload.setInputFiles('tests/fixtures/01-letras-3d.svg');
  await expect(page.locator('.figure-hit')).toHaveCount(4);
  await upload.setInputFiles({ name: 'broken.eps', mimeType: 'application/postscript', buffer: Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nthis_operator_does_not_exist\nshowpage') });
  await expect(page.locator('.notice.error')).toContainText('No se pudo interpretar el EPS', { timeout: 25000 });
  await expect(page.locator('.figure-hit')).toHaveCount(4);
  await upload.setInputFiles({ name: 'next.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg viewBox="0 0 100 100"><rect width="100" height="100"/></svg>') });
  await expect(page.getByText('next.svg', { exact: true })).toBeVisible();
  await expect(page.locator('.notice.error')).toHaveCount(0);
  await expect(page.locator('.figure-hit')).toHaveCount(1);
});

test('dragging an EPS converts text to measurable outlines and closes filled curves', async ({ page }) => {
  await page.goto('/');
  const source = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 300 100\n/Helvetica findfont 72 scalefont setfont\n10 10 moveto (LED) show\nshowpage\n%%EOF';
  const dataTransfer = await page.evaluateHandle(source => {
    const data = new DataTransfer();
    data.items.add(new File([source], 'letters.eps', { type: 'application/postscript' }));
    return data;
  }, source);
  await page.locator('.canvas-panel').dispatchEvent('drop', { dataTransfer });
  await expect(page.locator('.canvas-corner')).toHaveText('letters.eps', { timeout: 25000 });
  await expect(page.locator('.figure-hit')).toHaveCount(3);
  expect(await page.locator('[data-contour] > path:first-child').evaluateAll(paths => paths.every(path => /z\s*$/i.test(path.getAttribute('d') || '')))).toBe(true);
  await expect(page.locator('.notice.error')).toHaveCount(0);
});
