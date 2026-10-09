import { geometryToPath, normalizePath } from './geometry';
import { readSvgPhysicalSize } from './dimensions';
import { sanitizeSvg } from './sanitize';
import type { Bounds, Contour, Figure, Point, SvgModel } from './types';
export type * from './types';
export { createModuleGeometry } from './module';
export type { ModuleGeometry, ModuleMeasurements, ModuleSegment } from './module';
export { proportionalHeight, readSvgPhysicalSize } from './dimensions';
export type { SvgPhysicalSize } from './dimensions';
export { generateDivisions } from './divisions';
export type { DivisionPath, DivisionResult } from './divisions';
export { generateSkeleton } from './skeleton';
export type { SkeletonResult, SkeletonNode, SkeletonEdge } from './skeleton';
export { generatePartitions } from './partitions';
export type { PartitionConfig, PartitionResult, PartitionPath } from './partitions';
export type { GeometryRegion } from './regions';
export { distributeLeds } from './distribution';
export type { LedPlacement, LedDistributionResult, FigureDistribution } from './distribution';
export { selectPrincipalRoutes } from './principal';
export type { PrincipalConfig, PrincipalResult, PrincipalCandidate, PrincipalFigure, PrincipalModule } from './principal';
export { connectLeds } from './connectivity';
export type { ConnectionLink, ConnectionKind, ConnectivityResult, ConnectivityModes, FlowChain, FigureFlow, TerminalSide } from './connectivity';
export { estimateElectrical } from './electrical';
export type { ElectricalSpecifications, ElectricalEstimate, SupplySpecification } from './electrical';

const NS = 'http://www.w3.org/2000/svg';
const colors = ['#2563eb', '#d97706', '#059669', '#9333ea', '#e11d48', '#0891b2', '#4f46e5', '#b45309'];
const point = (p: DOMPoint): Point => ({ x: p.x, y: p.y });

function pathElement(d: string): SVGPathElement {
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  return path;
}

function unionBounds(boxes: Bounds[]): Bounds {
  const x = Math.min(...boxes.map(b => b.x));
  const y = Math.min(...boxes.map(b => b.y));
  return {
    x, y,
    width: Math.max(...boxes.map(b => b.x + b.width)) - x,
    height: Math.max(...boxes.map(b => b.y + b.height)) - y,
  };
}

/** Browser-only geometry engine. No React, storage, network, or UI dependencies. */
export function parseSvg(source: string): SvgModel {
  const warnings = new Set<string>();
  const svg = sanitizeSvg(source, warnings);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1000px;height:1000px;opacity:0;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  // Isolate source CSS from the application and from host-page SVG styles.
  const measurementSvg = document.createElementNS(NS, 'svg');
  measurementSvg.style.setProperty('display', 'inline', 'important');
  shadow.append(svg, measurementSvg);
  document.body.append(host);
  try {
    const view = svg.viewBox.baseVal;
    const physicalSize = readSvgPhysicalSize(svg.getAttribute('width'), svg.getAttribute('height'));
    if (svg.hasAttribute('viewBox') && (!(view.width > 0) || !(view.height > 0))) {
      throw new Error('El viewBox debe tener ancho y alto mayores que cero.');
    }
    // Deterministic fallback viewport, independent of the application's window size.
    if (!svg.hasAttribute('width')) svg.setAttribute('width', String(view.width || 300));
    if (!svg.hasAttribute('height')) svg.setAttribute('height', String(view.height || 150));
    const rootMatrix = svg.getScreenCTM();
    if (!rootMatrix || Math.abs(rootMatrix.a * rootMatrix.d - rootMatrix.b * rootMatrix.c) < 1e-12) {
      throw new Error('La transformación raíz del SVG no se puede invertir.');
    }
    // Keep a root transform too: viewBox coordinates are the output coordinate space.
    const rootTransform = svg.transform.baseVal.consolidate()?.matrix ?? new DOMMatrix();
    const rootInverse = rootTransform.multiply(rootMatrix.inverse());
    const figures: Figure[] = [];
    const elements = svg.querySelectorAll<SVGGeometryElement>('path,rect,circle,ellipse,line,polyline,polygon');
    for (const element of elements) {
      if (element.closest('defs,symbol')) continue;
      let hidden = false;
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || Number(style.opacity) === 0) hidden = true;
      }
      const style = getComputedStyle(element);
      if (hidden || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
      const originalD = geometryToPath(element);
      if (!originalD.trim()) continue;
      const screenMatrix = element.getScreenCTM();
      if (!screenMatrix) continue;
      const matrix = rootInverse.multiply(screenMatrix);
      const parts = normalizePath(originalD, matrix);
      const id = `figure-${figures.length + 1}`;
      const contours: Contour[] = [];
      for (const d of parts) {
        const path = pathElement(d);
        const length = path.getTotalLength();
        if (!Number.isFinite(length)) throw new Error('No se pudo medir un contorno del SVG.');
        if (length <= 1e-8) continue;
        contours.push({
          id: `${id}-contour-${contours.length + 1}`, figureId: id, d,
          closed: /z\s*$/i.test(d), length,
          start: point(path.getPointAtLength(0)), end: point(path.getPointAtLength(length)),
        });
      }
      if (!contours.length) continue;
      const d = contours.map(c => c.d).join(' ');
      const measuredPath = pathElement(d);
      measuredPath.style.setProperty('display', 'inline', 'important');
      measurementSvg.append(measuredPath);
      const bbox = measuredPath.getBBox();
      const bounds = { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
      if (!Object.values(bounds).every(Number.isFinite)) throw new Error('No se pudieron calcular los límites de una figura.');
      figures.push({
        id, sourceId: element.id || null,
        name: element.id || element.querySelector('title')?.textContent || `${element.localName} ${figures.length + 1}`,
        type: element.localName, color: colors[figures.length % colors.length], d, contours,
        length: contours.reduce((sum, c) => sum + c.length, 0), bounds,
        fillRule: style.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', filled: style.fill !== 'none',
      });
      measuredPath.remove();
    }
    if (!figures.length) throw new Error('No se encontraron figuras visibles con recorridos. Usa trazados o figuras vectoriales.');
    const bounds = unionBounds(figures.map(f => f.bounds));
    const viewBox = view.width > 0 && view.height > 0
      ? { x: view.x, y: view.y, width: view.width, height: view.height }
      : { x: 0, y: 0, width: svg.width.baseVal.value, height: svg.height.baseVal.value };
    const ratioWidth = svg.hasAttribute('viewBox') ? view.width : physicalSize?.widthMm ?? bounds.width;
    const ratioHeight = svg.hasAttribute('viewBox') ? view.height : physicalSize?.heightMm ?? bounds.height;
    const aspectRatio = ratioWidth > 0 && ratioHeight > 0 ? ratioWidth / ratioHeight : null;
    return { version: 1, units: 'svg', viewBox, physicalSize, aspectRatio, bounds, figures, warnings: [...warnings] };
  } finally {
    host.remove();
  }
}
