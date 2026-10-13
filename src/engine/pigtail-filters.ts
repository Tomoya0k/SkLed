import type { ModuleMeasurements } from './module';

/** Reduces each pigtail's usable length by a user-selected cable reserve. */
export function availablePigtails(measurements: ModuleMeasurements, reservePercent = 0): ModuleMeasurements {
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent >= 100) throw new Error('La reserva de pigtails debe estar entre 0 y 99 %.');
  const factor = 1 - reservePercent / 100;
  return { ...measurements, leftPigtailMm: measurements.leftPigtailMm * factor, rightPigtailMm: measurements.rightPigtailMm * factor };
}
