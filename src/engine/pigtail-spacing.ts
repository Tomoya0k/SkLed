/** Keep one centimeter of slack from the combined pigtail reach. */
export function minimumPigtailSpacingMm(leftPigtailMm: number, rightPigtailMm: number): number {
  if (![leftPigtailMm, rightPigtailMm].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('Las longitudes de los pigtails deben ser valores positivos o cero.');
  }
  return Math.max(0, leftPigtailMm + rightPigtailMm - 10);
}
