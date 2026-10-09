import { test, expect } from '@playwright/test';
import { createModuleGeometry } from '../src/engine/module';

test('models the left and right pigtails independently of the module body', () => {
  const geometry = createModuleGeometry({
    lengthMm: 50, widthMm: 12, leftPigtailMm: 8, rightPigtailMm: 14,
  });
  expect(geometry).toEqual({
    body: { startMm: 0, endMm: 50, lengthMm: 50 },
    leftPigtail: { startMm: -8, endMm: 0, lengthMm: 8 },
    rightPigtail: { startMm: 50, endMm: 64, lengthMm: 14 },
    widthMm: 12,
  });
  expect(geometry.body.lengthMm).toBe(50);
});

test('accepts zero-length pigtails but rejects invalid body dimensions', () => {
  expect(createModuleGeometry({ lengthMm: 30, widthMm: 10, leftPigtailMm: 0, rightPigtailMm: 0 }).body.lengthMm).toBe(30);
  expect(() => createModuleGeometry({ lengthMm: 30, widthMm: 0, leftPigtailMm: 4, rightPigtailMm: 5 })).toThrow('mayores que cero');
  expect(() => createModuleGeometry({ lengthMm: 30, widthMm: 10, leftPigtailMm: -4, rightPigtailMm: 5 })).toThrow('no negativos');
});
