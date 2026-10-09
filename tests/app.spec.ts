import { test, expect } from '@playwright/test';

test('shows SVG and all contours as independent layers without removed panels', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Capas principales' }).getByRole('checkbox')).toHaveCount(4);
  await expect(page.getByRole('checkbox', { name: 'CONTORNO', exact: true })).toBeChecked();
  await expect(page.locator('[data-svg-figure]')).toHaveCount(0);
  await expect(page.locator('[data-contour]')).toHaveCount(7);
  await page.getByText('Opciones avanzadas', { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'SVG original' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'SVG original' }).check();
  await expect(page.locator('[data-svg-figure]')).toHaveCount(6);
  await page.getByRole('checkbox', { name: 'SVG original' }).uncheck();
  await expect(page.locator('[data-svg-figure]')).toHaveCount(0);

  await page.getByLabel('Cargar archivo SVG').setInputFiles({ name: 'trazos.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="letra" d="M0 0H10 M20 0H30"/><circle id="aro" cx="50" cy="50" r="10"/></svg>') });
  await expect(page.locator('.canvas-corner')).toHaveText('trazos.svg');
  await expect(page.locator('[data-contour]')).toHaveCount(3);
  await page.getByRole('checkbox', { name: 'SVG original' }).check();
  await expect(page.locator('[data-svg-figure]')).toHaveCount(2);
  await expect(page.locator('.file-info, .figures-section, .electrical-section, .led-summary, .zoom-controls')).toHaveCount(0);
  await page.getByLabel('Largo del módulo').fill('50');
  await page.getByLabel('Ancho del módulo').fill('10');
  await page.getByLabel('Pigtail izquierdo').fill('8');
  await page.getByLabel('Pigtail derecho').fill('12');
  await expect(page.getByLabel('Largo del módulo')).toHaveValue('50');
  await expect(page.getByLabel('Ancho del módulo')).toHaveValue('10');
  await expect(page.getByLabel('Pigtail izquierdo')).toHaveValue('8');
  await expect(page.getByLabel('Pigtail derecho')).toHaveValue('12');
  await expect(page.locator('.module-segments span').nth(0)).toContainText('Izq. 8');
  await expect(page.locator('.module-segments span').nth(1)).toContainText('Módulo 50');
  await expect(page.locator('.module-segments span').nth(2)).toContainText('Der. 12');
  await expect(page.getByText(/LEDs|Longitud total|Inspeccionar recorrido/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('rejects bad SVG without losing the previous contours', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('checkbox', { name: 'CONTORNO', exact: true }).check();
  await page.getByText('Pegar SVG', { exact: true }).click();
  await page.getByLabel('Código SVG').fill('<svg broken');
  await page.getByRole('button', { name: 'Procesar' }).click();
  await expect(page.getByRole('alert')).toContainText('no es un SVG válido');
  await expect(page.locator('[data-contour]')).toHaveCount(7);
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

test('derives height from width only when the SVG has no physical dimensions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Ancho del SVG')).toHaveValue('');
  await page.getByLabel('Ancho del SVG').fill('360');
  await expect(page.getByLabel('Alto del SVG')).toHaveValue('220');

  await page.getByLabel('Cargar archivo SVG').setInputFiles({
    name: 'medidas.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500" width="100mm" height="40mm"><rect width="1000" height="500"/></svg>'),
  });
  await expect(page.getByLabel('Ancho del SVG')).toHaveValue('100');
  await expect(page.getByLabel('Alto del SVG')).toHaveValue('40');
  await page.getByLabel('Ancho del SVG').fill('200');
  await expect(page.getByLabel('Alto del SVG')).toHaveValue('40');

  await page.getByLabel('Cargar archivo SVG').setInputFiles({
    name: 'sin-medidas.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200"/></svg>'),
  });
  await expect(page.getByLabel('Ancho del SVG')).toHaveValue('');
  await expect(page.getByLabel('Alto del SVG')).toHaveValue('');
  await page.getByLabel('Ancho del SVG').fill('200');
  await expect(page.getByLabel('Alto del SVG')).toHaveValue('100');
  await page.getByLabel('Alto del SVG').fill('90');
  await page.getByLabel('Ancho del SVG').fill('300');
  await expect(page.getByLabel('Alto del SVG')).toHaveValue('150');
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
  await expect(page.getByRole('group', { name: 'Capas principales' }).getByRole('checkbox')).toHaveCount(4);
  for (const name of ['PARTIDAS', 'RECORRIDO LED PRINCIPAL', 'CONEXIONES']) {
    await expect(page.getByRole('checkbox', { name, exact: true })).toHaveCount(0);
  }
  await page.getByLabel('Largo del módulo').fill('12');
  await page.getByLabel('Ancho del módulo').fill('5');
  await page.getByLabel('Pigtail izquierdo').fill('4');
  await page.getByLabel('Pigtail derecho').fill('4');
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
