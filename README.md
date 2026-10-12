# SkLed · Contornos SVG

Herramienta local de React y TypeScript para cargar un SVG y separar sus figuras
y subtrazados. Inicia sin un dibujo de ejemplo: usa **Cargar SVG** para mostrarlo.
El lienzo ofrece **CONTORNO**, **SKELETON**, **PARTIDAS**, **MÓDULOS LED**
y **RECORRIDO SERPIENTE**.
Puedes mostrar u ocultar estas capas. Los ajustes de Partidas determinan la
distribución de módulos; la capa PARTIDAS muestra solo las guías que tienen
módulos colocados. Antes de distribuirlos se filtran las partidas: cada tramo
debe admitir como mínimo el cuerpo completo de un LED, con su largo, ancho y
margen al borde, sin cruzar huecos. Se eliminan los tramos demasiado cortos o
estrechos y se recortan las colas sin espacio útil. El serpiente utiliza estas
partidas filtradas y no las ramas originales del skeleton.

El plano muestra cotas de ancho y alto del SVG. Haz clic en el contorno o el
interior de una figura para medirla; **Todo el SVG** vuelve a las cotas generales.
Todas las medidas de la interfaz y las cotas físicas se expresan en **cm**.
Si faltan medidas físicas, las cotas muestran unidades SVG. En **Medidas SVG**,
el candado cerrado mantiene la proporción: cambiar ancho actualiza alto y
cambiar alto actualiza ancho. Abre el candado para editar ambos por separado.
Al cerrarlo de nuevo, se conserva la proporción de las medidas actuales.

## Uso rápido

1. Pulsa **Cargar SVG** y elige tu archivo.
2. Revisa **Medidas SVG** para trabajar con el tamaño físico correcto.
3. Haz clic en una figura del plano para consultar sus cotas de ancho y alto.
4. Completa las medidas del módulo y sus pigtails para activar **MÓDULOS LED**.
5. Activa **PARTIDAS** para ver las guías usadas por los módulos colocados.
6. Activa **RECORRIDO SERPIENTE** para ver una guía tipo skeleton por donde
   pasarían los LED, calculada automáticamente para cada figura.

El serpiente muestra únicamente líneas guía, sin cuerpos LED, números ni
marcas de inicio y salida. Las piezas separadas de un mismo trazado SVG se
calculan por separado y no se conectan entre sí. Para superponer los cuerpos,
activa **MÓDULOS LED** de forma independiente.

Puedes combinar las capas, acercar con **Ctrl + rueda** y arrastrar el plano.

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
**pigtail derecho** recogen medidas en centímetros. Los pigtails son tramos
independientes: el cuerpo empieza en 0 y termina en `L`, el izquierdo va de
`−Pizq` a 0 y el derecho de `L` a `L + Pder`. El largo del módulo es solo `L`;
ningún pigtail se añade al cuerpo ni se fusiona con el otro. El desglose se
muestra cuando introduces las cuatro medidas. Con un SVG y sus medidas físicas,
la capa MÓDULOS LED calcula su cantidad y posición.

La separación libre mínima deseable en fila es de **3 cm**. El máximo es un
**límite estricto: la suma de ambos pigtails**; con dos de 3 cm, son 6 cm.
Si la suma es menor que 3 cm, prevalece el máximo y se avisa de que no se
alcanza la mínima deseable. La separación
entre recorridos y el margen al borde se ajustan en **Partidas**. Para decidir
entre el skeleton central y dos recorridos, se comprueba el largo y ancho del
cuerpo completo. En picos y tramos cortos se conserva la guía central cuando
las dos filas no pueden alojar cuerpos enteros.

Si una curva o un estrechamiento impide colocar otro módulo dentro del rango,
la guía se divide en filas y se señala el salto. El serpiente comprueba las
rutas entre terminales dentro de la figura, evitando huecos y otros cuerpos.
La longitud completa del enlace, incluidas las curvas y los desvíos, debe
caber en los pigtails utilizados y nunca superar la suma del izquierdo y
el derecho. No se añade cable para completar el recorrido. Si no se encuentra
una ruta física dentro del límite, la guía queda separada y se avisa de los
saltos pendientes.

El lienzo tiene fondo negro y cuadrícula verde. Se omite contenido activo y no se cargan
recursos externos. Textos e imágenes deben convertirse a trazados; máscaras,
recortes y filtros explícitos requieren aplicarse a la geometría antes de
importarla. La interfaz muestra avisos cuando omite estilos no admitidos.

En el lienzo, **Ctrl + rueda** acerca o aleja alrededor del cursor. Arrastrar
desplaza el dibujo.

**Medidas SVG:** si la raíz trae `width` y `height` físicos, los campos se
llenan con esas medidas convertidas a cm. Las unidades `px` y los números sin
unidad se convierten según CSS (`96 px = 2.54 cm`). Si falta la pareja completa,
los campos quedan vacíos; con el candado cerrado, al indicar ancho o alto se
calcula el otro con la proporción del `viewBox` (o del dibujo si no hay `viewBox`).
Cuando hay medidas físicas importadas, se usa su proporción. El motor convierte
los cm a milímetros antes de calcular la geometría; su API mantiene los parámetros
`widthMm`, `heightMm`, `lengthMm` y los demás campos terminados en `Mm`.

La relación entre `viewBox` y viewport sigue la [especificación SVG 2](https://www.w3.org/TR/SVG2/coords.html);
las conversiones entre unidades siguen [CSS Values and Units](https://www.w3.org/TR/css3-values/).
