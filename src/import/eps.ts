/** Resolve DSC trailer dimensions before EPSCrop, which needs them in the header.
 * Keep the original bytes (including binary PostScript data) outside these comments. */
function resolveTrailerBounds(bytes: Uint8Array): Uint8Array {
  const source = new TextDecoder('latin1').decode(bytes);
  const entries: Array<{ key: string; value: string; start: number; end: number }> = [];
  let depth = 0;
  for (const match of source.matchAll(/^%%(BeginDocument|EndDocument|BoundingBox|HiResBoundingBox):?([^\r\n]*)/gm)) {
    if (match[1] === 'BeginDocument') { depth++; continue; }
    if (match[1] === 'EndDocument') { depth = Math.max(0, depth - 1); continue; }
    if (!depth) entries.push({ key: match[1], value: match[2].trim(), start: match.index!, end: match.index! + match[0].length });
  }
  const bounds = (key: string) => entries.filter(entry => entry.key === key).map(entry => entry.value.split(/\s+/).map(Number))
    .find(values => values.length === 4 && values.every(Number.isFinite) && values[2] > values[0] && values[3] > values[1]);
  if (!bounds('BoundingBox') && !bounds('HiResBoundingBox')) throw new Error('El EPS no contiene un BoundingBox válido. Vuelve a exportarlo con sus medidas.');
  let result = bytes;
  for (const entry of [...entries].reverse()) {
    const values = bounds(entry.key);
    if (entry.value !== '(atend)' || !values) continue;
    const replacement = new TextEncoder().encode(`%%${entry.key}: ${values.join(' ')}`);
    const updated = new Uint8Array(result.length - (entry.end - entry.start) + replacement.length);
    updated.set(result.subarray(0, entry.start)); updated.set(replacement, entry.start);
    updated.set(result.subarray(entry.end), entry.start + replacement.length);
    result = updated;
  }
  return result;
}

/** Run PostScript in Ghostscript's isolated worker, then retain its vector output. */
export async function epsToSvg(bytes: Uint8Array): Promise<string> {
  // EPS may start with the binary DOS preview header instead of %!PS.
  const binary = bytes.length >= 30 && bytes[0] === 0xc5 && bytes[1] === 0xd0 && bytes[2] === 0xd3 && bytes[3] === 0xc6;
  let postscript = bytes;
  if (binary) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = header.getUint32(4, true), length = header.getUint32(8, true);
    if (offset < 30 || !length || offset + length > bytes.length) throw new Error('El encabezado del EPS está dañado.');
    postscript = bytes.subarray(offset, offset + length);
  }
  const signature = new TextDecoder('latin1').decode(postscript.subarray(0, 256));
  if (!/^%!PS-Adobe-[^\r\n]*EPSF-/i.test(signature)) throw new Error('El archivo no es un EPS válido.');
  postscript = resolveTrailerBounds(postscript);
  const { load } = await import('@wasm-zoo/ghostscript');
  const gs = await load();
  let pdf: Uint8Array;
  try {
    const result = await gs.exec([
      '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-dAutoRotatePages=/None',
      '-sDEVICE=pdfwrite', '-dNoOutputFonts', '-sOutputFile=/drawing.pdf', '/drawing.eps',
    ], { files: [{ name: '/drawing.eps', data: postscript }], outputs: ['/drawing.pdf'], timeoutMs: 60_000 });
    const output = result.files.find(file => file.name === '/drawing.pdf');
    if (result.exitCode || !output?.data.length) throw new Error('No se generó geometría.');
    pdf = output.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('El EPS tardó demasiado en convertirse. Simplifica el diseño e inténtalo otra vez.');
    throw new Error('No se pudo interpretar el EPS. Revisa el archivo o vuelve a exportarlo como EPS.');
  } finally { gs.dispose(); }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./eps-vector.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    const timer = setTimeout(() => { finish(); reject(new Error('El EPS contiene demasiada geometría para convertirlo.')); }, 30_000);
    worker.onmessage = (event: MessageEvent<{ svg?: string; error?: string }>) => {
      finish();
      if (event.data.svg) {
        const document = new DOMParser().parseFromString(event.data.svg, 'image/svg+xml');
        // PDF fill operators close every subpath implicitly. Make that closure
        // explicit so the geometry engine recognizes complete figure interiors.
        for (const path of document.querySelectorAll('path')) if (path.getAttribute('fill') !== 'none') {
          path.setAttribute('d', (path.getAttribute('d') ?? '').replace(/[Mm][^Mm]*/g, part => /[zZ]\s*$/.test(part) ? part : `${part}Z`));
        }
        resolve(new XMLSerializer().serializeToString(document));
      }
      else reject(new Error(event.data.error || 'No se pudieron obtener los trazos del EPS.'));
    };
    worker.onerror = () => { finish(); reject(new Error('No se pudo cargar el conversor vectorial de EPS.')); };
    worker.postMessage(pdf);
  });
}
