const NS = 'http://www.w3.org/2000/svg';
const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'symbol', 'use', 'title', 'desc']);
const attributes = new Set([
  'id', 'class', 'viewBox', 'preserveAspectRatio', 'transform', 'd', 'points',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'rx', 'ry', 'r', 'cx', 'cy',
  'fill', 'fill-rule', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity',
  'display', 'visibility', 'color', 'clip-path', 'mask', 'filter',
]);
const styleProperties = new Set([
  'fill', 'fill-rule', 'stroke', 'stroke-width', 'opacity', 'fill-opacity',
  'stroke-opacity', 'display', 'visibility', 'color',
]);

/** Only geometry and passive presentation enter the live document. No foreign DOM or URLs. */
export function sanitizeSvg(source: string, warnings: Set<string>): SVGSVGElement {
  if (source.length > 2_000_000) throw new Error('El SVG supera el límite de 2 MB de esta versión.');
  // A conventional SVG DOCTYPE is harmless; custom entities are not part of this format.
  if (/<!ENTITY/i.test(source)) throw new Error('El SVG contiene entidades XML no admitidas.');
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') {
    throw new Error('El archivo no es un SVG válido. Revisa la estructura XML.');
  }
  if (parsed.querySelectorAll('*').length > 10_000) throw new Error('El SVG contiene demasiados elementos (máximo 10 000).');

  function cleanDeclarations(style: CSSStyleDeclaration): string {
    const safe = document.createElement('span').style;
    for (const property of style) {
      const value = style.getPropertyValue(property);
      if (['clip-path', 'mask', 'filter'].includes(property) && value !== 'none') {
        throw new Error('Hay máscaras, recortes o filtros. Aplica esos efectos a los trazados antes de importar.');
      }
      if (!styleProperties.has(property)) {
        warnings.add(`Estilo CSS «${property}» omitido. Para geometría exacta, conviértelo a atributos SVG.`);
        continue;
      }
      if (/url\s*\(|var\s*\(|image\s*\(/i.test(value)) {
        warnings.add('Los rellenos de referencia se omiten; el recorrido usa la geometría del contorno.');
        continue;
      }
      safe.setProperty(property, value, style.getPropertyPriority(property));
    }
    return safe.cssText;
  }

  function clean(element: Element): Element | null {
    if (element.localName === 'style') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(element.textContent ?? '');
      const style = document.createElementNS(NS, 'style');
      const rules: string[] = [];
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule) {
          rules.push(`${rule.selectorText} { ${cleanDeclarations(rule.style)} }`);
        } else {
          warnings.add('Reglas CSS especiales omitidas (por ejemplo @media o @font-face).');
        }
      }
      style.textContent = rules.join('\n');
      return style;
    }
    if (!tags.has(element.localName)) {
      if (!['metadata', 'namedview', 'linearGradient', 'radialGradient', 'stop'].includes(element.localName)) {
        warnings.add(`Elemento <${element.localName}> omitido. Convierte texto e imágenes a trazados para recorrerlos.`);
      }
      return null;
    }
    const result = document.createElementNS(NS, element.localName);
    for (const attr of element.attributes) {
      if (attr.localName === 'href' && element.localName === 'use') {
        if (!/^#[^\s]+$/.test(attr.value)) throw new Error('Solo se admiten referencias <use> dentro del mismo SVG.');
        result.setAttribute('href', attr.value);
      } else if (attr.name === 'style') {
        const style = document.createElement('span').style;
        style.cssText = attr.value;
        result.setAttribute('style', cleanDeclarations(style));
      } else if (attributes.has(attr.name)) {
        if (['clip-path', 'mask', 'filter'].includes(attr.name) && attr.value !== 'none') {
          throw new Error('Hay máscaras, recortes o filtros. Aplica esos efectos a los trazados antes de importar.');
        }
        if (/url\s*\(/i.test(attr.value)) {
          warnings.add('Los rellenos de referencia se omiten; el recorrido usa la geometría del contorno.');
        } else result.setAttribute(attr.name, attr.value);
      }
    }
    if (['title', 'desc'].includes(element.localName)) result.textContent = element.textContent;
    else for (const child of element.children) {
      const safeChild = clean(child);
      if (safeChild) result.append(safeChild);
    }
    return result;
  }
  const root = clean(parsed.documentElement) as SVGSVGElement;
  root.setAttribute('xmlns', NS);
  expandUses(root);
  return root;
}

function expandUses(root: SVGSVGElement): void {
  const definitions = new Map<string, Element>();
  for (const element of root.querySelectorAll('[id]')) definitions.set(element.id, element);
  let expanded = 0;
  function expand(parent: Element, chain: string[] = []) {
    for (const child of Array.from(parent.children)) {
      if (child.localName !== 'use') {
        if (!['defs', 'symbol'].includes(child.localName)) expand(child, chain);
        continue;
      }
      const id = child.getAttribute('href')?.slice(1) ?? '';
      const target = definitions.get(id);
      if (!target) throw new Error(`La referencia <use> #${id} no existe.`);
      if (chain.includes(id) || chain.length > 16) throw new Error('Hay referencias <use> circulares o demasiado profundas.');
      expanded += target.querySelectorAll('*').length + 1;
      if (expanded > 10_000) throw new Error('Las referencias <use> generan demasiadas figuras.');
      const wrapper = document.createElementNS(NS, 'g');
      for (const attr of child.attributes) {
        if (!['href', 'x', 'y', 'width', 'height'].includes(attr.name)) wrapper.setAttribute(attr.name, attr.value);
      }
      // x/y can carry SVG units; a nested viewport resolves those units in the browser.
      const viewport = document.createElementNS(NS, 'svg');
      viewport.setAttribute('x', child.getAttribute('x') ?? '0');
      viewport.setAttribute('y', child.getAttribute('y') ?? '0');
      viewport.setAttribute('overflow', 'visible');
      let clone: Element;
      if (target.localName === 'symbol') {
        clone = document.createElementNS(NS, 'svg');
        for (const attr of target.attributes) clone.setAttribute(attr.name, attr.value);
        for (const descendant of target.children) clone.append(descendant.cloneNode(true));
      } else clone = target.cloneNode(true) as Element;
      if (clone.localName === 'svg') {
        for (const dimension of ['width', 'height']) {
          if (child.hasAttribute(dimension)) clone.setAttribute(dimension, child.getAttribute(dimension)!);
        }
      }
      viewport.append(clone);
      wrapper.append(viewport);
      child.replaceWith(wrapper);
      expand(wrapper, [...chain, id]);
    }
  }
  expand(root);
}
