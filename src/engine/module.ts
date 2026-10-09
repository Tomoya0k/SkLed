/** Millimeters, independent of the SVG's user-unit coordinate system. */
export interface ModuleMeasurements {
  lengthMm: number;
  widthMm: number;
  leftPigtailMm: number;
  rightPigtailMm: number;
}

export interface ModuleSegment {
  startMm: number;
  endMm: number;
  lengthMm: number;
}

/** The body starts at zero. Each pigtail remains its own named segment. */
export interface ModuleGeometry {
  body: ModuleSegment;
  leftPigtail: ModuleSegment;
  rightPigtail: ModuleSegment;
  widthMm: number;
}

export function createModuleGeometry(measurements: ModuleMeasurements): ModuleGeometry {
  const { lengthMm, widthMm, leftPigtailMm, rightPigtailMm } = measurements;
  if (![lengthMm, widthMm, leftPigtailMm, rightPigtailMm].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error('Las medidas del módulo deben ser números no negativos.');
  }
  if (lengthMm === 0 || widthMm === 0) {
    throw new Error('El largo y el ancho del módulo deben ser mayores que cero.');
  }
  return {
    body: { startMm: 0, endMm: lengthMm, lengthMm },
    leftPigtail: { startMm: -leftPigtailMm, endMm: 0, lengthMm: leftPigtailMm },
    rightPigtail: { startMm: lengthMm, endMm: lengthMm + rightPigtailMm, lengthMm: rightPigtailMm },
    widthMm,
  };
}
