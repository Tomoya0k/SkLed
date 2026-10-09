import svgpath from 'svgpath';

/** Native SVG lengths resolve units and percentages in the source viewport. */
function length(element: SVGGeometryElement, name: string): number {
  const property = (element as unknown as Record<string, SVGAnimatedLength>)[name];
  const value = property.baseVal.value;
  if (!Number.isFinite(value)) throw new Error(`Valor no válido en ${name}.`);
  return value;
}

export function geometryToPath(element: SVGGeometryElement): string {
  const n = (name: string) => length(element, name);
  switch (element.localName) {
    case 'path': return element.getAttribute('d') ?? '';
    case 'line': return `M ${n('x1')} ${n('y1')} L ${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const points = (element as SVGPolylineElement).points;
      if (!points.numberOfItems) return '';
      const values = Array.from({ length: points.numberOfItems }, (_, index) => {
        const point = points.getItem(index);
        return `${index ? 'L' : 'M'} ${point.x} ${point.y}`;
      });
      return `${values.join(' ')} ${element.localName === 'polygon' ? 'Z' : ''}`;
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = element.localName === 'circle' ? n('r') : n('rx');
      const ry = element.localName === 'circle' ? rx : n('ry');
      if (rx <= 0 || ry <= 0) return '';
      return `M ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} Z`;
    }
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (w <= 0 || h <= 0) return '';
      const rx = Math.min(Math.max(0, element.hasAttribute('rx') ? n('rx') : n('ry')), w / 2);
      const ry = Math.min(Math.max(0, element.hasAttribute('ry') ? n('ry') : n('rx')), h / 2);
      if (!rx || !ry) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
      return `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry}
        V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx}
        A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
    }
    default: throw new Error(`Geometría no admitida: ${element.localName}.`);
  }
}

/** Keep vector commands, including elliptical arcs, instead of flattening to polylines. */
export function normalizePath(d: string, matrix: DOMMatrix): string[] {
  const path = svgpath(d);
  const error = (path as unknown as { err: string }).err;
  if (error) throw new Error(`Trazado SVG inválido: ${error}`);
  const contours: string[] = [];
  let commands: string[] = [];
  path.matrix([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f]).abs().unshort().iterate((segment) => {
    if (segment[0] === 'M' && commands.length) {
      contours.push(commands.join(' '));
      commands = [];
    }
    if (segment.slice(1).some(value => typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('El trazado contiene coordenadas no finitas.');
    }
    commands.push(segment.join(' '));
  });
  if (commands.length) contours.push(commands.join(' '));
  return contours;
}
