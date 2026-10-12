import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createModuleGeometry, parseSvg } from './engine';
import type { Bounds, SvgModel, SerpentResult, SkeletonResult } from './engine';
import { pathData } from './engine/regions';
import type { LayoutResult, LayoutPlacement } from './engine/layout.worker';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'No se pudo procesar el SVG.';
const formatMeasure = (value: number) => String(Math.round(value * 1000000) / 1000000);
const mm = (centimeters: string) => Number(centimeters) * 10;
const formatCm = (millimeters: number) => formatMeasure(millimeters / 10);
const measurementText = (text: string) => text.replace(/(-?\d+(?:\.\d+)?)\s*mm\b/g, (_match, value: string) => `${formatCm(Number(value))} cm`).replace(/\bmm\b/g, 'cm');
const emptyModel: SvgModel = {
  version: 1, units: 'svg', viewBox: { x: 0, y: 0, width: 100, height: 100 },
  physicalSize: null, aspectRatio: null, bounds: { x: 0, y: 0, width: 100, height: 100 },
  figures: [], warnings: [],
};

function ModuleSketch() {
  return <svg className="module-sketch" viewBox="0 0 232 118" role="img" aria-label="Un módulo con un pigtail a la izquierda y otro a la derecha; largo y ancho solo del cuerpo">
    <g fill="none" stroke="#dce7df" strokeWidth="2.2"><path d="M0 44H48 M184 44H232" /></g>
    <g fill="none" stroke="#ff525d" strokeWidth="3"><path d="M0 49H48 M184 49H232" /></g>
    <rect x="48" y="27" width="136" height="42" fill="#172a20" stroke="#a4b4a8" strokeWidth="1.5" />
    <g fill="none" stroke="#ff6972" strokeWidth="1.6">
      {[75, 116, 157].map(cx => <circle key={cx} cx={cx} cy="48" r="8" />)}
    </g>
    <g fill="none" stroke="#71877a" strokeWidth="1">
      <path d="M1 80V91 M48 80V91 M1 86H48 M48 80V91 M184 80V91 M48 86H184 M184 80V91 M231 80V91 M184 86H231" />
      <path d="M193 27V69 M189 27H197 M189 69H197" />
    </g>
    <g fill="#a2b6a7" fontSize="8" fontFamily="system-ui, sans-serif">
      <text x="195" y="20">Ancho</text>
      <text x="97" y="102">Largo</text>
      <text x="3" y="102">Pigtail</text><text x="20" y="113">izq.</text>
      <text x="188" y="102">Pigtail</text><text x="205" y="113">der.</text>
    </g>
  </svg>;
}

function Dimensions({ bounds, widthLabel, heightLabel, fontSize, span }: {
  bounds: Bounds; widthLabel: string; heightLabel: string; fontSize: number; span: number;
}) {
  const { x, y, width, height } = bounds;
  const offset = Math.max(fontSize * 1.6, Math.min(span * 0.05, Math.max(width, height) * 0.15));
  const tick = fontSize * 0.4;
  const horizontalY = y - offset;
  const verticalX = x + width + offset;
  return <g className="dimensions" aria-label="Cotas del plano">
    <g data-dimension="width">
      <path d={`M${x} ${y - tick}V${horizontalY - tick} M${x + width} ${y - tick}V${horizontalY - tick} M${x} ${horizontalY}H${x + width} M${x - tick / 2} ${horizontalY + tick / 2}l${tick} ${-tick} M${x + width - tick / 2} ${horizontalY + tick / 2}l${tick} ${-tick}`} className="dimension-line" />
      <text x={x + width / 2} y={horizontalY - fontSize * 0.4} fontSize={fontSize} textAnchor="middle" className="dimension-text">{widthLabel}</text>
    </g>
    <g data-dimension="height">
      <path d={`M${x + width + tick} ${y}H${verticalX + tick} M${x + width + tick} ${y + height}H${verticalX + tick} M${verticalX} ${y}V${y + height} M${verticalX - tick / 2} ${y + tick / 2}l${tick} ${-tick} M${verticalX - tick / 2} ${y + height + tick / 2}l${tick} ${-tick}`} className="dimension-line" />
      <text x={verticalX + fontSize * 0.8} y={y + height / 2} transform={`rotate(-90 ${verticalX + fontSize * 0.8} ${y + height / 2})`} fontSize={fontSize} textAnchor="middle" dominantBaseline="middle" className="dimension-text">{heightLabel}</text>
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
  const [serpents, setSerpents] = useState<SerpentResult[]>([]);
  const [serpentPlanning, setSerpentPlanning] = useState(false);
  const [layout, setLayout] = useState<LayoutResult | null>(null);
  const [layoutPlanning, setLayoutPlanning] = useState(false);
  const [selectedFigureId, setSelectedFigureId] = useState<string | null>(null);
  const [maxLanes, setMaxLanes] = useState<1 | 2>(2);
  const [freeGap, setFreeGap] = useState('0.6');
  const [edgeMargin, setEdgeMargin] = useState('0.6');
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
  const selectedFigure = figures.find(figure => figure.id === selectedFigureId);
  const divisionInputValid = moduleWidth !== '' && Number.isFinite(mm(moduleWidth)) && mm(moduleWidth) > 0 &&
    [freeGap, edgeMargin].every(value => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
  const needPlacement = showLedRoutes || showLedDistribution || showSerpent;
  const needSkeleton = !!filename && (showSkeleton || needPlacement);
  const physicalSizeReady = svgWidth !== '' && svgHeight !== '' && mm(svgWidth) > 0 && mm(svgHeight) > 0 && Number.isFinite(mm(svgWidth)) && Number.isFinite(mm(svgHeight));
  const skeleton = needSkeleton ? layout?.skeleton : null;
  const divisions = needPlacement ? layout?.divisions : null;
  const ledDistribution = needPlacement ? layout?.distribution : null;
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
  const dimensionFontSize = visibleViewBox.width * 0.017;
  const dimensionWidth = physicalSizeReady ? dimensionBounds.width * Number(svgWidth) / model.viewBox.width : dimensionBounds.width;
  const dimensionHeight = physicalSizeReady ? dimensionBounds.height * Number(svgHeight) / model.viewBox.height : dimensionBounds.height;
  const dimensionUnit = physicalSizeReady ? 'cm' : 'u SVG';
  const moduleGeometry = useMemo(() => {
    if ([moduleLength, moduleWidth, leftPigtail, rightPigtail].some(value => value === '')) return null;
    try {
      return createModuleGeometry({
        lengthMm: mm(moduleLength), widthMm: mm(moduleWidth),
        leftPigtailMm: mm(leftPigtail), rightPigtailMm: mm(rightPigtail),
      });
    } catch { return null; }
  }, [moduleLength, moduleWidth, leftPigtail, rightPigtail]);
  const placement = useMemo((): LayoutPlacement | null => needPlacement && divisionInputValid && physicalSizeReady ? {
    config: { moduleWidthMm: mm(moduleWidth), freeGapMm: mm(freeGap), edgeMarginMm: mm(edgeMargin), maxLanes, moduleLengthMm: mm(moduleLength) > 0 ? mm(moduleLength) : undefined },
    measurements: moduleGeometry ? { lengthMm: mm(moduleLength), widthMm: mm(moduleWidth), leftPigtailMm: mm(leftPigtail), rightPigtailMm: mm(rightPigtail) } : null,
    options: { minimumGapMm: Math.min(30, mm(leftPigtail) + mm(rightPigtail)), maximumGapMm: mm(leftPigtail) + mm(rightPigtail), bodyGapMm: mm(freeGap), edgeMarginMm: mm(edgeMargin) },
  } : null, [needPlacement, divisionInputValid, physicalSizeReady, moduleGeometry, moduleLength, moduleWidth, leftPigtail, rightPigtail, freeGap, edgeMargin, maxLanes]);
  const physicalWidth = physicalSizeReady ? mm(svgWidth) : null, physicalHeight = physicalSizeReady ? mm(svgHeight) : null;
  useEffect(() => {
    if (!needSkeleton) { setLayout(null); setLayoutPlanning(false); return; }
    setLayoutPlanning(true);
    const cached = skeletonCache.current;
    const skeleton = cached?.model === model && cached.width === physicalWidth && cached.height === physicalHeight ? cached.skeleton : undefined;
    setLayout(skeleton ? { skeleton, divisions: null, distribution: null } : null);
    const worker = new Worker(new URL('./engine/layout.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ result?: LayoutResult; error?: string }>) => {
      setLayoutPlanning(false);
      if (event.data.error) setError(event.data.error);
      else if (event.data.result) { setLayout(event.data.result); skeletonCache.current = { model, width: physicalWidth, height: physicalHeight, skeleton: event.data.result.skeleton }; }
      worker.terminate();
    };
    worker.onerror = () => { setLayoutPlanning(false); setError('No se pudo calcular la distribución.'); worker.terminate(); };
    worker.postMessage({ model, physicalSize: physicalWidth && physicalHeight ? { widthMm: physicalWidth, heightMm: physicalHeight } : undefined, skeleton, placement });
    return () => worker.terminate();
  }, [needSkeleton, model, physicalWidth, physicalHeight, placement]);
  const usedRouteIds = new Set(ledDistribution?.modules.map(module => module.divisionId) ?? []);
  const ledRoutes = ledDistribution?.routeRuns?.map(run => ({ id: run.id, divisionId: run.divisionId, d: run.d })) ?? divisions?.paths.filter(path => usedRouteIds.has(path.id)).map(path => ({ id: path.id, divisionId: path.id, d: path.d })) ?? [];
  const moduleLabelSize = moduleGeometry && physicalSizeReady ? Math.min(mm(moduleWidth) * 0.48, mm(moduleLength) * 0.28) * model.viewBox.height / mm(svgHeight) : 0;
  useEffect(() => {
    setSerpents([]);
    if (!showSerpent || !divisions || !ledDistribution || !moduleGeometry) { setSerpentPlanning(false); return; }
    setSerpentPlanning(true);
    const worker = new Worker(new URL('./engine/serpent.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ result?: SerpentResult[]; error?: string }>) => { setSerpentPlanning(false); if (event.data.error) setError(event.data.error); else setSerpents(event.data.result ?? []); worker.terminate(); };
    worker.onerror = () => { setSerpentPlanning(false); setError('No se pudo calcular el recorrido serpiente.'); worker.terminate(); };
    worker.postMessage({ model, divisions, distribution: ledDistribution,
      measurements: { lengthMm: mm(moduleLength), widthMm: mm(moduleWidth), leftPigtailMm: mm(leftPigtail), rightPigtailMm: mm(rightPigtail) },
      widthMm: mm(svgWidth), heightMm: mm(svgHeight) });
    return () => worker.terminate();
  }, [showSerpent, divisions, ledDistribution, moduleGeometry, model, moduleLength, moduleWidth, leftPigtail, rightPigtail, svgWidth, svgHeight]);
  const serpentBreakCount = serpents.reduce((total, serpent) => total + serpent.breaks.length, 0);

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
    if (file.size > 2_000_000) { setReading(false); setError('El SVG supera el límite de 2 MB.'); return; }
    setReading(true);
    try {
      const text = await file.text();
      if (sequence === importSequence.current) importSvg(text, file.name);
    } catch { if (sequence === importSequence.current) setError('No se pudo leer el archivo.'); }
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
    if (event.type === 'pointerup' && panStart.current?.figureId && !panStart.current.moved) setSelectedFigureId(panStart.current.figureId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panStart.current = null;
    setPanning(false);
  }

  return <div className="app">
    <main className="workspace">
      <aside className="sidebar">
        <section className="panel-section file-section">
          <div className="section-heading"><h1 className="brand"><span className="brand-icon" aria-hidden="true">S</span>SkLed</h1></div>
          <input ref={fileInput} type="file" accept=".svg,image/svg+xml" onChange={changeFile} hidden aria-label="Cargar archivo SVG" />
          <button className="upload-button" onClick={() => fileInput.current?.click()} disabled={reading}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4" /></svg>
            {reading ? 'Leyendo…' : 'Cargar SVG'}
          </button>
        </section>

        <section className="panel-section size-section">
          <div className="section-heading"><h2>Medidas SVG</h2><div className="size-heading-actions"><span className="count-badge">cm</span><button type="button" className={`aspect-lock ${aspectLocked ? 'locked' : ''}`} aria-label="Mantener proporción" aria-pressed={aspectLocked} title={aspectLocked ? 'Desbloquear proporción' : 'Bloquear proporción'} onClick={toggleAspectLock}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="6" y="10" width="12" height="11" rx="2" /><path d={aspectLocked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M8 10V6a4 4 0 0 1 8 0'} /><path d="M12 14v3" /></svg>
          </button></div></div>
          <div className="size-fields">
            <label>Ancho <span><input aria-label="Ancho del SVG" type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={svgWidth} onChange={event => changeSvgSize('width', event.target.value)} /><small>cm</small></span></label>
            <label>Alto <span><input aria-label="Alto del SVG" type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={svgHeight} onChange={event => changeSvgSize('height', event.target.value)} /><small>cm</small></span></label>
          </div>
          <small className="size-hint">{aspectLocked ? 'Proporción bloqueada' : 'Medidas independientes'}</small>
        </section>

        <section className="panel-section partitions-section">
          <div className="section-heading"><h2>Partidas</h2></div>
          <label className="partition-limit">Máximo de recorridos<select aria-label="Máximo de recorridos" value={maxLanes} onChange={event => setMaxLanes(Number(event.target.value) as 1 | 2)}><option value="1">1 recorrido</option><option value="2">2 · automático por ancho</option></select></label>
          <div className="module-fields">
            <label>Separación libre <span><input aria-label="Separación libre entre recorridos" type="number" min="0" step="any" inputMode="decimal" value={freeGap} onChange={event => setFreeGap(event.target.value)} /><small>cm</small></span></label>
            <label>Margen objetivo al borde <span><input aria-label="Margen objetivo al borde" type="number" min="0" step="any" inputMode="decimal" value={edgeMargin} onChange={event => setEdgeMargin(event.target.value)} /><small>cm</small></span></label>
          </div>
          {divisionInputValid && <small className="size-hint">2 recorridos desde {formatCm(2 * mm(moduleWidth) + mm(freeGap) + 2 * mm(edgeMargin))} cm de ancho</small>}
        </section>

        <section className="panel-section module-section">
          <div className="section-heading"><h2>Módulo LED</h2></div>
          <ModuleSketch />
          <div className="module-fields">
            <label>Largo del módulo <span><input type="number" min="0" step="any" inputMode="decimal" value={moduleLength} onChange={event => setModuleLength(event.target.value)} aria-label="Largo del módulo" placeholder="0" /><small>cm</small></span></label>
            <label>Ancho del módulo <span><input type="number" min="0" step="any" inputMode="decimal" value={moduleWidth} onChange={event => setModuleWidth(event.target.value)} aria-label="Ancho del módulo" placeholder="0" /><small>cm</small></span></label>
            <label>Pigtail izquierdo <span><input type="number" min="0" step="any" inputMode="decimal" value={leftPigtail} onChange={event => setLeftPigtail(event.target.value)} aria-label="Pigtail izquierdo" placeholder="0" /><small>cm</small></span></label>
            <label>Pigtail derecho <span><input type="number" min="0" step="any" inputMode="decimal" value={rightPigtail} onChange={event => setRightPigtail(event.target.value)} aria-label="Pigtail derecho" placeholder="0" /><small>cm</small></span></label>
          </div>
          {moduleGeometry && <output className="module-segments" aria-label="Tramos del módulo">
            <span>Izq. <b>{formatCm(moduleGeometry.leftPigtail.lengthMm)}</b></span>
            <span>Módulo <b>{formatCm(moduleGeometry.body.lengthMm)}</b></span>
            <span>Der. <b>{formatCm(moduleGeometry.rightPigtail.lengthMm)}</b></span>
          </output>}
          {moduleGeometry && <small className="size-hint">Separación libre en fila: mínima deseable 3 cm · máximo {formatCm(mm(leftPigtail) + mm(rightPigtail))} cm{mm(leftPigtail) + mm(rightPigtail) < 30 && '. Los pigtails no alcanzan la mínima deseable.'}</small>}
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
          </div>
        </div>
        {filename && (showSkeleton || needPlacement) && <div className="geometry-status">
          {layoutPlanning && <span role="status">Calculando guías y distribución LED…</span>}
          {showSerpent && serpentPlanning && <span role="status">Calculando guías del recorrido serpiente…</span>}
          {showSkeleton && skeleton?.units === 'svg' && <span>Skeleton en unidades SVG · indica las medidas físicas para Partidas.</span>}
          {needPlacement && (!physicalSizeReady ? <span>Indica ancho y alto del SVG en cm.</span> : !divisionInputValid ? <span>Completa el ancho del módulo, separación y margen.</span> : !moduleGeometry ? <span>Completa largo, ancho y ambos pigtails del módulo.</span> : null)}
          {geometryWarnings.length > 0 && <details className="division-hint"><summary>{geometryWarnings.length} aviso(s) de geometría</summary><ul>{geometryWarnings.map(warning => <li key={warning}>{measurementText(warning)}</li>)}</ul></details>}
          {!!ledDistribution?.rowBreaks?.length && <span>{ledDistribution.rowBreaks.length} tramo(s) de fila superan el alcance de los pigtails; las guías quedan separadas.</span>}
          {showSerpent && serpentBreakCount > 0 && <span>{serpentBreakCount} salto(s) pendientes en el serpiente: no se encontró una ruta libre dentro del límite de los pigtails.</span>}
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
            {showSkeleton && skeleton?.edges.map(edge => <path key={edge.id} data-skeleton-edge={edge.id} data-skeleton-closed={edge.closed} d={edge.d} className="skeleton-line" />)}
            {showSkeleton && skeleton?.nodes.filter(node => node.kind === 'point').map(node => <circle key={node.id} data-skeleton-point={node.id} cx={node.point.x / skeleton.scale.x} cy={node.point.y / skeleton.scale.y} r={span * 0.004} className="skeleton-point"><title>Skeleton puntual · sin eje direccional</title></circle>)}
            {showLedRoutes && ledRoutes.map(path => <path key={path.id} data-led-route={path.divisionId} data-led-run={path.id} d={path.d} className="led-route"><title>Partida usada por los módulos LED</title></path>)}
            {showSerpent && serpents.map(serpent => <g key={serpent.scopeId} data-serpent-scope={serpent.scopeId} aria-label="Guías del recorrido serpiente">
              {serpent.links.map(link => <path key={link.id} data-serpent-link={link.id} data-serpent-from={link.fromId} data-serpent-to={link.toId} data-serpent-kind={link.kind} d={pathData(link.route)} className="serpent-line"><title>Guía entre LED · {formatCm(link.lengthMm)} cm</title></path>)}
              {serpent.steps.map(step => <path key={step.moduleId} data-serpent-through={step.moduleId} d={pathData([step.entry, step.exit])} className="serpent-line" />)}
            </g>)}
            {showLedDistribution && ledDistribution?.modules.map(module => <g key={module.id} data-led-module={module.id} data-led-route-id={module.divisionId} data-figure={module.figureId} data-region={module.regionId}>
              <polygon points={module.corners.map(point => `${point.x},${point.y}`).join(' ')} className="led-body" />
              <line x1={module.directionStart.x} y1={module.directionStart.y} x2={module.directionEnd.x} y2={module.directionEnd.y} className="led-direction" />
              <polygon points={module.arrow.map(point => `${point.x},${point.y}`).join(' ')} className="led-arrow" />
              <text x={module.labelPoint.x} y={module.labelPoint.y} className="led-number" fontSize={moduleLabelSize} dominantBaseline="middle" textAnchor="middle">{module.number}</text>
              <title>{`Módulo ${module.number} · Figura ${module.figureNumber}`}</title>
            </g>)}
            {filename && <Dimensions bounds={dimensionBounds} widthLabel={`${formatMeasure(dimensionWidth)} ${dimensionUnit}`} heightLabel={`${formatMeasure(dimensionHeight)} ${dimensionUnit}`} fontSize={dimensionFontSize} span={span} />}
            {showContour && figures.map(figure => <path key={figure.id} data-figure-hit={figure.id} d={figure.d} fill={figure.filled ? 'transparent' : 'none'} fillRule={figure.fillRule} stroke="transparent" strokeWidth="16" vectorEffect="non-scaling-stroke" className="figure-hit" role="button" tabIndex={0} aria-label={`Medir figura ${figure.name}`} onClick={() => setSelectedFigureId(figure.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedFigureId(figure.id); } }} />)}
          </svg>
          {selectedFigure && <div className="dimension-selection"><span>{selectedFigure.name}</span><button type="button" onClick={() => setSelectedFigureId(null)}>Todo el SVG</button></div>}
          {dragging && <div className="drop-overlay">Suelta el SVG</div>}
          {!filename ? <div className="empty-overlay">Carga un SVG para comenzar</div> : !showContour && !showSkeleton && !showLedRoutes && !showLedDistribution && !showSerpent && <div className="empty-overlay">Activa una capa</div>}
          {filename && <span className="canvas-corner">{filename}</span>}
        </section>
      </div>
    </main>
  </div>;
}
