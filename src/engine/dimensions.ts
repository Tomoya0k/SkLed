export interface SvgPhysicalSize {
  widthMm: number;
  heightMm: number;
  rawWidth: string;
  rawHeight: string;
}

const unitsToMm: Record<string, number> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96,
};

/** SVG unitless lengths are CSS pixels. Percentages are not physical metadata. */
function lengthInMm(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|q|in|pt|pc|px)?$/i);
  if (!match) return null;
  const value = Number(match[1]) * unitsToMm[(match[2] ?? 'px').toLowerCase()];
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Only a complete pair of explicit root dimensions determines physical size. */
export function readSvgPhysicalSize(width: string | null, height: string | null): SvgPhysicalSize | null {
  const widthMm = lengthInMm(width);
  const heightMm = lengthInMm(height);
  if (widthMm === null || heightMm === null) return null;
  return { widthMm, heightMm, rawWidth: width!, rawHeight: height! };
}

export function proportionalHeight(widthMm: number, aspectRatio: number | null): number | null {
  if (!Number.isFinite(widthMm) || widthMm <= 0 || aspectRatio === null || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return null;
  return widthMm / aspectRatio;
}
