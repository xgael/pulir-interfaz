# pulir-interfaz

Skill de Claude Code que **mide** la UI de una app web ya construida y la corrige
por el sistema de diseño (la primitiva compartida), no pantalla por pantalla.

Un inventario con Playwright recorre las rutas en escritorio, en una laptop de
1366 con zoom 150% y en celular, mide cada elemento visible y devuelve los
problemas **agrupados por patrón**, cada uno con su recorte: controles que tapan
texto, listas recortadas dentro de modales, columnas que sólo se ven deslizando,
cosas que se salen de su celda, texto partido en sílabas, contraste, objetivos
táctiles, animaciones que no paran y valores fuera de la escala del proyecto.

Después del arreglo se vuelve a medir con la misma sonda y una página dice qué se
resolvió y qué es nuevo: lo nuevo es una regresión.

Va de la mano con [probar-con-personas](https://github.com/xgael/probar-con-personas)
(dónde se atora la gente) y con una auditoría heurística de UX (por qué): ésta se
encarga de que la forma quede sana y no retroceda.

## Qué trae

| Archivo | Para qué |
|---|---|
| `SKILL.md` | El método: medir, leer por patrón, arreglar la primitiva, re-medir, entregar; y las trampas medidas |
| `bin/inventario.mjs` | La sonda: 13 chequeos × rutas × tamaños, con recortes, en `inventario.json` |
| `bin/armar.py` | Una sola página HTML por patrón; con `--antes`, el delta antes → después |

## Instalación

```bash
git clone https://github.com/xgael/pulir-interfaz ~/.claude/skills/pulir-interfaz
```

Necesita Node 18+ con Playwright en el proyecto que se mide (`npm i -D playwright &&
npx playwright install chromium`) y Python 3 (sólo biblioteca estándar).

## Uso rápido

```bash
node ~/.claude/skills/pulir-interfaz/bin/inventario.mjs --base http://localhost:3000 \
  --rutas /,/ajustes --salida /tmp/ui/antes --proyecto .
python3 ~/.claude/skills/pulir-interfaz/bin/armar.py /tmp/ui/antes /tmp/ui/antes.html
```

## Licencia

MIT
