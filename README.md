# SkLed

SkLed es una aplicación local para planear la colocación y el cableado de módulos LED sobre diseños vectoriales. Importa SVG o EPS, calcula el skeleton de las figuras rellenas, propone partidas y acomoda módulos según sus medidas físicas. Sus capas permiten revisar por separado el contorno, las guías geométricas, los módulos y las conexiones.

## Ejecutar SkLed

Se requiere Node.js 22.12 o posterior (o Node.js 24 o posterior).

```sh
npm ci
npm run dev
```

Abre [http://127.0.0.1:5173](http://127.0.0.1:5173) en el navegador. El servidor de desarrollo escucha solo en la computadora local. Para detenerlo, pulsa `Ctrl+C` en la terminal donde se ejecuta.

Para generar la versión de producción:

```sh
npm run build
npm run preview
```

## Flujo de trabajo

1. Carga un archivo con **Cargar SVG / EPS** o arrástralo al lienzo.
2. Confirma el ancho y el alto físicos. El candado mantiene la proporción entre ambos.
3. En **Módulo LED**, indica largo, ancho y longitud de los pigtails izquierdo y derecho.
4. Ajusta la distancia mínima entre skeleton y borde para determinar dónde se pueden formar partidas.
5. Activa las capas que quieras revisar. El botón **TOTAL LED** muestra el total calculado y también muestra u oculta los módulos.

Las capas calculadas usan las medidas físicas en centímetros. Sin ancho y alto físicos, SkLed puede mostrar el contorno y un skeleton aproximado en unidades SVG, pero no genera partidas ni una distribución física de LEDs.

## Capas y filtros

Las casillas de la barra superior muestran u ocultan capas. Algunas capas tienen parámetros en el panel izquierdo; otras aplican comprobaciones geométricas automáticas.

### CONTORNO

Muestra los trazos vectoriales importados. No tiene un filtro geométrico configurable. Al seleccionar una figura se resaltan sus límites y se muestran sus cotas; otro clic muestra las cotas generales.

El motor calcula superficies a partir de contornos cerrados y rellenos. Conserva los huecos reconocidos por la regla de relleno SVG. Los trazos abiertos pueden verse en esta capa, pero no definen una superficie interior para calcular partidas o comprobar el espacio físico.

### SKELETON

Muestra el eje medial de cada superficie: la línea central que aproxima la forma de la figura. Requiere ancho y alto físicos para generar geometría a escala real; sin ellos la vista es aproximada y no sirve para colocar módulos.

Filtros y ajustes automáticos:

- Detecta simetría horizontal o vertical comparando el contorno completo y emparejando también sus huecos. La tolerancia es el menor valor entre **1.5 % del lado más corto de la figura** y **25 mm**. Cuando encuentra un eje, lo usa al rasterizar la figura para reducir diferencias entre lados.
- Elimina iterativamente ramas terminales cortas: menos de **30 mm** o menos de **2.2 veces el radio local del cruce**, lo que resulte mayor. Conserva ciclos cerrados y tramos entre cruces.
- Al calcular módulos, puede recuperar ramas hacia esquinas o zonas alejadas si allí cabe físicamente un LED. Comprueba el cuerpo contra el contorno y sus huecos antes de añadirlas.

La vista de skeleton oculta además pequeños radios terminales que no forman un tramo útil. Las ramas recuperadas para cobertura se conservan aunque sean cortas.

### PARTIDAS

Genera hasta dos guías a los lados de los tramos del skeleton, aproximadamente a mitad de camino hacia el borde. El parámetro **Distancia mínima entre skeleton y borde** empieza en **10 cm**. En cada punto, SkLed mide la distancia local desde el skeleton al contorno más cercano y solo propone una partida cuando alcanza ese mínimo y queda dentro de la figura.

También elimina guías que salen de la superficie o se cruzan entre sí. Si ya se indicaron medidas del módulo, comprueba que quepa el cuerpo completo sobre la guía y dentro del contorno; las partidas donde no cabe se omiten. Una guía recta casi lo bastante larga puede extenderse un poco si la extensión sigue dentro de la figura y no crea cruces.

### MÓDULOS LED y TOTAL LED

Coloca los cuerpos LED sobre las guías combinadas del recorrido serpiente. Para calcularlos se necesitan medidas físicas del diseño y las cuatro medidas del módulo: largo, ancho y ambos pigtails. **TOTAL LED** muestra cuántos módulos pasaron los filtros actuales; pulsarlo alterna su dibujo en el lienzo.

Filtros físicos de colocación:

- El cuerpo completo debe caber longitudinal y transversalmente dentro de la figura, con un pequeño margen al borde, sin invadir huecos.
- Los módulos no se pueden superponer. Se conserva entre cuerpos la separación mínima automática: **pigtail izquierdo + pigtail derecho − 1 cm**, nunca menor que cero.
- La separación entre módulos no puede exceder la suma de ambos pigtails. Si la geometría obliga a dejar más espacio, SkLed marca un salto de fila para que no se confunda con una conexión físicamente alcanzable.
- En una rama terminal recuperada hacia una esquina, se coloca como máximo un LED y solo si el cuerpo completo cabe.

Por eso el total puede ser menor que el número de espacios sugeridos por las guías: se cuentan solo los módulos que pasan las comprobaciones geométricas y de separación.

### RECORRIDO SERPIENTE

Combina las partidas válidas con los tramos restantes del skeleton. Donde una partida cubre el skeleton, sustituye ese tramo por las dos guías paralelas; el resto del eje central se conserva. Los pares incompletos se descartan para evitar dejar una sola guía y se mantiene el skeleton en ese tramo.

Al unir los extremos, solo usa transiciones que permanezcan dentro de la misma superficie y no crucen huecos. También descarta ensanchamientos internos muy cortos que producirían un pequeño óvalo. Mantiene los ciclos reales alrededor de huecos y no conecta letras o piezas separadas.

Esta capa es una guía geométrica: no representa la longitud real del cable ni confirma por sí sola que los pigtails alcancen.

### PIGTAILS Y CONEXIONES

Traza los pigtails y las rutas posibles entre módulos. El límite físico de cada conexión es la suma de las longitudes disponibles de los pigtails de ambos extremos. La ruta debe permanecer dentro de la figura, rodear los huecos y no superar ese alcance; si no se encuentra una ruta válida, el salto queda pendiente y se muestra un aviso.

El filtro **Descartar conexiones que chocan con módulos LED** está activado por defecto. Al desactivarlo se permite que las rutas pasen sobre otros cuerpos. La capa muestra conexiones logradas y pigtails que quedan libres; no dibuja el cuerpo LED.

## Importación y geometría

SkLed procesa los archivos en el navegador local; no los sube a un servicio. Para SVG admite `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` y referencias locales `<use>`/`<symbol>`, además de sus transformaciones. Las piezas separadas se procesan por separado y nunca se conectan automáticamente.

Los EPS de texto y los que incluyen una previsualización binaria pueden convertirse en el navegador. Se conservan trazos, curvas, huecos y medidas físicas. El texto debe estar convertido a contornos; las imágenes de mapa de bits no se vectorizan. Aplica máscaras, recortes y filtros a los trazados antes de importar.

Límites actuales: **20 MB por EPS**, **2 MB de SVG resultante o SVG importado** y **10 000 elementos SVG**. Se muestran avisos cuando se omiten estilos o elementos no compatibles.

Las medidas físicas de la interfaz se expresan en centímetros. La regla de conversión de unidades SVG es `96 px = 2.54 cm`; las medidas físicas se convierten internamente a milímetros. SkLed dibuja una cuadrícula sobre fondo oscuro. `Ctrl` + rueda acerca o aleja alrededor del cursor y arrastrar desplaza el lienzo.

El conversor EPS usa Ghostscript 10.08.0 (`@wasm-zoo/ghostscript`) y MuPDF 1.28.1, ambos bajo AGPL-3.0-or-later. Sus paquetes incluyen los avisos y referencias de licencia.
