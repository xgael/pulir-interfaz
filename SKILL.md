---
name: pulir-interfaz
description: >
  Mide la UI de una app web que ya existe y la corrige por el sistema de diseño, no
  pantalla por pantalla. Un inventario con Playwright recorre las rutas en escritorio,
  1366 con zoom 150% y celular, mide cada elemento visible y devuelve, agrupados por
  patrón y con su recorte: controles que tapan texto, listas o ventanas recortadas,
  columnas que sólo se ven deslizando, cosas que se salen de su celda o de la
  pantalla, texto partido en sílabas, contraste, objetivos táctiles, animaciones que
  no paran, y valores fuera de la escala del propio proyecto. Después del arreglo se
  vuelve a medir con la MISMA sonda y una página dice qué se resolvió y qué es nuevo
  (lo nuevo es una regresión).

  Úsala cuando pidan "pule la UI", "mejora la interfaz", "se ve cortado / encimado /
  chueco", "revisa cómo se ve en celular o con zoom", "que se vea profesional", "deja
  la UI consistente", o después de que probar-con-personas o ux-audit traigan
  hallazgos visuales ("se corta", "no se ve", "está encima", "letra chica").
  NO es para decidir la dirección visual de algo nuevo (ui-ux-pro-max,
  design-taste-frontend), ni para juzgar flujos y textos (ux-audit), ni para ver
  dónde se atora la gente (probar-con-personas).
---

# Pulir la interfaz

Las otras dos skills encuentran **dónde duele** (personas: dónde se atora alguien;
ux-audit: qué heurística se rompe). Ésta **mide la forma**: si cada cosa cabe, se ve,
no tapa a otra y sale de la escala del proyecto, en los tamaños donde la gente de
verdad la usa. Se mide con números, se arregla en la primitiva compartida y se vuelve
a medir con la misma sonda.

Origen: en una sola tarde, cinco personas sintéticas encontraron a mano columnas
fuera de vista con zoom, listas recortadas dentro de modales, pestañas cortadas en
celular y nombres partidos en sílabas. Cada uno se mide en segundos. Y al
arreglarlos aparecieron dos regresiones en celular que ninguna sonda veía: esta
skill las encontró.

## De la mano con las otras

| Viene de | Qué trae | Qué hace esta skill |
|---|---|---|
| `probar-con-personas` | «se corta», «no veo Estado», «la lista se ve de una fila» | Reproduce en su tamaño (zoom, celular) y lo vuelve número. Al resolver, `marcar.py` de personas con el commit |
| `ux-audit` | Checklist de craft (references/craft.md) juzgado a ojo | Lo mide: escala, contraste, objetivos, alineación |
| Esta skill | Patrones con recorte | Arreglo en la primitiva → re-medir → la página de antes → después |

Orden recomendado en un producto: personas (dónde duele) → ux-audit (por qué) →
**pulir-interfaz** (que la forma quede sana y no retroceda).

## El método

### 1. Inventario «antes»

```bash
node ~/.claude/skills/pulir-interfaz/bin/inventario.mjs \
  --base http://localhost:5180 --rutas /admin/usuarios,/admin/roles,/configuracion \
  --salida /tmp/ui/antes --login /auth/login --correo admin@test.com --clave '…' \
  --proyecto ./frontend          # de ahí toma Playwright
```

- **Tamaños por omisión:** `1440x900` (escritorio), `1366x768@1.5` (laptop común con
  zoom 150%: así usa la app quien agranda la letra) y `390x844m` (celular táctil).
  `--tamanos` cambia la lista; `--oscuro` emula tema oscuro (sólo si la app sigue
  `prefers-color-scheme`).
- Las rutas: las que el pedido nombra, más las que comparten sus primitivas (si se
  toca la tabla, todas las páginas con tabla).
- ~7 s por página. Una cuenta con datos reales: una tabla vacía no se desborda.
- Credenciales de prueba, nunca de producción. Va contra el entorno local.

### 2. Leer los hallazgos como patrones (y verificarlos)

```bash
python3 ~/.claude/skills/pulir-interfaz/bin/armar.py /tmp/ui/antes /tmp/ui/antes.html
```

La página agrupa por **patrón** (tipo + componente + mensaje): 30 chips con el
mismo contraste son UN arreglo. Antes de tocar nada, **mira el recorte o la
captura de cada patrón H y M**: la sonda es una heurística. Un número que dice
«todo visible» puede estar mintiendo (en la prueba, la medición de columnas decía
«caben las 7» mientras el nombre estaba partido en sílabas). La captura manda.

Los 13 chequeos y su severidad:

| Tipo | Sev | Qué mide |
|---|---|---|
| `encimado` | H | Un control tapa el texto de otro (rect VISIBLE, no el de caja) |
| `popup-recortado` | H | listbox/menu/dialog/popover recortado por su contenedor o por la pantalla |
| `fuera-de-pantalla` | H | Control, título o encabezado más allá del borde, sin nada que deslice |
| `scroll-lateral` | H | El documento entero se desliza de lado |
| `fuera-de-vista` | M | Columnas o controles que sólo se alcanzan deslizando un contenedor |
| `desborde` | M | Se sale >2px de su celda o caja (fuera de lo que desliza) |
| `estrangulado` | M | Texto de >12 caracteres partido en ≥3 renglones en <100px |
| `texto-cortado` | M | `overflow: hidden` sin `…` |
| `contraste` | H/M | Texto contra su fondo real (canvas → sRGB; 4.5:1, 3:1 si es grande) |
| `tactil-chico` | M | <44px en celular (enlaces dentro de un párrafo, exentos) |
| `animacion-infinita` / `movimiento-reducido` | M | Animación que no para / que sigue con «reducir movimiento» |
| `truncado-sin-salida` | L | Con `…` pero sin title, tooltip ni detalle para leerlo entero |
| `casi-alineado` | L | Hermanos apilados que difieren 1-3px |
| `fuera-de-escala` | L | Letra, espacio o radio fuera de los tokens declarados en `:root` (sin tokens: rejilla de 4px) |

### 3. Arreglar la primitiva, no la pantalla

Para cada patrón: ¿qué componente o regla compartida lo produce? (`grep` la clase
del recorte: `span._badge` → `Badge.module.css`). Se arregla ahí, una vez. Reglas:

- **Respeta el sistema del proyecto**: sus tokens, sus componentes, su forma de
  escribir CSS. Un valor fuera de escala se cambia por el token más cercano, no por
  otro número suelto.
- **Lo de escritorio, en su media query.** Un mínimo de ancho o un `width: 1%` que
  arregla la tabla de escritorio rompe la vista de tarjeta del celular (pasó dos
  veces en la misma tarde). Cada regla de ancho se pregunta: ¿aplica abajo de 640?
- **Primero que quepa, luego que se lea, al final que sea bonito.** Encimado y
  recortado antes que escala.
- **Decisiones de marca, al usuario**: si arreglar el contraste exige cambiar el
  color primario de la marca, se reporta con el número y la propuesta (token y
  valor), no se cambia en silencio.

### 4. Re-medir con la MISMA sonda y entregar el antes → después

```bash
node …/inventario.mjs … --salida /tmp/ui/despues
python3 …/armar.py /tmp/ui/despues /ruta/entregable.html --antes /tmp/ui/antes
```

- **La misma versión de la sonda en las dos corridas.** Si la sonda cambió en medio
  (se le agregó un chequeo, se corrigió un falso positivo), el «antes» se vuelve a
  correr sobre el código anterior: `git checkout <commit> -- <archivos CSS>`, medir,
  `git checkout HEAD -- <archivos>`. Comparar sondas distintas no mide el arreglo.
- **Un patrón nuevo después es una regresión** hasta que se demuestre lo contrario:
  se mira su recorte antes de entregar.
- El delta compara por tipo + componente, sin el valor: la casilla que pasa de 13 a
  16px no es «nueva».
- Corre también las pruebas y sondas propias del proyecto: esta skill no las
  reemplaza (el CSS que la arregla puede romper otra cosa que ellas sí ven).

### 5. Entregar

Tabla por patrón: **antes → después → cómo se midió → commit**. Lo que quedó sin
arreglar se dice con su razón (decisión de marca, fuera del pedido). Si los
hallazgos venían de probar-con-personas, se marcan ahí con `marcar.py … --commit`.

## Trampas medidas

| Síntoma | Causa | Arreglo |
|---|---|---|
| La lista de un `<select>` propio muestra una fila dentro del modal | `position: absolute` dentro del cuerpo con scroll del modal | `popover="manual"` (capa superior, sigue dentro del diálogo en el DOM, así que el focus-trap no lo pelea) + coordenadas `fixed` del disparador, abriendo hacia arriba si abajo no cabe. En jsdom no hay `showPopover`: poner el atributo sólo si existe |
| Columnas importantes fuera de vista con zoom | tabla con `min-width: max-content` y celdas `nowrap` | celdas con salto de línea; columna de acciones `position: sticky; right: 0` sólo en escritorio; la columna prescindible (fecha de alta) se oculta entre 640 y 1023 |
| La columna fija ⋮ tapa a la de al lado | la tabla sigue midiendo más que su caja (una clave o código largo sin salto) | `overflow-wrap: anywhere` en el chip de código; medir `table.scrollWidth - contenedor.clientWidth` = 0 |
| Nombre partido en sílabas | todas las columnas encogen igual | `min-width` al nombre (sólo escritorio) |
| Columnas de casilla/flecha comen 200px | el `min-width` de las celdas de datos también les aplica | clase para columnas de control con `width: 1%` (sólo escritorio) |
| Flecha o casilla fuera de la tarjeta en celular | una regla de ancho de escritorio sin media query | toda regla de ancho de tabla dentro de `@media (min-width: 640px)` |
| 5 botones en «píldora» saltan a 2 filas (óvalo deforme) | segmented control sin espacio en 390px | rejilla de 3 columnas con radio de tarjeta en angosto |
| Pestañas cortadas en el borde en celular | `inline-flex` sin envoltura | sin iconos y más juntas abajo de 640; `overflow-x: auto` como red |
| Submenú que se abre debajo del borde | el grupo crece y nadie lo trae a la vista | `scrollIntoView({block:'nearest'})` al terminar la transición (y en el clic si hay movimiento reducido) |
| Contraste 1:1 en un menú blanco sobre negro (falso) | `color-mix` devuelve `color(srgb 1 1 1 / .16)`, escala 0-1 | convertir colores pintándolos en un canvas de 1×1 (lo hace la sonda) |

## Lo que la sonda NO ve (míralo tú)

- Jerarquía y ritmo (si lo importante se ve primero), densidad, que algo «se vea
  barato». Eso es craft de ux-audit: la sonda sólo dice si cabe y si sale de escala.
- Estados que no están en pantalla al cargar: vacío, error, cargando, hover, foco,
  menú abierto. Para medirlos, abre el estado con Playwright y llama la sonda en esa
  página (o agrega la ruta con el parámetro que lo abre).
- Tema oscuro si la app lo cambia con una clase y no con `prefers-color-scheme`.
- Fondos con imagen o degradado: el contraste se marca como no medible y se salta.
