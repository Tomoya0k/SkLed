self.onmessage = async (event: MessageEvent<Uint8Array>) => {
  try {
    // Register the handler before MuPDF's asynchronous WASM initialization.
    const mupdf = await import('mupdf');
    const document = mupdf.Document.openDocument(event.data, 'application/pdf');
    try {
      if (document.countPages() !== 1) throw new Error('El EPS debe contener una sola página.');
      const page = document.loadPage(0);
      const buffer = new mupdf.Buffer();
      const writer = new mupdf.DocumentWriter(buffer, 'svg', 'text=path');
      try {
        const bounds = page.getBounds();
        const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
        if (!(width > 0 && height > 0)) throw new Error('El EPS no contiene medidas válidas.');
        const device = writer.beginPage(bounds);
        try { page.run(device, mupdf.Matrix.identity); } finally { device.close(); device.destroy(); }
        writer.endPage(); writer.close();
        // PDF/EPS coordinates are points (72/in), not CSS pixels (96/in).
        const svg = buffer.asString().replace(/<svg\b([^>]*)>/, (_tag, attributes: string) =>
          `<svg${attributes.replace(/\s(?:width|height)="[^"]*"/g, '')} width="${width * 25.4 / 72}mm" height="${height * 25.4 / 72}mm">`);
        if (svg.length > 2_000_000) throw new Error('El EPS genera demasiados trazos (más de 2 MB). Simplifica el diseño antes de cargarlo.');
        self.postMessage({ svg });
      } finally { writer.destroy(); buffer.destroy(); page.destroy(); }
    } finally { document.destroy(); }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'No se pudo convertir el EPS.' });
  }
};
