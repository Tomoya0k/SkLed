import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createModuleGeometry, distributeLeds, generateSkeleton, generatePartitions, parseSvg, proportionalHeight } from './engine';
import type { Bounds, SvgModel } from './engine';
import { exampleSvg } from './example';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'No se pudo procesar el SVG.';
const formatMm = (value: number) => String(Math.round(value * 1000) / 1000);

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

export default function App() {
  const [model, setModel] = useState<SvgModel>(() => parseSvg(exampleSvg));
  const [filename, setFilename] = useState('ejemplo.svg');
  const [svgSource, setSvgSource] = useState('');
  const [error, setError] = useState('');
  const [showSvg, setShowSvg] = useState(false);
  const [showContour, setShowContour] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [showLedRoutes, setShowLedRoutes] = useState(false);
  const [showLedDistribution, setShowLedDistribution] = useState(false);
  const [maxLanes, setMaxLanes] = useState<1 | 2>(2);
  const [freeGap, setFreeGap] = useState('6');
  const [edgeMargin, setEdgeMargin] = useState('6');
  const [svgWidth, setSvgWidth] = useState('');
  const [svgHeight, setSvgHeight] = useState('');
  const [sizeEdited, setSizeEdited] = useState(false);
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
  const panStart = useRef<{ clientX: number; clientY: number; view: Bounds; inverse: DOMMatrix } | null>(null);

  const figures = model.figures;
  const contours = figures.flatMap(figure => figure.contours);
  const divisionInputValid = moduleWidth !== '' && Number.isFinite(Number(moduleWidth)) && Number(moduleWidth) > 0 &&
    [freeGap, edgeMargin].every(value => value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
  const needPlacement = showLedRoutes || showLedDistribution;
  const needSkeleton = showSkeleton || needPlacement;
  const physicalSizeReady = svgWidth !== '' && svgHeight !== '' && Number(svgWidth) > 0 && Number(svgHeight) > 0 && Number.isFinite(Number(svgWidth)) && Number.isFinite(Number(svgHeight));
  const skeleton = useMemo(() => needSkeleton ? generateSkeleton(model,
    physicalSizeReady ? { widthMm: Number(svgWidth), heightMm: Number(svgHeight) } : undefined) : null,
    [needSkeleton, model, physicalSizeReady, svgWidth, svgHeight]);
  const divisions = useMemo(() => skeleton && needPlacement && divisionInputValid && physicalSizeReady
    ? generatePartitions(skeleton, { moduleWidthMm: Number(moduleWidth), freeGapMm: Number(freeGap), edgeMarginMm: Number(edgeMargin), maxLanes }) : null,
    [skeleton, needPlacement, divisionInputValid, physicalSizeReady, moduleWidth, freeGap, edgeMargin, maxLanes]);
  const geometryWarnings = divisions?.warnings ?? skeleton?.warnings ?? [];
  const { x, y, width, height } = model.bounds;
  const span = Math.max(width, height, 1);
  const pad = span * 0.09;
  const canvasWidth = Math.max(width, span * 0.1) + pad * 2;
  const canvasHeight = Math.max(height, span * 0.1) + pad * 2;
  const initialViewBox: Bounds = { x: x - pad, y: y - pad, width: canvasWidth, height: canvasHeight };
  const visibleViewBox = zoomWindow ?? initialViewBox;
  const viewBox = `${visibleViewBox.x} ${visibleViewBox.y} ${visibleViewBox.width} ${visibleViewBox.height}`;
  const metadataIsPixels = !!model.physicalSize && [model.physicalSize.rawWidth, model.physicalSize.rawHeight].some(value => /^\s*[\d.+-]+\s*(?:px)?\s*$/i.test(value));
  const moduleGeometry = useMemo(() => {
    if ([moduleLength, moduleWidth, leftPigtail, rightPigtail].some(value => value === '')) return null;
    try {
      return createModuleGeometry({
        lengthMm: Number(moduleLength), widthMm: Number(moduleWidth),
        leftPigtailMm: Number(leftPigtail), rightPigtailMm: Number(rightPigtail),
      });
    } catch { return null; }
  }, [moduleLength, moduleWidth, leftPigtail, rightPigtail]);
  const ledDistribution = useMemo(() => {
    if (!needPlacement || !divisions || !moduleGeometry || !physicalSizeReady) return null;
    return distributeLeds(model, divisions, {
      lengthMm: Number(moduleLength), widthMm: Number(moduleWidth),
      leftPigtailMm: Number(leftPigtail), rightPigtailMm: Number(rightPigtail),
    }, Number(svgWidth), Number(svgHeight));
  }, [needPlacement, divisions, moduleGeometry, physicalSizeReady, model, moduleLength, moduleWidth, leftPigtail, rightPigtail, svgWidth, svgHeight]);
  const usedRouteIds = new Set(ledDistribution?.modules.map(module => module.divisionId) ?? []);
  const ledRoutes = divisions?.paths.filter(path => usedRouteIds.has(path.id)) ?? [];
  const moduleLabelSize = moduleGeometry && physicalSizeReady ? Math.min(Number(moduleWidth) * 0.48, Number(moduleLength) * 0.28) * model.viewBox.height / Number(svgHeight) : 0;

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

  function changeSvgWidth(value: string) {
    setSvgWidth(value);
    setSizeEdited(true);
    if (!model.physicalSize) {
      const height = proportionalHeight(Number(value), model.aspectRatio);
      setSvgHeight(height === null ? '' : formatMm(height));
    }
  }

  function importSvg(source: string, name: string) {
    try {
      const parsed = parseSvg(source);
      setModel(parsed);
      setFilename(name);
      setSvgWidth(parsed.physicalSize ? formatMm(parsed.physicalSize.widthMm) : '');
      setSvgHeight(parsed.physicalSize ? formatMm(parsed.physicalSize.heightMm) : '');
      setSizeEdited(false);
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
    panStart.current = { clientX: event.clientX, clientY: event.clientY, view: zoomWindow ?? initialViewBox, inverse: matrix.inverse() };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  }

  function movePan(event: ReactPointerEvent<HTMLElement>) {
    const start = panStart.current;
    if (!start) return;
    const dx = event.clientX - start.clientX, dy = event.clientY - start.clientY;
    const worldDx = dx * start.inverse.a + dy * start.inverse.c;
    const worldDy = dx * start.inverse.b + dy * start.inverse.d;
    setZoomWindow({ ...start.view, x: start.view.x - worldDx, y: start.view.y - worldDy });
  }

  function endPan(event: ReactPointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    panStart.current = null;
    setPanning(false);
  }

  return <div className="app">
    <header className="header"><div className="brand"><span className="brand-icon">S<span>·</span></span><strong>SkLed</strong></div><span className="local-badge"><span /> LOCAL</span></header>
    <main className="workspace">
      <aside className="sidebar">
        <section className="panel-section file-section">
          <div className="section-heading"><h1>SVG</h1></div>
          <input ref={fileInput} type="file" accept=".svg,image/svg+xml" onChange={changeFile} hidden aria-label="Cargar archivo SVG" />
          <button className="upload-button" onClick={() => fileInput.current?.click()} disabled={reading}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4" /></svg>
            {reading ? 'Leyendo…' : 'Cargar SVG'}
          </button>
          <details className="paste-details"><summary>Pegar SVG</summary><textarea aria-label="Código SVG" placeholder={'<svg viewBox="0 0 100 100">…</svg>'} value={svgSource} onChange={event => setSvgSource(event.target.value)} spellCheck={false} maxLength={2_000_000} /><button className="small-button" disabled={!svgSource.trim()} onClick={() => { ++importSequence.current; setReading(false); importSvg(svgSource, 'pegado.svg'); }}>Procesar</button></details>
        </section>

        <section className="panel-section size-section">
          <div className="section-heading"><h2>Medidas SVG</h2><span className="count-badge" title={model.physicalSize ? `${model.physicalSize.rawWidth} × ${model.physicalSize.rawHeight}` : 'Sin ancho y alto físicos en el SVG'}>{model.physicalSize && !sizeEdited ? (metadataIsPixels ? 'SVG · px' : 'del SVG') : 'mm'}</span></div>
          <div className="size-fields">
            <label>Ancho <span><input aria-label="Ancho del SVG" type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={svgWidth} onChange={event => changeSvgWidth(event.target.value)} /><small>mm</small></span></label>
            <label>Alto <span><input aria-label="Alto del SVG" type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={svgHeight} onChange={event => { setSvgHeight(event.target.value); setSizeEdited(true); }} /><small>mm</small></span></label>
          </div>
          {!model.physicalSize && svgWidth !== '' && <small className="size-hint">{model.aspectRatio ? 'Alto proporcional al SVG' : 'Indica el alto: no hay proporción'}</small>}
        </section>

        <section className="panel-section partitions-section">
          <div className="section-heading"><h2>Partidas</h2></div>
          <label className="partition-limit">Máximo de recorridos<select aria-label="Máximo de recorridos" value={maxLanes} onChange={event => setMaxLanes(Number(event.target.value) as 1 | 2)}><option value="1">1 recorrido</option><option value="2">2 · automático por ancho</option></select></label>
          <div className="module-fields">
            <label>Separación libre <span><input aria-label="Separación libre entre recorridos" type="number" min="0" step="any" inputMode="decimal" value={freeGap} onChange={event => setFreeGap(event.target.value)} /><small>mm</small></span></label>
            <label>Margen objetivo al borde <span><input aria-label="Margen objetivo al borde" type="number" min="0" step="any" inputMode="decimal" value={edgeMargin} onChange={event => setEdgeMargin(event.target.value)} /><small>mm</small></span></label>
          </div>
          {divisionInputValid && <small className="size-hint">2 recorridos desde {formatMm(2 * Number(moduleWidth) + Number(freeGap) + 2 * Number(edgeMargin))} mm de ancho</small>}
        </section>

        <section className="panel-section module-section">
          <div className="section-heading"><h2>Módulo LED</h2></div>
          <ModuleSketch />
          <div className="module-fields">
            <label>Largo del módulo <span><input type="number" min="0" step="any" inputMode="decimal" value={moduleLength} onChange={event => setModuleLength(event.target.value)} aria-label="Largo del módulo" placeholder="0" /><small>mm</small></span></label>
            <label>Ancho del módulo <span><input type="number" min="0" step="any" inputMode="decimal" value={moduleWidth} onChange={event => setModuleWidth(event.target.value)} aria-label="Ancho del módulo" placeholder="0" /><small>mm</small></span></label>
            <label>Pigtail izquierdo <span><input type="number" min="0" step="any" inputMode="decimal" value={leftPigtail} onChange={event => setLeftPigtail(event.target.value)} aria-label="Pigtail izquierdo" placeholder="0" /><small>mm</small></span></label>
            <label>Pigtail derecho <span><input type="number" min="0" step="any" inputMode="decimal" value={rightPigtail} onChange={event => setRightPigtail(event.target.value)} aria-label="Pigtail derecho" placeholder="0" /><small>mm</small></span></label>
          </div>
          {moduleGeometry && <output className="module-segments" aria-label="Tramos del módulo">
            <span>Izq. <b>{moduleGeometry.leftPigtail.lengthMm}</b></span>
            <span>Módulo <b>{moduleGeometry.body.lengthMm}</b></span>
            <span>Der. <b>{moduleGeometry.rightPigtail.lengthMm}</b></span>
          </output>}
        </section>

      </aside>

      <div className="main-panel">
        <div className="layer-controls">
          <div className="layer-switches" role="group" aria-label="Capas principales">
            <label className={showContour ? 'active' : ''}><input type="checkbox" checked={showContour} onChange={event => setShowContour(event.target.checked)} />CONTORNO</label>
            <label className={showSkeleton ? 'active skeleton-toggle' : 'skeleton-toggle'}><input type="checkbox" checked={showSkeleton} onChange={event => setShowSkeleton(event.target.checked)} />SKELETON</label>
            <label className={showLedRoutes ? 'active route-toggle' : 'route-toggle'}><input type="checkbox" checked={showLedRoutes} onChange={event => setShowLedRoutes(event.target.checked)} />RECORRIDOS LED</label>
            <label className={showLedDistribution ? 'active led-toggle' : 'led-toggle'}><input type="checkbox" checked={showLedDistribution} onChange={event => setShowLedDistribution(event.target.checked)} />MÓDULOS LED</label>
          </div>
          <details className="advanced-layers"><summary>Opciones avanzadas</summary>
            <div role="group" aria-label="Capas avanzadas">
              <label><input type="checkbox" checked={showSvg} onChange={event => setShowSvg(event.target.checked)} />SVG original</label>
            </div>
          </details>
        </div>
        {(showSkeleton || needPlacement) && <div className="geometry-status">
          {showSkeleton && skeleton?.units === 'svg' && <span>Skeleton en unidades SVG · indica las medidas físicas para Partidas.</span>}
          {needPlacement && (!physicalSizeReady ? <span>Indica ancho y alto del SVG en mm.</span> : !divisionInputValid ? <span>Completa el ancho del módulo, separación y margen.</span> : !moduleGeometry ? <span>Completa largo, ancho y ambos pigtails del módulo.</span> : null)}
          {geometryWarnings.length > 0 && <details className="division-hint"><summary>{geometryWarnings.length} aviso(s) de geometría</summary><ul>{geometryWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
        </div>}
        {error && <div role="alert" className="notice error"><span>{error}</span><button onClick={() => setError('')} aria-label="Cerrar error">×</button></div>}
        {model.warnings.length > 0 && <details className="notice warning"><summary>{model.warnings.length} {model.warnings.length === 1 ? 'aviso del SVG' : 'avisos del SVG'}</summary><ul>{model.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
        <section ref={canvasRef} className={`canvas-panel ${dragging ? 'dragging' : ''} ${panning ? 'panning' : ''}`} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={() => { panStart.current = null; setPanning(false); }} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={drop} aria-label="Lienzo SVG">
          <svg ref={drawingRef} className="drawing" viewBox={viewBox} role="img" aria-label="SVG y contornos seleccionados">
            <defs>
              <filter id="contour-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2" /></filter>
            </defs>
            {showSvg && figures.map(figure => <path key={figure.id} data-svg-figure={figure.id} d={figure.d} fill={figure.filled ? '#7897ec' : 'none'} fillOpacity="0.13" fillRule={figure.fillRule} stroke="#a9bfff" strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />)}
            {showContour && contours.map(contour => <g key={contour.id} data-contour={contour.id}>
              <path d={contour.d} fill="none" stroke="#1aff77" strokeWidth="3.5" opacity="0.65" filter="url(#contour-glow)" vectorEffect="non-scaling-stroke" />
              <path d={contour.d} fill="none" stroke="#59ff91" strokeWidth="1.9" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </g>)}
            {showSkeleton && skeleton?.edges.map(edge => <path key={edge.id} data-skeleton-edge={edge.id} data-skeleton-closed={edge.closed} d={edge.d} className="skeleton-line" />)}
            {showSkeleton && skeleton?.nodes.filter(node => node.kind === 'point').map(node => <circle key={node.id} data-skeleton-point={node.id} cx={node.point.x / skeleton.scale.x} cy={node.point.y / skeleton.scale.y} r={span * 0.004} className="skeleton-point"><title>Skeleton puntual · sin eje direccional</title></circle>)}
            {showLedRoutes && ledRoutes.map(path => <path key={path.id} data-led-route={path.id} d={path.d} className="led-route"><title>Recorrido usado por los módulos LED</title></path>)}
            {showLedDistribution && ledDistribution?.modules.map(module => <g key={module.id} data-led-module={module.id} data-led-route-id={module.divisionId} data-figure={module.figureId}>
              <polygon points={module.corners.map(point => `${point.x},${point.y}`).join(' ')} className="led-body" />
              <line x1={module.directionStart.x} y1={module.directionStart.y} x2={module.directionEnd.x} y2={module.directionEnd.y} className="led-direction" />
              <polygon points={module.arrow.map(point => `${point.x},${point.y}`).join(' ')} className="led-arrow" />
              <text x={module.labelPoint.x} y={module.labelPoint.y} className="led-number" fontSize={moduleLabelSize} dominantBaseline="middle" textAnchor="middle">{module.number}</text>
              <title>{`Módulo ${module.number} · Figura ${module.figureNumber}`}</title>
            </g>)}
          </svg>
          {dragging && <div className="drop-overlay">Suelta el SVG</div>}
          {!showSvg && !showContour && !showSkeleton && !showLedRoutes && !showLedDistribution && <div className="empty-overlay">Activa una capa</div>}
          <span className="canvas-corner">{filename}</span>
        </section>
      </div>
    </main>
  </div>;
}
