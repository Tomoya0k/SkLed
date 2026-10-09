import type { SvgPhysicalSize } from './dimensions';

export interface Point { x: number; y: number }
export interface Bounds extends Point { width: number; height: number }

export interface Contour {
  id: string;
  figureId: string;
  /** Absolute path in root SVG user units. Curves and arcs are preserved. */
  d: string;
  closed: boolean;
  length: number;
  start: Point;
  end: Point;
}

export interface Figure {
  id: string;
  sourceId: string | null;
  name: string;
  type: string;
  color: string;
  d: string;
  contours: Contour[];
  length: number;
  bounds: Bounds;
  fillRule: 'nonzero' | 'evenodd';
  filled: boolean;
}

export interface SvgModel {
  version: 1;
  units: 'svg';
  viewBox: Bounds;
  /** Root width/height converted to millimeters, only when both are explicit. */
  physicalSize: SvgPhysicalSize | null;
  /** Intrinsic drawing ratio, used only when physical size is absent. */
  aspectRatio: number | null;
  bounds: Bounds;
  figures: Figure[];
  warnings: string[];
}
