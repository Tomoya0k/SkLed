# SkLed · Contornos SVG

Herramienta local de React y TypeScript para cargar un SVG y separar sus figuras
y subtrazados. El lienzo ofrece **CONTORNO**, **SKELETON**, **RECORRIDOS LED**
y **MÓDULOS LED**;
el SVG original está en Opciones avanzadas. Puedes mostrar u ocultar estas
capas. Los ajustes de Partidas determinan la distribución de módulos; la capa
RECORRIDOS LED muestra solo las guías que tienen módulos colocados.

## Ejecutar

Requiere Node.js 22.12+ o 24+.

```sh
npm install
npm run dev
```

Abre http://127.0.0.1:5173. El servidor solo escucha en `127.0.0.1`.

```sh
npm run build
npx playwright install chromium
npm test
```

El motor está en `src/engine/` y no depende de React. Usa `parseSvg(svgText)`
para obtener figuras, sus contornos y el trazado vectorial de cada uno. Respeta
el orden y las transformaciones del SVG. Los trazos desconectados no se unen.
Admite `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` y
referencias locales `<use>` y `<symbol>`. Longitudes y puntos extremos son
mediciones numéricas del navegador en unidades del SVG.

Los campos **largo del módulo**, **ancho del módulo**, **pigtail izquierdo** y
**pigtail derecho** recogen medidas en milímetros. Los pigtails son tramos
independientes: el cuerpo empieza en 0 y termina en `L`, el izquierdo va de
`−Pizq` a 0 y el derecho de `L` a `L + Pder`. El largo del módulo es solo `L`;
ningún pigtail se añade al cuerpo ni se fusiona con el otro. El desglose se
muestra cuando introduces las cuatro medidas. Todavía no se calcula la cantidad
ni la posición de LEDs.

La capa SVG usa un tono azul para distinguirla del contorno verde. El lienzo
tiene fondo negro y cuadrícula verde. Se omite contenido activo y no se cargan
recursos externos. Textos e imágenes deben convertirse a trazados; máscaras,
recortes y filtros explícitos requieren aplicarse a la geometría antes de
importarla. La interfaz muestra avisos cuando omite estilos no admitidos.

En el lienzo, **Ctrl + rueda** acerca o aleja alrededor del cursor. Arrastrar
desplaza el dibujo.

**Medidas SVG:** si la raíz trae `width` y `height` físicos, los campos se
llenan con esas medidas convertidas a mm. Las unidades `px` y los números sin
unidad se convierten según CSS (`96 px = 25.4 mm`). Si falta la pareja completa,
los campos quedan vacíos; al indicar el ancho, el alto se calcula con la
proporción del `viewBox` (o del dibujo si no hay `viewBox`). Una medida escrita
manualmente puede editarse. Esto no cambia todavía la geometría ni calcula LEDs.

La relación entre `viewBox` y viewport sigue la [especificación SVG 2](https://www.w3.org/TR/SVG2/coords.html);
las conversiones entre unidades siguen [CSS Values and Units](https://www.w3.org/TR/css3-values/).
