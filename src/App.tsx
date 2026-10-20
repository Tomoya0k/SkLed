import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { buildMeasurementTargets, createModuleGeometry, parseSvg } from './engine';
import type { Bounds, ConnectionLink, LedPlacement, Point, SvgModel, SerpentResult, SkeletonResult, TerminalSide } from './engine';
import { usefulSkeletonEdges } from './engine/skeleton-filter';
import { minimumPigtailSpacingMm } from './engine/pigtail-spacing';
import { pathData } from './engine/regions';
import type { LayoutResult, LayoutPlacement } from './engine/layout.worker';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'No se pudo procesar el archivo.';
const formatMeasure = (value: number) => String(Math.round(value * 1000000) / 1000000);
const formatWholeMeasure = (value: number) => String(Math.ceil(Number(formatMeasure(value))));
const sizeInputValue = (value: string) => value === '' ? '' : formatWholeMeasure(Number(value));
const mm = (centimeters: string) => Number(centimeters) * 10;
const formatCm = (millimeters: number) => formatMeasure(millimeters / 10);
const measurementText = (text: string) => text.replace(/(-?\d+(?:\.\d+)?)\s*mm\b/g, (_match, value: string) => `${formatCm(Number(value))} cm`).replace(/\bmm\b/g, 'cm');
function routeSlice(points: Point[], fromMm: number, toMm: number, scale: { x: number; y: number }): Point[] {
  if (points.length < 2) return [];
  const segmentLengths = points.slice(1).map((point, index) => Math.hypot((point.x - points[index].x) * scale.x, (point.y - points[index].y) * scale.y));
  const cumulative = [0];
  for (const length of segmentLengths) cumulative.push(cumulative.at(-1)! + length);
  const total = cumulative.at(-1)!;
  const start = Math.max(0, Math.min(total, fromMm)), end = Math.max(start, Math.min(total, toMm));
  if (end - start < 1e-6) return [];
  const at = (target: number): Point => {
    let index = 1;
    while (index < cumulative.length - 1 && cumulative[index] < target) index++;
    const length = segmentLengths[index - 1];
    const fraction = length > 0 ? (target - cumulative[index - 1]) / length : 0;
    return { x: points[index - 1].x + (points[index].x - points[index - 1].x) * fraction,
      y: points[index - 1].y + (points[index].y - points[index - 1].y) * fraction };
  };
  const sliced = [at(start)];
  for (let index = 1; index < points.length - 1; index++) if (cumulative[index] > start + 1e-6 && cumulative[index] < end - 1e-6) sliced.push(points[index]);
  sliced.push(at(end));
  return sliced;
}
function connectionParts(link: ConnectionLink, scale: { x: number; y: number }) {
  const total = link.route.slice(1).reduce((length, point, index) => length + Math.hypot((point.x - link.route[index].x) * scale.x, (point.y - link.route[index].y) * scale.y), 0);
  const fromLength = Math.min(total, link.fromPigtailUsedMm);
  const toLength = Math.min(total - fromLength, link.toPigtailUsedMm);
  return {
    source: routeSlice(link.route, 0, fromLength, scale),
    target: routeSlice(link.route, total - toLength, total, scale),
    connection: routeSlice(link.route, fromLength, total - toLength, scale),
  };
}
function terminalPoint(module: LedPlacement, side: TerminalSide): Point {
  const [a, b] = side === 'left' ? [module.corners[0], module.corners[3]] : [module.corners[1], module.corners[2]];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
function openPigtail(module: LedPlacement, side: TerminalSide, lengthMm: number, scale: { x: number; y: number }): Point[] {
  const terminal = terminalPoint(module, side);
  const direction = { x: (terminal.x - module.center.x) * scale.x, y: (terminal.y - module.center.y) * scale.y };
  const magnitude = Math.hypot(direction.x, direction.y);
  if (lengthMm <= 0 || magnitude <= 1e-9) return [];
  return [terminal, { x: terminal.x + direction.x / magnitude * lengthMm / scale.x, y: terminal.y + direction.y / magnitude * lengthMm / scale.y }];
}
const emptyModel: SvgModel = {
  version: 1, units: 'svg', viewBox: { x: 0, y: 0, width: 100, height: 100 },
  physicalSize: null, aspectRatio: null, bounds: { x: 0, y: 0, width: 100, height: 100 },
  figures: [], warnings: [],
};

function ModuleSketch({ lengthCm, widthCm, leftPigtailCm, rightPigtailCm }: {
  lengthCm: string; widthCm: string; leftPigtailCm: string; rightPigtailCm: string;
}) {
  const length = Number(lengthCm), width = Number(widthCm);
  const left = Math.max(0, Number(leftPigtailCm) || 0), right = Math.max(0, Number(rightPigtailCm) || 0);
  const dimensionsReady = Number.isFinite(length) && length > 0 && Number.isFinite(width) && width > 0;
  const total = (dimensionsReady ? length : 0) + left + right;
  const scale = dimensionsReady ? Math.min(250 / Math.max(total, length), 58 / width) : 0;
  const x = 25 + (250 - total * scale) / 2;
  const bodyX = x + left * scale;
  const bodyWidth = length * scale;
  const bodyHeight = width * scale;
  const bodyY = 12 + (58 - bodyHeight) / 2;
  const centerY = bodyY + bodyHeight / 2;
  const measure = (value: string) => Number.isFinite(Number(value)) ? formatMeasure(Number(value)) : '—';
  const ariaLabel = `Módulo a escala: cuerpo ${measure(lengthCm)} por ${measure(widthCm)} cm, pigtail izquierdo ${measure(leftPigtailCm)} cm, pigtail derecho ${measure(rightPigtailCm)} cm`;
  return <svg className="module-sketch" viewBox="0 0 300 110" role="img" aria-label={ariaLabel}>
    {dimensionsReady ? <>
      <g fill="none" stroke="#dce7df" strokeWidth="2.2"><path d={`M${x} ${centerY - 2}H${bodyX} M${bodyX + bodyWidth} ${centerY - 2}H${x + total * scale}`} /></g>
      <g fill="none" stroke="#ff525d" strokeWidth="2.8"><path d={`M${x} ${centerY + 2}H${bodyX} M${bodyX + bodyWidth} ${centerY + 2}H${x + total * scale}`} /></g>
      <rect x={bodyX} y={bodyY} width={bodyWidth} height={bodyHeight} rx="1" fill="#172a20" stroke="#a4b4a8" strokeWidth="1.5" />
      <g fill="none" stroke="#ff6972" strokeWidth="1.6">
        {[0.25, 0.5, 0.75].map(fraction => <circle key={fraction} cx={bodyX + bodyWidth * fraction} cy={centerY} r={Math.max(1.8, Math.min(7, bodyHeight * 0.19))} />)}
      </g>
      <path d={`M${bodyX} 76V82 M${bodyX + bodyWidth} 76V82 M${bodyX} 79H${bodyX + bodyWidth}`} fill="none" stroke="#71877a" strokeWidth="1" />
      <path d={`M${bodyX + bodyWidth + 5} ${bodyY}H${bodyX + bodyWidth + 11} M${bodyX + bodyWidth + 5} ${bodyY + bodyHeight}H${bodyX + bodyWidth + 11} M${bodyX + bodyWidth + 8} ${bodyY}V${bodyY + bodyHeight}`} fill="none" stroke="#71877a" strokeWidth="1" />
    </> : <text x="150" y="45" textAnchor="middle" fill="#7fa88b" fontSize="10">Ingresa largo y ancho del módulo</text>}
    <g className="module-sketch-labels" fill="#a2b6a7" fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="middle">
      <text x="39" y="94">Pigtail izq.</text><text x="39" y="105">{measure(leftPigtailCm)} cm</text>
      <text x="112" y="94">Largo</text><text x="112" y="105">{measure(lengthCm)} cm</text>
      <text x="188" y="94">Ancho</text><text x="188" y="105">{measure(widthCm)} cm</text>
      <text x="261" y="94">Pigtail der.</text><text x="261" y="105">{measure(rightPigtailCm)} cm</text>
    </g>
  </svg>;
}

function Dimensions({ bounds, widthLabel, heightLabel, fontSize, span }: {
  bounds: Bounds; widthLabel: string; heightLabel: string; fontSize: number; span: number;
}) {
  const { x, y, width, height } = bounds;
  const targetSpan = Math.max(width, height, fontSize * 2);
  const offset = Math.max(fontSize * 1.1, Math.min(span * 0.025, targetSpan * 0.08));
  const tick = fontSize * 0.45;
  const labelHeight = fontSize * 1.85;
  const widthLabelWidth = Math.max(fontSize * 4.2, widthLabel.length * fontSize * 0.58 + fontSize * 1.8);
  const heightLabelWidth = Math.max(fontSize * 4.2, heightLabel.length * fontSize * 0.58 + fontSize * 1.8);
  const horizontalY = y - offset;
  const verticalX = x + width + offset;
  return <g className="dimensions" aria-label={`Cotas del plano: ancho ${widthLabel}; alto ${heightLabel}`}>
    <g data-dimension="width">
      <path d={`M${x} ${y}V${horizontalY} M${x + width} ${y}V${horizontalY} M${x} ${horizontalY}H${x + width} M${x + tick} ${horizontalY - tick * 0.55}L${x} ${horizontalY}L${x + tick} ${horizontalY + tick * 0.55} M${x + width - tick} ${horizontalY - tick * 0.55}L${x + width} ${horizontalY}L${x + width - tick} ${horizontalY + tick * 0.55}`} className="dimension-line" />
      <rect x={x + width / 2 - widthLabelWidth / 2} y={horizontalY - labelHeight / 2} width={widthLabelWidth} height={labelHeight} rx={labelHeight / 2} className="dimension-label" />
      <text x={x + width / 2} y={horizontalY} fontSize={fontSize} textAnchor="middle" dominantBaseline="middle" className="dimension-text">{widthLabel}</text>
    </g>
    <g data-dimension="height">
      <path d={`M${x + width} ${y}H${verticalX} M${x + width} ${y + height}H${verticalX} M${verticalX} ${y}V${y + height} M${verticalX - tick * 0.55} ${y + tick}L${verticalX} ${y}L${verticalX + tick * 0.55} ${y + tick} M${verticalX - tick * 0.55} ${y + height - tick}L${verticalX} ${y + height}L${verticalX + tick * 0.55} ${y + height - tick}`} className="dimension-line" />
      <g transform={`rotate(-90 ${verticalX} ${y + height / 2})`}>
        <rect x={verticalX - heightLabelWidth / 2} y={y + height / 2 - labelHeight / 2} width={heightLabelWidth} height={labelHeight} rx={labelHeight / 2} className="dimension-label" />
        <text x={verticalX} y={y + height / 2} fontSize={fontSize} textAnchor="middle" dominantBaseline="middle" className="dimension-text">{heightLabel}</text>
      </g>
    </g>
  </g>;
}

export default function App() {
  const [model, setModel] = useState<SvgModel>(emptyModel);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const [showContour, setShowContour] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [showLedRoutes, setShowLedRoutes] = useState(false);
  const [showLedDistribution, setShowLedDistribution] = useState(false);
  const [showSerpent, setShowSerpent] = useState(false);
  const [showPigtails, setShowPigtails] = useState(false);
  const [preferBorder, setPreferBorder] = useState(false);
  const [borderMinimumGap, setBorderMinimumGap] = useState('1');
  const [serpents, setSerpents] = useState<SerpentResult[]>([]);
  const [serpentPlanning, setSerpentPlanning] = useState(false);
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [layoutPlanning, setLayoutPlanning] = useState(false);
  const [selectedFigureId, setSelectedFigureId] = useState<string | null>(null);
  const [minimumSectionWidth, setMinimumSectionWidth] = useState('10');
  const [avoidModuleCollisions, setAvoidModuleCollisions] = useState(true);
  const [allowBridges, setAllowBridges] = useState(false);
  const [svgWidth, setSvgWidth] = useState('');
  const [svgHeight, setSvgHeight] = useState('');
  const [aspectLocked, setAspectLocked] = useState(true);
  const sizeRatio = useRef<number | null>(null);
  const [zoomWindow, setZoomWindow] = useState<Bounds | null>(null);
  const [moduleLength, setModuleLength] = useState('');
  const [moduleWidth, setModuleWidth] = useState('');
  const [leftPigtail, setLeftPigtail] = useState('');
  const [rightPigtail, setRightPigtail] = useState('');
  const [dragging, setDragging] = useState(false);
  const [panning, setPanning] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const drawingRef = useRef<SVGSVGElement>(null);
  const importSequence = useRef(0);
  const skeletonCache = useRef<{ model: SvgModel; width: number | null; height: number | null; skeleton: SkeletonResult } | null>(null);
  const panStart = useRef<{ clientX: number; clientY: number; view: Bounds; inverse: DOMMatrix; figureId: string | null; moved: boolean } | null>(null);

  const figures = model.figures;
  const contours = figures.flatMap(figure => figure.contours);
  const measurementTargets = useMemo(() => buildMeasurementTargets(figures), [figures]);
  const selectedFigure = measurementTargets.find(figure => figure.id === selectedFigureId);
  const pigtailsValid = [leftPigtail, rightPigtail].every(value => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
  const pigtailReachCm = pigtailsValid ? Number(leftPigtail) + Number(rightPigtail) : null;
  const pigtailReachMm = pigtailReachCm === null ? null : mm(String(pigtailReachCm));
  const minimumPigtailGapMm = pigtailsValid ? minimumPigtailSpacingMm(mm(leftPigtail), mm(rightPigtail)) : null;
  const borderGapValid = borderMinimumGap !== '' && Number.isFinite(Number(borderMinimumGap)) && Number(borderMinimumGap) >= 0;
  const spacingValid = !preferBorder || borderGapValid;
  const partitionInputValid = minimumSectionWidth !== '' && Number.isFinite(Number(minimumSectionWidth)) && Number(minimumSectionWidth) >= 0;
  const moduleGeometry = useMemo(() => {
    if ([moduleLength, moduleWidth, leftPigtail, rightPigtail].some(value => value === '')) return null;
    try {
      return createModuleGeometry({
        lengthMm: mm(moduleLength), widthMm: mm(moduleWidth),
        leftPigtailMm: mm(leftPigtail), rightPigtailMm: mm(rightPigtail),
      });
    } catch { return null; }
  }, [moduleLength, moduleWidth, leftPigtail, rightPigtail]);
  const physicalSizeReady = svgWidth !== '' && svgHeight !== '' && mm(svgWidth) > 0 && mm(svgHeight) > 0 && Number.isFinite(mm(svgWidth)) && Number.isFinite(mm(svgHeight));
  const canCountLeds = !!filename && physicalSizeReady && spacingValid && (preferBorder || partitionInputValid) && !!moduleGeometry;
  const needDistribution = showLedDistribution || showPigtails || canCountLeds;
  const needPlacement = showLedRoutes || showSerpent || needDistribution;
  const needSkeleton = !!filename && (showSkeleton || needPlacement);
  const loadingLabel = reading ? 'Procesando archivo…'
    : layoutPlanning ? `Calculando ${preferBorder ? 'recorrido del borde' : 'recorridos candidatos'}${needDistribution ? ' y distribución LED' : ''}…`
      : serpentPlanning ? 'Calculando conexiones de pigtails…' : null;
  const skeleton = needSkeleton ? layout?.skeleton : null;
  const visibleSkeletonEdges = useMemo(() => skeleton ? usefulSkeletonEdges(skeleton) : [], [skeleton]);
  const divisions = needPlacement ? layout?.divisions : null;
  const serpentGuides = needPlacement ? layout?.serpentGuides : null;
  const ledDistribution = needDistribution ? layout?.distribution : null;
  const geometryWarnings = divisions?.warnings ?? skeleton?.warnings ?? [];
  const x = Math.min(model.bounds.x, model.viewBox.x);
  const y = Math.min(model.bounds.y, model.viewBox.y);
  const width = Math.max(model.bounds.x + model.bounds.width, model.viewBox.x + model.viewBox.width) - x;
  const height = Math.max(model.bounds.y + model.bounds.height, model.viewBox.y + model.viewBox.height) - y;
  const span = Math.max(width, height, 1);
  const pad = span * 0.09;
  const canvasWidth = Math.max(width, span * 0.1) + pad * 2;
  const canvasHeight = Math.max(height, span * 0.1) + pad * 2;
  const initialViewBox: Bounds = { x: x - pad, y: y - pad, width: canvasWidth, height: canvasHeight };
  const visibleViewBox = zoomWindow ?? initialViewBox;
  const viewBox = `${visibleViewBox.x} ${visibleViewBox.y} ${visibleViewBox.width} ${visibleViewBox.height}`;
  const dimensionBounds = selectedFigure?.bounds ?? model.viewBox;
  const dimensionFontSize = visibleViewBox.width * 0.04;
  const dimensionWidth = physicalSizeReady ? dimensionBounds.width * Number(svgWidth) / model.viewBox.width : dimensionBounds.width;
  const dimensionHeight = physicalSizeReady ? dimensionBounds.height * Number(svgHeight) / model.viewBox.height : dimensionBounds.height;
  const dimensionUnit = physicalSizeReady ? 'cm' : 'u SVG';
  const placement = useMemo((): LayoutPlacement | null => needPlacement && spacingValid && (preferBorder || partitionInputValid) && physicalSizeReady ? {
    mode: preferBorder ? 'border' : 'full',
    config: { minimumSectionWidthMm: mm(minimumSectionWidth) },
    measurements: moduleGeometry ? { lengthMm: mm(moduleLength), widthMm: mm(moduleWidth), leftPigtailMm: mm(leftPigtail), rightPigtailMm: mm(rightPigtail) } : null,
    options: { flexibleSpacing: preferBorder,
      minimumGapMm: preferBorder ? mm(borderMinimumGap) : minimumPigtailGapMm ?? 0,
      maximumGapMm: preferBorder ? Math.max(mm(borderMinimumGap), pigtailReachMm ?? 0) : pigtailReachMm ?? 0 },
  } : null, [needPlacement, needDistribution, preferBorder, spacingValid, borderMinimumGap, partitionInputValid, physicalSizeReady, moduleGeometry, moduleLength, moduleWidth, leftPigtail, rightPigtail, minimumSectionWidth, minimumPigtailGapMm, pigtailReachMm]);
  const physicalWidth = physicalSizeReady ? mm(svgWidth) : null, physicalHeight = physicalSizeReady ? mm(svgHeight) : null;
  useEffect(() => {
    if (!needSkeleton) { setLayout(null); setLayoutPlanning(false); return; }
    setLayoutPlanning(true);
    const cached = skeletonCache.current;
    const sourceSkeleton = cached?.model === model && cached.width === physicalWidth && cached.height === physicalHeight ? cached.skeleton : undefined;
    setLayout(null);
    const worker = new Worker(new URL('./engine/layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ result?: LayoutResult; error?: string }>) => {
      setLayoutPlanning(false);
      if (event.data.error) setError(event.data.error);
      else if (event.data.result) { setLayout(event.data.result); skeletonCache.current = { model, width: physicalWidth, height: physicalHeight, skeleton: event.data.result.sourceSkeleton }; }
      worker.terminate();
    };
    worker.onerror = () => { setLayoutPlanning(false); setError('No se pudo calcular la distribución.'); worker.terminate(); };
    worker.postMessage({ model, physicalSize: physicalWidth && physicalHeight ? { widthMm: physicalWidth, heightMm: physicalHeight } : undefined,
      skeleton: sourceSkeleton, placement,
      coverageMeasurements: moduleGeometry ? { lengthMm: moduleGeometry.body.lengthMm, widthMm: moduleGeometry.widthMm,
        leftPigtailMm: moduleGeometry.leftPigtail.lengthMm, rightPigtailMm: moduleGeometry.rightPigtail.lengthMm } : undefined });
    return () => worker.terminate();
  }, [needSkeleton, model, physicalWidth, physicalHeight, placement, moduleGeometry]);
  const ledRoutes = divisions?.paths.map(path => ({ id: path.id, divisionId: path.id, d: path.d })) ?? [];
  const moduleLabelSize = moduleGeometry && physicalSizeReady ? Math.min(mm(moduleWidth) * 0.48, mm(moduleLength) * 0.28) * model.viewBox.height / mm(svgHeight) : 0;
  useEffect(() => {
    setSerpents([]);
    if (!showPigtails || !serpentGuides || !ledDistribution || !moduleGeometry) { setSerpentPlanning(false); return; }
    setSerpentPlanning(true);
    const worker = new Worker(new URL('./engine/serpent.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ result?: SerpentResult[]; error?: string }>) => { setSerpentPlanning(false); if (event.data.error) setError(event.data.error); else setSerpents(event.data.result ?? []); worker.terminate(); };
    worker.onerror = () => { setSerpentPlanning(false); setError('No se pudo calcular el recorrido serpiente.'); worker.terminate(); };
    worker.postMessage({ model, divisions: serpentGuides, distribution: ledDistribution,
      measurements: { lengthMm: mm(moduleLength), widthMm: mm(moduleWidth), leftPigtailMm: mm(leftPigtail), rightPigtailMm: mm(rightPigtail) },
      widthMm: mm(svgWidth), heightMm: mm(svgHeight), avoidModuleCollisions, allowBridges });
    return () => worker.terminate();
  }, [avoidModuleCollisions, allowBridges, showPigtails, serpentGuides, ledDistribution, moduleGeometry, model, moduleLength, moduleWidth, leftPigtail, rightPigtail, svgWidth, svgHeight]);
  const serpentBreakCount = serpents.reduce((total, serpent) => total + serpent.breaks.length, 0);
  const bridgeCount = serpents.reduce((total, serpent) => total + serpent.links.filter(link => link.kind === 'bridge').length, 0);
  const extraCableMm = serpents.reduce((total, serpent) => total + serpent.extraCableMm, 0);
  const routedModules = new Map(serpents.flatMap(serpent => serpent.steps).map((step, index) =>
    [step.moduleId, { number: index + 1, reversed: step.entrySide === 'right' }]));
  const linkedTerminals = new Set(serpents.flatMap(serpent => serpent.links.flatMap(link => [`${link.fromId}:${link.fromSide}`, `${link.toId}:${link.toSide}`])));
  const wireScale = physicalSizeReady ? { x: mm(svgWidth) / model.viewBox.width, y: mm(svgHeight) / model.viewBox.height } : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const matrix = drawingRef.current?.getScreenCTM();
      if (!matrix) return;
      const cursor = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas!.clientHeight : 1);
      const factor = Math.exp(-delta * 0.0015);
      setZoomWindow(previous => {
        const current = previous ?? initialViewBox;
        const nextWidth = Math.max(initialViewBox.width / 40, Math.min(initialViewBox.width * 4, current.width / factor));
        const scale = nextWidth / current.width;
        return {
          x: cursor.x - (cursor.x - current.x) * scale,
          y: cursor.y - (cursor.y - current.y) * scale,
          width: nextWidth,
          height: current.height * scale,
        };
      });
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [model]);

  function changeSvgSize(axis: 'width' | 'height', value: string) {
    value = sizeInputValue(value);
    if (axis === 'width') setSvgWidth(value); else setSvgHeight(value);
    const ratio = sizeRatio.current;
    if (aspectLocked && ratio && Number(value) > 0 && Number.isFinite(Number(value))) {
      if (axis === 'width') setSvgHeight(formatMeasure(Number(value) / ratio));
      else setSvgWidth(formatMeasure(Number(value) * ratio));
    }
  }

  function toggleAspectLock() {
    if (!aspectLocked) {
      sizeRatio.current = physicalSizeReady ? Number(svgWidth) / Number(svgHeight)
        : model.physicalSize ? model.physicalSize.widthMm / model.physicalSize.heightMm : model.aspectRatio;
    }
    setAspectLocked(previous => !previous);
  }

  function importSvg(source: string, name: string) {
    try {
      const parsed = parseSvg(source);
      setModel(parsed);
      setFilename(name);
      setSelectedFigureId(null);
      setSerpents([]);
      setSvgWidth(parsed.physicalSize ? formatCm(parsed.physicalSize.widthMm) : '');
      setSvgHeight(parsed.physicalSize ? formatCm(parsed.physicalSize.heightMm) : '');
      sizeRatio.current = parsed.physicalSize ? parsed.physicalSize.widthMm / parsed.physicalSize.heightMm : parsed.aspectRatio;
      setZoomWindow(null);
      setError('');
    } catch (error) { setError(errorMessage(error)); }
  }

  async function readFile(file?: File) {
    if (!file) return;
    const sequence = ++importSequence.current;
    const eps = /\.(eps|epsf|epsi)$/i.test(file.name) || file.type === 'application/postscript';
    if (file.size > (eps ? 20_000_000 : 2_000_000)) { setReading(false); setError(eps ? 'El EPS supera el límite de 20 MB.' : 'El SVG supera el límite de 2 MB.'); return; }
    setReading(true);
    try {
      const text = eps ? await (await import('./import/eps')).epsToSvg(new Uint8Array(await file.arrayBuffer())) : await file.text();
      if (sequence === importSequence.current) importSvg(text, file.name);
    } catch (error) { if (sequence === importSequence.current) setError(errorMessage(error)); }
    finally { if (sequence === importSequence.current) setReading(false); }
  }

  function changeFile(event: ChangeEvent<HTMLInputElement>) {
    void readFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void readFile(event.dataTransfer.files[0]);
  }

  function startPan(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.drawing')) return;
    const matrix = drawingRef.current?.getScreenCTM();
    if (!matrix) return;
    event.preventDefault();
    panStart.current = { clientX: event.clientX, clientY: event.clientY, view: zoomWindow ?? initialViewBox, inverse: matrix.inverse(), figureId: event.target.closest('.figure-hit')?.getAttribute('data-figure-hit') ?? null, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  }

  function movePan(event: ReactPointerEvent<HTMLElement>) {
    const start = panStart.current;
    if (!start) return;
    const dx = event.clientX - start.clientX, dy = event.clientY - start.clientY;
    if (Math.hypot(dx, dy) <= 3) return;
    start.moved = true;
    const worldDx = dx * start.inverse.a + dy * start.inverse.c;
    const worldDy = dx * start.inverse.b + dy * start.inverse.d;
    setZoomWindow({ ...start.view, x: start.view.x - worldDx, y: start.view.y - worldDy });
  }

  function endPan(event: ReactPointerEvent<HTMLElement>) {
    if (event.type === 'pointerup' && panStart.current?.figureId && !panStart.current.moved) {
      const figureId = panStart.current.figureId;
      setSelectedFigureId(current => current === figureId ? null : figureId);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panStart.current = null;
    setPanning(false);
  }

  return <div className="app">
    <main className="workspace">
      <aside className="sidebar">
        <section className="panel-section file-section">
          <div className="section-heading"><h1 className="brand"><span className="brand-icon" aria-hidden="true">S</span>SkLed</h1></div>
          <input ref={fileInput} type="file" accept=".svg,.eps,.epsf,.epsi,image/svg+xml,application/postscript" onChange={changeFile} hidden aria-label="Cargar archivo SVG o EPS" />
          <button className="upload-button" onClick={() => fileInput.current?.click()} disabled={reading}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4" /></svg>
            {reading ? 'Procesando…' : 'Cargar SVG / EPS'}
          </button>
        </section>

        <section className="panel-section size-section">
          <div className="section-heading"><h2>Medidas SVG</h2><div className="size-heading-actions"><button type="button" className={`aspect-lock ${aspectLocked ? 'locked' : ''}`} aria-label="Mantener proporción" aria-pressed={aspectLocked} title={aspectLocked ? 'Desbloquear proporción' : 'Bloquear proporción'} onClick={toggleAspectLock}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="6" y="10" width="12" height="11" rx="2" /><path d={aspectLocked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M8 10V6a4 4 0 0 1 8 0'} /><path d="M12 14v3" /></svg>
          </button></div></div>
          <div className="size-fields">
            <label>Ancho <span><input aria-label="Ancho del SVG" type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={sizeInputValue(svgWidth)} onChange={event => changeSvgSize('width', event.target.value)} /><small>cm</small></span></label>
            <label>Alto <span><input aria-label="Alto del SVG" type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={sizeInputValue(svgHeight)} onChange={event => changeSvgSize('height', event.target.value)} /><small>cm</small></span></label>
          </div>
        </section>

        <section className="panel-section partitions-section">
          <div className="section-heading"><h2>Partidas</h2></div>
          <div className="module-fields">
            <label>Distancia mínima entre skeleton y borde <span><input aria-label="Distancia mínima entre skeleton y borde para formar una partida" type="number" min="0" step="any" inputMode="decimal" value={minimumSectionWidth} disabled={preferBorder} onChange={event => setMinimumSectionWidth(event.target.value)} /><small>cm</small></span></label>
          </div>
          {preferBorder && <small className="spacing-hint">Las partidas se aplican al acomodo completo.</small>}
        </section>

        <section className="panel-section wiring-section">
          <div className="section-heading"><h2>Pigtails y conexiones</h2></div>
          <label className="physical-filter"><input type="checkbox" checked={avoidModuleCollisions} onChange={event => setAvoidModuleCollisions(event.target.checked)} />Descartar conexiones que chocan con módulos LED</label>
          <label className="physical-filter"><input type="checkbox" checked={allowBridges} onChange={event => setAllowBridges(event.target.checked)} />Completar saltos con cable adicional</label>
          {preferBorder ? <>
            <label className="minimum-gap-field">Separación mínima en SOLO BORDE <span><input type="number" min="0" step="0.5" inputMode="decimal" aria-label="Separación mínima en SOLO BORDE" value={borderMinimumGap} onChange={event => setBorderMinimumGap(event.target.value)} /><small>cm</small></span></label>
            <small className="spacing-hint">La separación varía en cada curva desde este mínimo. Alcance de pigtails: {pigtailReachMm === null ? '—' : formatCm(pigtailReachMm)} cm. Los saltos mayores necesitan cable adicional.</small>
          </> : <>
            <label className="minimum-gap-field">Separación mínima automática (pigtails − 1 cm) <span><output aria-label="Separación mínima automática entre módulos">{minimumPigtailGapMm === null ? '—' : formatCm(minimumPigtailGapMm)}</output><small>cm</small></span></label>
            <small className="spacing-hint">Los módulos con menos separación se omiten del recorrido.</small>
          </>}
        </section>

        <section className="panel-section module-section">
          <div className="section-heading"><h2>Módulo LED</h2></div>
          <ModuleSketch lengthCm={moduleLength} widthCm={moduleWidth} leftPigtailCm={leftPigtail} rightPigtailCm={rightPigtail} />
          <div className="module-fields">
            <label>Largo del módulo <span><input type="number" min="0" step="any" inputMode="decimal" value={moduleLength} onChange={event => setModuleLength(event.target.value)} aria-label="Largo del módulo" placeholder="0" /><small>cm</small></span></label>
            <label>Ancho del módulo <span><input type="number" min="0" step="any" inputMode="decimal" value={moduleWidth} onChange={event => setModuleWidth(event.target.value)} aria-label="Ancho del módulo" placeholder="0" /><small>cm</small></span></label>
            <label>Pigtail izquierdo <span><input type="number" min="0" step="any" inputMode="decimal" value={leftPigtail} onChange={event => setLeftPigtail(event.target.value)} aria-label="Pigtail izquierdo" placeholder="0" /><small>cm</small></span></label>
            <label>Pigtail derecho <span><input type="number" min="0" step="any" inputMode="decimal" value={rightPigtail} onChange={event => setRightPigtail(event.target.value)} aria-label="Pigtail derecho" placeholder="0" /><small>cm</small></span></label>
          </div>
        </section>

      </aside>

      <div className="main-panel">
        <div className="layer-controls">
          <div className="layer-switches" role="group" aria-label="Capas principales">
            <label className={showContour ? 'active' : ''}><input type="checkbox" checked={showContour} onChange={event => setShowContour(event.target.checked)} />CONTORNO</label>
            <label className={showSkeleton ? 'active skeleton-toggle' : 'skeleton-toggle'}><input type="checkbox" checked={showSkeleton} onChange={event => setShowSkeleton(event.target.checked)} />SKELETON</label>
            <label className={showLedRoutes ? 'active route-toggle' : 'route-toggle'}><input type="checkbox" checked={showLedRoutes} onChange={event => setShowLedRoutes(event.target.checked)} />PARTIDAS</label>
            <label className={showLedDistribution ? 'active led-toggle' : 'led-toggle'}><input type="checkbox" checked={showLedDistribution} onChange={event => setShowLedDistribution(event.target.checked)} />MÓDULOS LED</label>
            <label className={showSerpent ? 'active serpent-toggle' : 'serpent-toggle'}><input type="checkbox" checked={showSerpent} onChange={event => setShowSerpent(event.target.checked)} />RECORRIDO SERPIENTE</label>
            <label className={showPigtails ? 'active connection-toggle' : 'connection-toggle'}><input type="checkbox" checked={showPigtails} onChange={event => setShowPigtails(event.target.checked)} />PIGTAILS Y CONEXIONES</label>
            <button type="button" className={`border-mode-button${preferBorder ? ' active' : ''}`}
              aria-pressed={preferBorder} disabled={reading}
              title="Iluminación indirecta: una fila junto al contorno exterior de cada pieza"
              onClick={() => { setPreferBorder(value => !value); if (!preferBorder) { setShowLedDistribution(true); setShowSerpent(true); } }}>
              <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="2" y="2" width="16" height="16" rx="2" /><path d="M6 6h8v8H6Z" strokeDasharray="2 2" /></svg>
              SOLO BORDE
            </button>
            <button type="button" className={`led-count-button led-toggle${showLedDistribution ? ' active' : ''}`}
              aria-pressed={showLedDistribution} disabled={!canCountLeds || reading}
              title={canCountLeds ? 'Mostrar u ocultar los módulos LED' : 'Carga un archivo y completa las medidas para calcular los LEDs'}
              onClick={() => setShowLedDistribution(value => !value)}>
              TOTAL LED <strong aria-live="polite">{reading || (canCountLeds && layoutPlanning) ? '…' : canCountLeds && ledDistribution ? ledDistribution.total.toLocaleString('es-MX') : '—'}</strong>
            </button>
          </div>
        </div>
        {preferBorder && <p className="border-mode-hint">Iluminación indirecta · Fila junto al contorno exterior con separación variable. Los estrechamientos conservan todos los fragmentos donde cabe un LED.</p>}
        {loadingLabel && <div className="loading-indicator" role="status">
          <span>{loadingLabel}</span>
          <div className="loading-track" role="progressbar" aria-label={loadingLabel} aria-valuetext="En curso"><span /></div>
        </div>}
        {filename && (showSkeleton || needPlacement) && <div className="geometry-status">
          {showSkeleton && skeleton?.units === 'svg' && <span>Skeleton en unidades SVG · indica las medidas físicas para Partidas.</span>}
          {needPlacement && (!physicalSizeReady ? <span>Indica ancho y alto del SVG en cm.</span> : !preferBorder && !partitionInputValid ? <span>Revisa el ancho mínimo local.</span> : needDistribution && !moduleGeometry ? <span>Completa largo, ancho y ambos pigtails del módulo.</span> : null)}
          {preferBorder && !borderGapValid && <span>Indica una separación mínima válida, mayor o igual a cero.</span>}
          {geometryWarnings.length > 0 && <details className="division-hint"><summary>{geometryWarnings.length} aviso(s) de geometría</summary><ul>{geometryWarnings.map(warning => <li key={warning}>{measurementText(warning)}</li>)}</ul></details>}
          {!!ledDistribution?.rowBreaks?.length && !(showPigtails && allowBridges && serpents.length) && <span>{ledDistribution.rowBreaks.length} tramo(s) de fila superan el alcance de los pigtails; las guías quedan separadas.</span>}
          {showPigtails && serpents.length > 0 && <span>Recorrido: {routedModules.size} LED en {serpents.length} pieza(s) · {serpentBreakCount === 0 ? 'sin saltos pendientes' : `${serpentBreakCount} salto(s) pendiente(s)`}. Entrada verde; salida rosa. Los números y flechas indican el orden de conexión.</span>}
          {showPigtails && bridgeCount > 0 && <span className="cable-status">{bridgeCount} puente(s) en amarillo · Cable adicional: {(extraCableMm / 10).toFixed(1)} cm. Medida geométrica; añade margen de montaje. Cada pieza lleva su propia alimentación.</span>}
          {showPigtails && serpentBreakCount > 0 && <span>{serpentBreakCount} conexión(es) pendiente(s): no se encontró una ruta libre{allowBridges ? ' dentro de la figura' : ' dentro del límite de los pigtails'}.</span>}
        </div>}
        {error && <div role="alert" className="notice error"><span>{measurementText(error)}</span><button onClick={() => setError('')} aria-label="Cerrar error">×</button></div>}
        {model.warnings.length > 0 && <details className="notice warning"><summary>{model.warnings.length} {model.warnings.length === 1 ? 'aviso del SVG' : 'avisos del SVG'}</summary><ul>{model.warnings.map(warning => <li key={warning}>{measurementText(warning)}</li>)}</ul></details>}
        <section ref={canvasRef} className={`canvas-panel ${dragging ? 'dragging' : ''} ${panning ? 'panning' : ''}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={() => { panStart.current = null; setPanning(false); }} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={drop} aria-label="Lienzo SVG">
          <svg ref={drawingRef} className="drawing" viewBox={viewBox} role="img" aria-label="Contornos y capas seleccionadas">
            <defs>
              <filter id="contour-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2" /></filter>
            </defs>
            {showContour && contours.map(contour => <g key={contour.id} data-contour={contour.id}>
              <path d={contour.d} fill="none" stroke="#1aff77" strokeWidth="3.5" opacity="0.65" filter="url(#contour-glow)" vectorEffect="non-scaling-stroke" />
              <path d={contour.d} fill="none" stroke="#59ff91" strokeWidth="1.9" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </g>)}
            {showContour && selectedFigure && <path data-selected-figure={selectedFigure.id} d={selectedFigure.d} fill="none" stroke="#ffbd61" strokeWidth="3" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
            {showSkeleton && visibleSkeletonEdges.map(edge => <path key={edge.id} data-skeleton-edge={edge.id} data-skeleton-closed={edge.closed} d={edge.d} className="skeleton-line" />)}
            {showSkeleton && skeleton?.nodes.filter(node => node.kind === 'point').map(node => <circle key={node.id} data-skeleton-point={node.id} cx={node.point.x / skeleton.scale.x} cy={node.point.y / skeleton.scale.y} r={span * 0.004} className="skeleton-point"><title>Skeleton puntual · sin eje direccional</title></circle>)}
            {showLedRoutes && ledRoutes.map(path => <path key={path.id} data-led-route={path.divisionId} data-led-run={path.id} d={path.d} className="led-route"><title>Recorrido candidato a mitad entre el skeleton y el borde</title></path>)}
            {showSerpent && serpentGuides && [...new Set(serpentGuides.paths.map(path => path.regionId))].map(regionId => <g key={regionId} data-serpent-scope={regionId} aria-label="Guías del recorrido serpiente">
              {serpentGuides.paths.filter(path => path.regionId === regionId).map(path => <path key={path.id} data-serpent-guide={path.id} data-serpent-source={path.origin} d={path.d} className="serpent-line"><title>{path.origin === 'border' ? 'Recorrido por el borde para iluminación indirecta' : path.origin === 'partition' ? 'Partida automática' : 'Skeleton sin partidas'}</title></path>)}
            </g>)}
            {showPigtails && wireScale && ledDistribution && <g aria-label="Pigtails y conexiones" data-wiring-layer>
              {serpents.flatMap(serpent => serpent.links.map(link => {
                const parts = connectionParts(link, wireScale);
                return <g key={link.id} data-wiring-link={link.id} data-connection-kind={link.kind}>
                  <path data-connection={link.id} d={pathData(link.route)} className="wiring-connection"><title>Conexión entre módulos · {formatCm(link.lengthMm)} cm{link.kind === 'bridge' ? ` · Cable adicional: ${formatCm(link.bridgeLengthMm)} cm` : ' · Solo pigtails'}</title></path>
                  {parts.source.length > 1 && <path data-pigtail={`${link.fromId}:${link.fromSide}`} data-pigtail-for={link.fromId} data-pigtail-side={link.fromSide} d={pathData(parts.source)} className="wiring-pigtail source-pigtail" />}
                  {parts.target.length > 1 && <path data-pigtail={`${link.toId}:${link.toSide}`} data-pigtail-for={link.toId} data-pigtail-side={link.toSide} d={pathData(parts.target)} className="wiring-pigtail target-pigtail" />}
                  {parts.connection.length > 1 && <path data-bridge={link.id} d={pathData(parts.connection)} className="wiring-bridge"><title>Cable adicional · {formatCm(link.bridgeLengthMm)} cm</title></path>}
                </g>;
              }))}
              {serpents.flatMap(serpent => ([['entrada', serpent.entry], ['salida', serpent.exit]] as const)
                .flatMap(([kind, point]) => point ? [<circle key={`${serpent.scopeId}-${kind}`} data-wiring-endpoint={kind}
                  cx={point.x} cy={point.y} r={Math.max(2, mm(moduleWidth) / wireScale.x * 0.13)}
                  className={`wiring-endpoint wiring-${kind}`}><title>{kind === 'entrada' ? 'Entrada de alimentación de la pieza' : 'Salida del recorrido de la pieza'}</title></circle>] : []))}
              {ledDistribution.modules.flatMap(module => (['left', 'right'] as const).flatMap(side => {
                const key = `${module.id}:${side}`;
                if (linkedTerminals.has(key)) return [];
                const length = side === 'left' ? mm(leftPigtail) : mm(rightPigtail);
                const points = openPigtail(module, side, length, wireScale);
                return points.length > 1 ? [<path key={key} data-pigtail={key} data-pigtail-for={module.id} data-pigtail-side={side} d={pathData(points)} className="wiring-pigtail open-pigtail"><title>Pigtail libre · {formatCm(length)} cm</title></path>] : [];
              }))}
            </g>}
            {showLedDistribution && ledDistribution?.modules.map(module => {
              const routed = showPigtails ? routedModules.get(module.id) : undefined;
              const number = routed?.number ?? module.number;
              const labelPoint = routed?.reversed ? { x: 2 * module.center.x - module.labelPoint.x,
                y: 2 * module.center.y - module.labelPoint.y } : module.labelPoint;
              return <g key={module.id} data-led-module={module.id} data-led-route-id={module.divisionId} data-figure={module.figureId} data-region={module.regionId} data-wiring-order={routed?.number}>
              <polygon points={module.corners.map(point => `${point.x},${point.y}`).join(' ')} className="led-body" />
              <g transform={routed?.reversed ? `rotate(180 ${module.center.x} ${module.center.y})` : undefined}>
              <line x1={module.directionStart.x} y1={module.directionStart.y} x2={module.directionEnd.x} y2={module.directionEnd.y} className="led-direction" />
              <polygon points={module.arrow.map(point => `${point.x},${point.y}`).join(' ')} className="led-arrow" />
              </g>
              <text x={labelPoint.x} y={labelPoint.y} className="led-number" fontSize={moduleLabelSize} dominantBaseline="middle" textAnchor="middle">{number}</text>
              <title>{`Módulo ${number}${routed ? ' · Orden de conexión' : ` · Figura ${module.figureNumber}`}`}</title>
            </g>})}
            {filename && <Dimensions bounds={dimensionBounds} widthLabel={`${formatWholeMeasure(dimensionWidth)} ${dimensionUnit}`} heightLabel={`${formatWholeMeasure(dimensionHeight)} ${dimensionUnit}`} fontSize={dimensionFontSize} span={span} />}
            {showContour && measurementTargets.map(figure => <path key={figure.id} data-figure-hit={figure.id} d={figure.d} fill="transparent" fillRule={figure.fillRule} stroke="transparent" strokeWidth="16" vectorEffect="non-scaling-stroke" pointerEvents="all" className="figure-hit" role="button" tabIndex={0} aria-label={`Medir figura ${figure.name}`} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedFigureId(current => current === figure.id ? null : figure.id); } }} />)}
          </svg>
          {dragging && <div className="drop-overlay">Suelta el SVG</div>}
          {!filename ? <div className="empty-overlay">Carga un SVG o EPS para comenzar</div> : !showContour && !showSkeleton && !showLedRoutes && !showLedDistribution && !showSerpent && !showPigtails && <div className="empty-overlay">Activa una capa</div>}
          {filename && <span className="canvas-corner">{filename}</span>}
        </section>
      </div>
    </main>
  </div>;
}
