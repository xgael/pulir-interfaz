#!/usr/bin/env python3
"""Arma la página del inventario de UI: hallazgos agrupados por patrón, con recorte.

Uso:
  python3 armar.py <dir-despues> <salida.html> [--antes <dir-antes>]

Con --antes agrega el delta: totales por tipo antes → después, patrones
resueltos y patrones NUEVOS (un patrón nuevo después de un arreglo es una
regresión). Sólo biblioteca estándar; la página es un solo archivo.
"""
import base64
import html
import json
import os
import sys

if len(sys.argv) < 3:
    sys.exit(__doc__)
DESPUES, DST = sys.argv[1], sys.argv[2]
ANTES = sys.argv[sys.argv.index('--antes') + 1] if '--antes' in sys.argv else None

NOMBRES = {
    'encimado': 'Un control tapa texto',
    'popup-recortado': 'Lista o ventana recortada',
    'fuera-de-pantalla': 'Se sale del borde de la pantalla',
    'scroll-lateral': 'La página entera se desliza de lado',
    'fuera-de-vista': 'Sólo se alcanza deslizando de lado',
    'desborde': 'Se sale de su caja o celda',
    'estrangulado': 'Texto partido en muchos renglones',
    'texto-cortado': 'Texto cortado sin aviso',
    'truncado-sin-salida': 'Truncado sin forma de leerlo entero',
    'contraste': 'Contraste insuficiente',
    'tactil-chico': 'Objetivo táctil menor a 44px',
    'animacion-infinita': 'Animación que no se detiene',
    'movimiento-reducido': 'No respeta «reducir movimiento»',
    'casi-alineado': 'Casi alineado (1-3px)',
    'fuera-de-escala': 'Fuera de la escala del proyecto',
}
SEV = {'H': 0, 'M': 1, 'L': 2}
e = html.escape


def cargar(d):
    with open(os.path.join(d, 'inventario.json'), encoding='utf-8') as f:
        return json.load(f)


def patrones(inv):
    """(tipo, patrón, texto) → {sev, texto, quien, paginas, veces, recorte, ejemplos}."""
    out = {}
    for p in inv['paginas']:
        for h in p['hallazgos']:
            k = (h['tipo'], h.get('patron') or h['quien'], h['texto'] if h['tipo'] != 'fuera-de-escala' else h.get('valor', h['texto']))
            g = out.setdefault(k, {**h, 'paginas': [], 'veces': 0, 'ejemplos': set()})
            g['paginas'].append(f"{p['ruta']} @ {p['tamano']}")
            g['veces'] += h.get('veces', 1)
            g['ejemplos'].update(x for x in h.get('ejemplos', []) if x)
            if not g.get('recorte') and h.get('recorte'):
                g['recorte'] = h['recorte']
    return out


def totales(inv):
    t = {}
    for p in inv['paginas']:
        for k, v in p.get('totales', {}).items():
            t[k] = t.get(k, 0) + v
        for h in p['hallazgos']:  # los que no pasan por `totales` (documento)
            if h['tipo'] in ('scroll-lateral', 'movimiento-reducido'):
                t[h['tipo']] = t.get(h['tipo'], 0) + 1
    return t


def img(d, rel):
    if not rel:
        return ''
    ruta = os.path.join(d, rel)
    if not os.path.exists(ruta):
        return ''
    with open(ruta, 'rb') as f:
        return f'<img loading="lazy" alt="" src="data:image/png;base64,{base64.b64encode(f.read()).decode()}">'


desp = cargar(DESPUES)
pd = patrones(desp)
td = totales(desp)
pa, ta = ({}, {})
if ANTES:
    ant = cargar(ANTES)
    pa, ta = patrones(ant), totales(ant)

partes = []
# ── resumen
tipos = sorted(set(td) | set(ta), key=lambda t: (list(NOMBRES).index(t) if t in NOMBRES else 99))
filas = []
for t in tipos:
    a, d = ta.get(t, 0), td.get(t, 0)
    flecha = '' if not ANTES else (' class="bien"' if d < a else ' class="mal"' if d > a else '')
    filas.append(f'<tr><td>{e(NOMBRES.get(t, t))}</td>' + (f'<td class="num">{a}</td>' if ANTES else '') + f'<td class="num"{flecha}>{d}</td></tr>')
partes.append('<h2>Resumen</h2><table class="resumen"><thead><tr><th>Qué</th>' + ('<th>Antes</th>' if ANTES else '') + '<th>' + ('Después' if ANTES else 'Total') + '</th></tr></thead><tbody>' + ''.join(filas) + '</tbody></table>')

# ── delta de patrones
if ANTES:
    # Por (tipo, componente), sin el valor medido: la misma casilla que pasa de
    # 13×16 a 16×16 no es un patrón nuevo ni uno resuelto.
    clave = lambda k: (k[0], k[1])
    cd, ca = {clave(k) for k in pd}, {clave(k) for k in pa}
    nuevos = [k for k in pd if clave(k) not in ca and k[0] != 'fuera-de-escala']
    resueltos = [k for k in pa if clave(k) not in cd and k[0] != 'fuera-de-escala']
    partes.append(f'<h2>Antes → después</h2><p class="sub"><strong>{len(resueltos)}</strong> patrones resueltos · '
                  f'<strong class="{ "mal" if nuevos else "" }">{len(nuevos)}</strong> patrones nuevos'
                  f'{" (revisar: un patrón nuevo tras un arreglo es una regresión)" if nuevos else ""}.</p>')
    if nuevos:
        partes.append('<h3>Nuevos</h3><ul class="lista">' + ''.join(f'<li><span class="sev {pd[k]["sev"]}">{pd[k]["sev"]}</span> {e(NOMBRES.get(k[0], k[0]))}: {e(pd[k]["texto"])} — <code>{e(k[1])}</code></li>' for k in nuevos) + '</ul>')
    if resueltos:
        partes.append('<h3>Resueltos</h3><ul class="lista">' + ''.join(f'<li>✓ {e(NOMBRES.get(k[0], k[0]))}: {e(pa[k]["texto"])} — <code>{e(k[1])}</code></li>' for k in resueltos) + '</ul>')

# ── hallazgos por patrón (sin escala)
cards = []
for k, g in sorted(pd.items(), key=lambda kv: (SEV[kv[1]['sev']], -len(kv[1]['paginas']))):
    if k[0] == 'fuera-de-escala':
        continue
    ej = ', '.join(sorted(g['ejemplos']))[:160]
    pags = sorted(set(g['paginas']))
    cards.append(
        f'<article class="card"><div class="cab"><span class="sev {g["sev"]}">{g["sev"]}</span>'
        f'<strong>{e(NOMBRES.get(k[0], k[0]))}</strong><span class="veces">{g["veces"]}× · {len(pags)} pág.</span></div>'
        f'<p>{e(g["texto"])}</p><p class="quien"><code>{e(g["quien"])}</code>{f" · también: {e(ej)}" if ej else ""}</p>'
        f'{img(DESPUES, g.get("recorte"))}<details><summary>Dónde</summary><p class="sub">{e(" · ".join(pags))}</p></details></article>')
partes.append(f'<h2>Hallazgos por patrón ({len(cards)})</h2><p class="sub">Uno por patrón: el mismo componente con el mismo problema se arregla una vez, en la primitiva.</p>' + ''.join(cards))

# ── escala
esc = sorted(((k, g) for k, g in pd.items() if k[0] == 'fuera-de-escala'), key=lambda kv: -kv[1]['veces'])
tok = desp['paginas'][0].get('tokens', {}) if desp['paginas'] else {}
partes.append('<h2>Escala</h2><p class="sub">Escala declarada en el proyecto · espacios: ' + e(', '.join(f'{v:g}' for v in tok.get('espacio', [])) or 'rejilla de 4px (no declarada)')
              + ' · letra: ' + e(', '.join(f'{v:g}' for v in tok.get('letra', [])) or 'no declarada')
              + ' · radios: ' + e(', '.join(f'{v:g}' for v in tok.get('radio', [])) or 'no declarados') + '</p>'
              + '<table class="resumen"><thead><tr><th>Valor fuera de escala</th><th>Elementos</th><th>Ejemplo</th></tr></thead><tbody>'
              + ''.join(f'<tr><td>{e(k[2])}</td><td class="num">{g["veces"]}</td><td><code>{e(g["quien"][:70])}</code></td></tr>' for k, g in esc[:40]) + '</tbody></table>')
letras = {}
for p in desp['paginas']:
    for v, s in p['stats'].get('letra', {}).items():
        letras[v] = letras.get(v, 0) + s['n']
partes.append(f'<p class="sub">{len(letras)} tamaños de letra distintos en uso: ' + e(', '.join(f'{v} ({n})' for v, n in sorted(letras.items(), key=lambda x: float(x[0][:-2])))) + '</p>')

CSS = """
:root{color-scheme:light dark;--fg:#1d1d1f;--mut:#6e6e73;--bg:#fbfbfa;--card:#fff;--bd:#e3e3e0;--h:#b42318;--m:#9a6700;--l:#57606a;--ok:#1a7f37}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--mut:#a1a1a6;--bg:#000;--card:#111;--bd:#2c2c2e;--h:#ff8a80;--m:#e3b341;--l:#a1a1a6;--ok:#56d364}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:32px 20px 80px}h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:40px 0 8px}h3{font-size:16px;margin:20px 0 6px}
.sub{color:var(--mut);margin:4px 0 12px}table.resumen{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--bd);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--bd)}td.num{text-align:right;font-variant-numeric:tabular-nums}.bien{color:var(--ok);font-weight:600}.mal{color:var(--h);font-weight:600}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;margin:10px 0}.cab{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.veces{margin-left:auto;color:var(--mut);font-size:13px}.card p{margin:6px 0}.quien{color:var(--mut);font-size:13px;overflow-wrap:anywhere}
.card img{display:block;max-width:100%;max-height:220px;margin-top:8px;border:1px solid var(--bd);border-radius:8px}
.sev{font-size:12px;font-weight:700;padding:1px 7px;border-radius:6px;border:1px solid currentColor}.sev.H{color:var(--h)}.sev.M{color:var(--m)}.sev.L{color:var(--l)}
.lista{padding-left:18px}code{font-size:12.5px}details summary{cursor:pointer;color:var(--mut);font-size:13px;margin-top:6px}
"""
pags = len(desp['paginas'])
rutas = sorted({p['ruta'] for p in desp['paginas']})
doc = (f'<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
       f'<title>Inventario de UI</title><style>{CSS}</style><main><h1>Inventario de UI</h1>'
       f'<p class="sub">{e(desp["base"])} · {len(rutas)} rutas × {len(desp["tamanos"])} tamaños ({e(", ".join(desp["tamanos"]))}) = {pags} páginas · {e(desp["fecha"][:16].replace("T", " "))} UTC'
       f'{" · tema oscuro" if desp.get("oscuro") else ""}</p>' + ''.join(partes) + '</main></html>')
os.makedirs(os.path.dirname(os.path.abspath(DST)), exist_ok=True)
with open(DST, 'w', encoding='utf-8') as f:
    f.write(doc)
print(f'{DST} · {pags} páginas · {len(cards)} patrones · {os.path.getsize(DST) / 1e6:.1f} MB')
