# SkLed · Contornos SVG

Herramienta local de React y TypeScript para cargar SVG o EPS y separar sus figuras
y subtrazados. Inicia sin un dibujo de ejemplo: usa **Cargar SVG / EPS** para mostrarlo.
El lienzo ofrece **CONTORNO**, **SKELETON**, **PARTIDAS**, **MÓDULOS LED**
y **RECORRIDO SERPIENTE**, además de **PIGTAILS Y CONEXIONES**.
Puedes mostrar u ocultar estas capas. **PARTIDAS** muestra recorridos candidatos
a mitad de camino entre el skeleton y el borde local. El filtro de distancia
mínima al borde determina dónde se generan. Cuando se completan las medidas del
módulo, oculta los trazos donde no cabe ningún cuerpo LED.
**RECORRIDO SERPIENTE** combina esas partidas con el skeleton: reemplaza los
tramos de skeleton que originaron partidas y conserva los tramos restantes. Esta
capa genera una guía fusionada; el cableado físico se dibuja en **PIGTAILS Y
CONEXIONES**.
La guía fusionada descarta los ramales hacia las esquinas según el grosor local
y enlaza los extremos de las partidas con su skeleton de origen mediante
transiciones suaves dentro de la figura, conservando huecos y figuras separadas.
Si dos partidas se separan y vuelven a unirse en un tramo demasiado corto para
mantener filas paralelas, Serpiente conserva el skeleton central y evita formar
pequeños óvalos. Los recorridos cerrados alrededor de huecos reales se conservan.
Ambas capas se pueden consultar sin completar las medidas del módulo.

El skeleton y la guía fusionada eliminan automáticamente ramas terminales
menores de **3 cm**. El umbral fijo limpia ramitas cortas y conserva ciclos y
tramos entre cruces.

En **Pigtails y conexiones** puedes descartar enlaces que atraviesen otros
módulos LED y ajustar la **Reserva de cable**, que empieza en **20 %** y se
puede editar de 0 a 99 %. La reserva reduce la longitud disponible de cada
pigtail, contando también los desvíos del enlace. No simula el radio mínimo de
curvatura del cable.

El plano muestra cotas de ancho y alto del SVG. Haz clic en una figura para medirla;
vuelve a hacer clic en ella para mostrar las cotas generales.
Todas las medidas de la interfaz y las cotas físicas se expresan en **cm**.
Si faltan medidas físicas, las cotas muestran unidades SVG. En **Medidas SVG**,
el candado cerrado mantiene la proporción: cambiar ancho actualiza alto y
cambiar alto actualiza ancho. Abre el candado para editar ambos por separado.
Al cerrarlo de nuevo, se conserva la proporción de las medidas actuales.

## Uso rápido

1. Pulsa **Cargar SVG / EPS** y elige tu archivo; también puedes arrastrarlo al plano.
2. Revisa **Medidas SVG** para trabajar con el tamaño físico correcto.
3. Haz clic en una figura del plano para consultar sus cotas de ancho y alto.
4. Completa las medidas del módulo y sus pigtails para activar **MÓDULOS LED**.
5. Activa **PARTIDAS** para ver las guías candidatas automáticas.
6. Activa **RECORRIDO SERPIENTE** para ver las partidas y el skeleton restante,
   calculados automáticamente para cada figura.

El serpiente muestra únicamente líneas guía, sin cuerpos LED, números ni
marcas de inicio y salida. Las piezas separadas de un mismo trazado SVG se
calculan por separado y no se conectan entre sí. Para superponer los cuerpos,
activa **MÓDULOS LED** de forma independiente.

Puedes combinar las capas, acercar con **Ctrl + rueda** y arrastrar el plano.

### Archivos EPS

La conversión se realiza dentro del navegador, en procesos de trabajo separados,
sin subir el archivo a un servicio. Los conversores se cargan al importar el primer
EPS. Se admiten EPS de texto y EPS con cabecera binaria de previsualización,
incluyendo medidas `BoundingBox` guardadas al final del archivo.

Se conservan los trazos, curvas, huecos y medidas físicas (72 puntos por pulgada).
El texto se convierte a contornos con las fuentes incluidas en el EPS o disponibles
en el conversor; para conservar una tipografía externa, expórtala como contornos.
Las imágenes de mapa de bits no se vectorizan. Los recortes y máscaras deben estar
aplicados a los trazados, igual que al importar SVG.

Límites: 20 MB por EPS y 2 MB de SVG resultante, con los mismos límites de geometría
del importador SVG. Si la conversión falla, se conserva el dibujo anterior.
El conversor usa Ghostscript 10.08.0 (`@wasm-zoo/ghostscript`) y MuPDF 1.28.1,
ambos bajo AGPL-3.0-or-later. Sus paquetes incluyen los avisos y referencias de licencia.

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
**pigtail derecho** recogen medidas en centímetros. El dibujo del módulo se
actualiza a escala con esos valores y muestra cada medida. Los pigtails son
tramos independientes: el cuerpo empieza en 0 y termina en `L`, el izquierdo
va de `−Pizq` a 0 y el derecho de `L` a `L + Pder`. El largo del módulo es solo
`L`; ningún pigtail se añade al cuerpo ni se fusiona con el otro. Con un SVG y
sus medidas físicas, la capa MÓDULOS LED calcula su cantidad y posición.

La separación mínima deseable entre módulos se puede editar en la sección
**Pigtails y conexiones**. Empieza en **3 cm**. El máximo es un
**límite estricto: la suma de ambos
pigtails**; si el mínimo deseable supera ese alcance, se limita al máximo
físico. La distribución de módulos utiliza las guías combinadas del recorrido
serpiente. Solo coloca cuerpos completos que quepan dentro de la figura, sin
cruzar huecos ni otros módulos; esta comprobación no modifica las capas de guías.

Si una curva o un estrechamiento impide colocar otro módulo dentro del rango,
la distribución se divide en filas y se señala el salto. El cálculo de
**PIGTAILS Y CONEXIONES** comprueba las rutas entre terminales dentro de la
figura, evitando huecos y otros cuerpos.
La longitud completa del enlace, incluidas las curvas y los desvíos, debe
caber en los pigtails utilizados y nunca superar la suma del izquierdo y
el derecho. No se añade cable para completar el recorrido. Si no se encuentra
una ruta física dentro del límite, la guía queda separada y se avisa de los
saltos pendientes.

La capa **PIGTAILS Y CONEXIONES** muestra los tramos de pigtail y sus enlaces,
incluidos los extremos que quedan libres cuando no hay una conexión posible.
Esta capa no dibuja el cuerpo ni el número de los módulos.

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
