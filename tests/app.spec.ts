import { test, expect } from '@playwright/test';

test('starts without example figures and keeps the requested controls out of view', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Capas principales' }).getByRole('checkbox')).toHaveCount(5);
  await expect(page.getByRole('checkbox', { name: 'CONTORNO', exact: true })).toBeChecked();
  await expect(page.locator('.file-section h1')).toContainText('SkLed');
  await expect(page.locator('.brand-icon')).toHaveText('S');
  await expect(page.getByText('Carga un SVG para comenzar')).toBeVisible();
  await expect(page.locator('[data-contour], [data-svg-figure]')).toHaveCount(0);
  await expect(page.locator('header, .figures-section, .zoom-controls, .paste-details, .advanced-layers, .file-info, .electrical-section, .led-summary')).toHaveCount(0);

  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'trazos.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="letra" d="M0 0H10 M20 0H30"/><circle id="aro" cx="50" cy="50" r="10"/></svg>') });
  await expect(page.locator('.canvas-corner')).toHaveText('trazos.svg');
  await expect(page.locator('[data-contour]')).toHaveCount(3);
  await expect(page.locator('[data-svg-figure]')).toHaveCount(0);
  await page.getByLabel('Largo del módulo').fill('5');
  await page.getByLabel('Ancho del módulo').fill('1');
  await page.getByLabel('Pigtail izquierdo').fill('0.8');
  await page.getByLabel('Pigtail derecho').fill('1.2');
  await expect(page.getByLabel('Largo del módulo')).toHaveValue('5');
  await expect(page.getByLabel('Ancho del módulo')).toHaveValue('1');
  await expect(page.getByLabel('Pigtail izquierdo')).toHaveValue('0.8');
  await expect(page.getByLabel('Pigtail derecho')).toHaveValue('1.2');
  await expect(page.locator('.module-segments span').nth(0)).toContainText('Izq. 0.8');
  await expect(page.locator('.module-segments span').nth(1)).toContainText('Módulo 5');
  await expect(page.locator('.module-segments span').nth(2)).toContainText('Der. 1.2');
  await expect(page.getByText(/LEDs|Longitud total|Inspeccionar recorrido/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('rejects bad SVG without losing the previous contours', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'bien.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="50" height="50"/></svg>') });
  await expect(page.locator('[data-contour]')).toHaveCount(1);
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'mal.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg broken') });
  await expect(page.getByRole('alert')).toContainText('no es un SVG válido');
  await expect(page.locator('[data-contour]')).toHaveCount(1);
  await expect(page.locator('.canvas-corner')).toHaveText('bien.svg');
});

test('shows SVG dimensions and measures each selected figure on the drawing', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({
    name: 'dos-figuras.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="400mm" height="200mm"><rect id="primera" x="10" y="20" width="50" height="30"/><rect id="segunda" x="100" y="10" width="40" height="60"/></svg>'),
  });
  await expect(page.locator('[data-dimension="width"]')).toHaveText('40 cm');
  await expect(page.locator('[data-dimension="height"]')).toHaveText('20 cm');
  await expect(page.locator('[data-figure-hit]')).toHaveCount(2);

  await page.locator('[data-figure-hit]').first().click();
  await expect(page.locator('[data-dimension="width"]')).toHaveText('10 cm');
  await expect(page.locator('[data-dimension="height"]')).toHaveText('6 cm');
  await expect(page.locator('[data-selected-figure]')).toHaveCount(1);

  await page.locator('[data-figure-hit]').nth(1).click();
  await expect(page.locator('[data-dimension="width"]')).toHaveText('8 cm');
  await expect(page.locator('[data-dimension="height"]')).toHaveText('12 cm');
  const beforePan = await page.locator('.drawing').getAttribute('viewBox');
  const figureBox = await page.locator('[data-figure-hit]').nth(1).boundingBox();
  if (!figureBox) throw new Error('No se encontró la segunda figura.');
  await page.mouse.move(figureBox.x + figureBox.width / 2, figureBox.y + figureBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(figureBox.x + figureBox.width / 2 + 60, figureBox.y + figureBox.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  expect(await page.locator('.drawing').getAttribute('viewBox')).not.toBe(beforePan);
  await expect(page.locator('[data-dimension="width"]')).toHaveText('8 cm');
  await page.getByLabel('Ancho del SVG').fill('60');
  await expect(page.locator('[data-dimension="width"]')).toHaveText('12 cm');
  await page.getByRole('button', { name: 'Todo el SVG' }).click();
  await expect(page.locator('[data-dimension="width"]')).toHaveText('60 cm');
  await expect(page.locator('[data-dimension="height"]')).toHaveText('30 cm');
});

test('dark canvas and controls fit compact widths', async ({ page }) => {
  for (const width of [390, 290]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole('checkbox', { name: 'CONTORNO', exact: true })).toBeVisible();
    await expect(page.getByLabel('Pigtail izquierdo')).toBeVisible();
    await expect(page.getByLabel('Pigtail derecho')).toBeVisible();
    await expect(page.getByLabel('Ancho del SVG')).toBeVisible();
    await expect(page.getByLabel('Alto del SVG')).toBeVisible();
    await expect(page.locator('.canvas-panel')).toHaveCSS('background-color', 'rgb(1, 7, 3)');
  }
});

test('centimeter dimensions scale both ways with a lock and remain independent when unlocked', async ({ page }) => {
  await page.goto('/');
  const width = page.getByLabel('Ancho del SVG'), height = page.getByLabel('Alto del SVG');
  const lock = page.getByRole('button', { name: 'Mantener proporción', exact: true });
  await expect(width).toHaveValue(''); await expect(height).toHaveValue('');
  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'proporcional.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg viewBox="0 0 360 220"><rect width="360" height="220"/></svg>') });
  await expect(page.locator('[data-dimension="width"]')).toHaveText('360 u SVG');
  await width.fill('36'); await expect(height).toHaveValue('22');
  await expect(page.locator('[data-dimension="width"]')).toHaveText('36 cm');
  await height.fill('11'); await expect(width).toHaveValue('18');
  await lock.click(); await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await width.fill('40'); await expect(height).toHaveValue('11');
  await height.fill('20'); await expect(width).toHaveValue('40');
  await lock.click(); await expect(lock).toHaveAttribute('aria-pressed', 'true');
  await width.fill('50'); await expect(height).toHaveValue('25');
  await height.fill('10'); await expect(width).toHaveValue('20');
  await width.fill(''); await expect(height).toHaveValue('10');
  await width.fill('10'); await expect(height).toHaveValue('5');
  await expect(page.locator('.sidebar input[type="number"]')).toHaveCount(8);
  await expect(page.locator('.sidebar input[readonly]')).toHaveCount(0);
  expect(await page.locator('.sidebar').innerText()).not.toMatch(/\bmm\b/);
});

test('lock uses imported physical proportions and centimeters rather than the SVG viewBox ratio', async ({ page }) => {
  await page.goto('/');
  const width = page.getByLabel('Ancho del SVG'), height = page.getByLabel('Alto del SVG');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'medidas.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg viewBox="0 0 1000 500" width="100mm" height="40mm"><rect width="1000" height="500"/></svg>') });
  await expect(width).toHaveValue('10'); await expect(height).toHaveValue('4');
  await width.fill('20'); await expect(height).toHaveValue('8');
  await height.fill('10'); await expect(width).toHaveValue('25');
  await expect(page.locator('[data-dimension="width"]')).toHaveText('25 cm');
  await expect(page.locator('[data-dimension="height"]')).toHaveText('10 cm');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'sin-medidas.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg viewBox="0 0 400 200"><rect width="400" height="200"/></svg>') });
  await expect(width).toHaveValue(''); await expect(height).toHaveValue('');
  await height.fill('15'); await expect(width).toHaveValue('30');
});

test('Ctrl plus wheel zooms around the cursor without a visible zoom control', async ({ page }) => {
  await page.goto('/');
  const drawing = page.locator('.drawing');
  const original = await drawing.getAttribute('viewBox');
  const box = await drawing.boundingBox();
  if (!box) throw new Error('No se encontró el lienzo.');
  const location = { x: box.x + box.width * 0.63, y: box.y + box.height * 0.43 };
  const worldPoint = async () => drawing.evaluate((node, location) => {
    const point = new DOMPoint(location.x, location.y).matrixTransform((node as SVGSVGElement).getScreenCTM()!.inverse());
    return { x: point.x, y: point.y };
  }, location);
  const before = await worldPoint();
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  await page.mouse.move(location.x, location.y);
  await page.mouse.wheel(0, -300);
  expect(await drawing.getAttribute('viewBox')).toBe(original);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(layoutWidth);
  const changed = await drawing.getAttribute('viewBox');
  expect(changed).not.toBe(original);
  const anchored = await drawing.evaluate((node, before) => {
    const point = new DOMPoint(before.x, before.y).matrixTransform((node as SVGSVGElement).getScreenCTM()!);
    return { x: point.x, y: point.y };
  }, before);
  // Browser SVG matrices have subpixel rounding; the cursor should stay within one screen pixel.
  expect(Math.hypot(anchored.x - location.x, anchored.y - location.y)).toBeLessThan(1);
  await expect(page.locator('.zoom-controls')).toHaveCount(0);
});

test('dragging the canvas pans the plane', async ({ page }) => {
  await page.goto('/');
  const drawing = page.locator('.drawing');
  const original = await drawing.getAttribute('viewBox');
  const box = await drawing.boundingBox();
  if (!box || !original) throw new Error('No se encontró el lienzo.');
  const start = { x: box.x + box.width * .55, y: box.y + box.height * .55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y + 60, { steps: 5 });
  await page.mouse.up();
  const moved = await drawing.getAttribute('viewBox');
  expect(moved).not.toBe(original);
  const [oldX, oldY, oldWidth, oldHeight] = original.split(' ').map(Number);
  const [newX, newY, newWidth, newHeight] = moved!.split(' ').map(Number);
  expect(newX).toBeLessThan(oldX);
  expect(newY).toBeLessThan(oldY);
  expect(newWidth).toBeCloseTo(oldWidth);
  expect(newHeight).toBeCloseTo(oldHeight);
});

test('obsolete layers are absent while module placement still uses partition settings', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'aro.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 -10 120 120" width="120mm" height="120mm"><path fill-rule="evenodd" d="M100 50 A50 50 0 1 1 0 50 A50 50 0 1 1 100 50Z M80 50 A30 30 0 1 1 20 50 A30 30 0 1 1 80 50Z"/></svg>') });
  await expect(page.getByRole('group', { name: 'Capas principales' }).getByRole('checkbox')).toHaveCount(5);
  await expect(page.getByRole('checkbox', { name: 'PARTIDAS', exact: true })).toHaveCount(1);
  for (const name of ['RECORRIDOS LED', 'RECORRIDO LED PRINCIPAL', 'CONEXIONES']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(0);
  }
  await page.getByLabel('Largo del módulo').fill('1.2');
  await page.getByLabel('Ancho del módulo').fill('0.5');
  await page.getByLabel('Pigtail izquierdo').fill('0.4');
  await page.getByLabel('Pigtail derecho').fill('0.4');
  await page.getByRole('checkbox', { name: 'MÓDULOS LED' }).check();
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
  await page.getByLabel('Máximo de recorridos').selectOption('1');
  await expect(page.locator('[data-led-module]').first()).toBeVisible();
  await expect(page.locator('[data-partition], [data-principal-route], [data-connectivity-link]')).toHaveCount(0);
});

test('skeleton retains the existing outer and inner contours imported as separate figures', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'banda.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120" width="160mm" height="120mm"><path id="exterior" d="M10 10 H85 C150 10 150 110 85 110 H10 Z"/><path id="interior" d="M30 30 H82 C117 30 117 90 82 90 H30 Z"/></svg>') });
  await page.getByRole('checkbox', { name: 'SKELETON', exact: true }).check();
  await expect(page.locator('[data-skeleton-edge]').first()).toBeVisible();
});

test('solid circles keep medial points without invented directional partitions', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'circulos.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 100" width="220mm" height="100mm"><circle cx="50" cy="50" r="40"/><circle cx="170" cy="50" r="20"/></svg>') });
  await page.getByRole('checkbox', { name: 'SKELETON', exact: true }).check();
  await expect(page.locator('[data-skeleton-point]')).toHaveCount(2);
  await expect(page.locator('.geometry-status')).toContainText('Skeleton puntual');
});

test('open contours explain why there is no interior skeleton', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'abierto.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L90 90"/></svg>') });
  await page.getByRole('checkbox', { name: 'SKELETON', exact: true }).check();
  await expect(page.locator('[data-skeleton-edge]')).toHaveCount(0);
  await expect(page.locator('.geometry-status')).toContainText('abierto');
});
