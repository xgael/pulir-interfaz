#!/usr/bin/env node
// Inventario medido de la UI: recorre rutas en varios tamaños, mide cada
// elemento visible y devuelve hallazgos con su recorte de pantalla.
//
// Uso:
//   node inventario.mjs --base http://localhost:5180 --rutas /admin/usuarios,/admin/oficinas \
//     --salida /tmp/ui/antes [--login /auth/login --correo a@b.c --clave X] \
//     [--tamanos 1440x900,1366x768@1.5,390x844m] [--oscuro] [--proyecto ruta/con/playwright]
//
// Tamaños: «AxB» escritorio · «AxB@1.5» zoom 150% de esa pantalla · «AxBm» celular (táctil).
// Playwright se toma del proyecto (--proyecto o el directorio actual); si no, el global.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true])
  return acc
}, []))
if (!args.base || !args.rutas || !args.salida) {
  console.error('Falta --base, --rutas o --salida. Ver la cabecera de este archivo.')
  process.exit(2)
}

async function cargarPlaywright() {
  for (const dir of [args.proyecto, process.cwd()].filter(Boolean)) {
    try {
      const req = createRequire(path.join(path.resolve(dir), 'package.json'))
      return await import(req.resolve('playwright'))
    } catch { /* siguiente */ }
  }
  try { return await import('playwright') } catch {
    console.error('No encontré Playwright. Instálalo en el proyecto (npm i -D playwright && npx playwright install chromium) o pasa --proyecto <dir>.')
    process.exit(2)
  }
}
const pw = await cargarPlaywright()
const chromium = pw.chromium ?? pw.default?.chromium // importado por ruta, llega como CommonJS en `default`

const TAMANOS = String(args.tamanos || '1440x900,1366x768@1.5,390x844m').split(',').map((t) => {
  const m = t.trim().match(/^(\d+)x(\d+)(?:@([\d.]+))?(m)?$/)
  if (!m) throw new Error(`Tamaño inválido: ${t}`)
  const [, w, h, zoom, movil] = m
  const z = Number(zoom || 1)
  // Zoom del navegador = misma pantalla con menos px CSS y más densidad.
  return { nombre: t.trim(), width: Math.round(w / z), height: Math.round(h / z), deviceScaleFactor: z, isMobile: !!movil, hasTouch: !!movil }
})
const RUTAS = String(args.rutas).split(',').map((r) => r.trim()).filter(Boolean)
const SALIDA = path.resolve(args.salida)
fs.mkdirSync(path.join(SALIDA, 'recortes'), { recursive: true })

// ───────────────────────── análisis dentro de la página ─────────────────────────
// Devuelve { stats, hallazgos, tokens }. Cada hallazgo: { tipo, sev, texto, quien, rect, id }.
const ANALIZAR = (opts) => {
  // El ancho del TAMAÑO, no innerWidth: en emulación móvil Chrome agranda la
  // ventana de diseño al ancho del contenido y un div de 600px en 390 no se veía.
  const vw = opts.ancho || innerWidth, vh = opts.alto || innerHeight
  const H = []
  let n = 0
  const marcar = (el) => { const id = `p${++n}`; el.setAttribute('data-pulir', id); return id }
  const R = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
  const quien = (el) => {
    // textContent recortado, no innerText: innerText fuerza layout del subárbol y en
    // un contenedor grande, llamado por cada hallazgo, volvía cuadrático el análisis.
    const t = (el.getAttribute('aria-label') || (el.textContent || '').slice(0, 200) || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 50)
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean)[0] || '' : ''
    const role = el.getAttribute('role')
    return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${cls ? '.' + cls.replace(/_[a-z0-9]{5}_\d+$/i, '') : ''}${t ? ` «${t}»` : ''}`
  }
  // Patrón = tipo + componente (etiqueta, rol, primera clase sin hash) + mensaje:
  // 30 chips con el mismo contraste son UN arreglo en la primitiva, no 30.
  const patronDe = (el) => quien(el).replace(/ «.*»$/, '')
  const porPatron = new Map()
  const agregar = (tipo, sev, texto, el, extra = {}) => {
    const k = `${tipo}|${patronDe(el)}|${texto}`
    const ya = porPatron.get(k)
    if (ya) { ya.veces = (ya.veces || 1) + (extra.veces || 1); if (ya.ejemplos.length < 5) ya.ejemplos.push(quien(el).match(/«(.*)»$/)?.[1] ?? ''); return }
    const h = { tipo, sev, texto, quien: quien(el), patron: patronDe(el), rect: R(el.getBoundingClientRect()), id: marcar(el), ejemplos: [], ...extra }
    porPatron.set(k, h)
    H.push(h)
  }
  // Texto sólo para lector de pantalla (clip de 1px): oculto a propósito, no se mide.
  const soloLector = (el, r) => r.width <= 2 || r.height <= 2 || getComputedStyle(el).clip !== 'auto' || /inset\(50%|inset\(100%/.test(getComputedStyle(el).clipPath)

  // ── tokens declarados en :root / html (para medir la escala del propio proyecto)
  const vars = {}
  const walk = (rules) => {
    for (const r of rules) {
      if (r.cssRules && !r.selectorText) { try { walk(r.cssRules) } catch { /* */ } }
      if (r.selectorText && /(^|,)\s*(html|:root)(\s*($|,)|[:.[])/.test(r.selectorText)) {
        for (const p of r.style) if (p.startsWith('--')) vars[p] = r.style.getPropertyValue(p).trim()
      }
    }
  }
  for (const sh of document.styleSheets) { try { walk(sh.cssRules) } catch { /* hoja de otro origen */ } }
  const probe = document.createElement('div')
  document.body.appendChild(probe)
  const px = (v) => { probe.style.cssText = 'position:absolute;visibility:hidden;width:7.77px'; probe.style.width = v; const w = getComputedStyle(probe).width; return w === '7.77px' || w === '0px' ? null : parseFloat(w) }
  const rgb = (v) => { probe.style.cssText = 'position:absolute;visibility:hidden;color:rgb(1, 2, 3)'; probe.style.color = v; const c = getComputedStyle(probe).color; return c === 'rgb(1, 2, 3)' ? null : c }
  const tok = { espacio: new Set(), letra: new Set(), radio: new Set(), color: new Set() }
  for (const k of Object.keys(vars)) {
    const v = `var(${k})`
    if (/space|spacing|gap|gutter|pad|margin|inset/i.test(k)) { const p = px(v); if (p != null) tok.espacio.add(p) }
    else if (/(^--(text|font-size|fs)\b|--text-|font-size|--fs-)/i.test(k)) { const p = px(v); if (p != null) tok.letra.add(p) }
    else if (/radius|rounded/i.test(k)) { const p = px(v); if (p != null) tok.radio.add(p) }
    const c = rgb(v); if (c) tok.color.add(c)
  }
  probe.remove()
  // Sin escala declarada: rejilla de 4px (más 0-3 para filetes y bordes).
  const escalaEspacio = tok.espacio.size ? [...tok.espacio, 0, 1, 2] : [0, 1, 2, ...Array.from({ length: 33 }, (_, i) => i * 4)]
  const enEscala = (v, esc) => esc.some((e) => Math.abs(e - v) < 0.6)
  const escalaLetra = [...tok.letra], escalaRadio = [...tok.radio]

  // ── elementos visibles
  const todos = [...document.querySelectorAll('body *')].filter((el) => {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return false
    if (/^(script|style|link|meta|noscript|template|br)$/i.test(el.tagName)) return false
    // Lo inerte u oculto al lector (submenús cerrados, cajones) no se ve: no se mide.
    if (el.closest('[inert],[aria-hidden=true]')) return false
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }).slice(0, 8000)

  // Cualquier color computado → {r,g,b 0-255, a 0-1}. color-mix/oklab salen como
  // «color(srgb 1 1 1 / 0.16)» (escala 0-1): leer números a mano daba contraste 1:1
  // en un menú blanco sobre negro. El canvas convierte todo a sRGB.
  const lienzo = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const cacheColor = new Map()
  const colorAsRGB = (c) => {
    if (cacheColor.has(c)) return cacheColor.get(c)
    lienzo.clearRect(0, 0, 1, 1)
    lienzo.fillStyle = 'rgba(0,0,0,0)'
    lienzo.fillStyle = c
    lienzo.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = lienzo.getImageData(0, 0, 1, 1).data
    const v = { r, g, b, a: a / 255 }
    cacheColor.set(c, v)
    return v
  }
  const tieneTexto = (el) => [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
  const textoPropio = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim()
  const enTodos = new Set(todos)
  const deslizables = new Set(todos.filter((c) => /(auto|scroll)/.test(getComputedStyle(c).overflowX) && c.scrollWidth > c.clientWidth + 1))
  const dentroDeDeslizable = (el) => { for (let a = el.parentElement; a; a = a.parentElement) if (deslizables.has(a)) return true; return false }
  // «Fuera de escala» se agrupa por valor (un ejemplo por valor): por elemento eran miles.
  const fueraDeEscala = new Map()
  const anotarEscala = (valor, texto, el) => { const f = fueraDeEscala.get(valor); if (f) f.n++; else fueraDeEscala.set(valor, { n: 1, texto, el }) }
  const INTERACTIVO = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=option],[tabindex]:not([tabindex="-1"])'
  const stats = { letra: {}, peso: {}, color: {}, fondo: {}, radio: {}, espacio: {}, sombra: {} }
  const cuenta = (m, k, el) => { (m[k] ??= { n: 0, ej: quien(el) }).n++ }

  // Recorte por ancestros con overflow: rect visible real del elemento.
  const recorteDe = (el) => {
    let r = el.getBoundingClientRect()
    let vis = { l: r.left, t: r.top, r: r.right, b: r.bottom }
    let por = null
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a)
      if (s.position === 'fixed') break
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const ar = a.getBoundingClientRect()
        const nv = { l: Math.max(vis.l, s.overflowX !== 'visible' ? ar.left : -1e9), r: Math.min(vis.r, s.overflowX !== 'visible' ? ar.right : 1e9), t: Math.max(vis.t, s.overflowY !== 'visible' ? ar.top : -1e9), b: Math.min(vis.b, s.overflowY !== 'visible' ? ar.bottom : 1e9) }
        if ((nv.r - nv.l) < (vis.r - vis.l) - 1 || (nv.b - nv.t) < (vis.b - vis.t) - 1) por ??= a
        vis = nv
      }
    }
    return { vis, por, r }
  }

  for (const el of todos) {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (soloLector(el, r)) continue
    // estadísticas de escala
    if (tieneTexto(el)) {
      cuenta(stats.letra, s.fontSize, el); cuenta(stats.peso, s.fontWeight, el); cuenta(stats.color, s.color, el)
    }
    if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') cuenta(stats.fondo, s.backgroundColor, el)
    if (s.borderTopLeftRadius !== '0px') cuenta(stats.radio, s.borderTopLeftRadius, el)
    if (s.boxShadow !== 'none') cuenta(stats.sombra, s.boxShadow.slice(0, 60), el)
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const v = parseFloat(s[p]); if (v && isFinite(v)) cuenta(stats.espacio, `${Math.abs(v)}px`, el)
    }

    const role = el.getAttribute('role')
    // 1. Popups recortados (lista, menú, diálogo): lo de hoy en los modales.
    if (/^(listbox|menu|dialog|tooltip|alertdialog)$/.test(role || '') || el.hasAttribute('popover')) {
      const { vis, por } = recorteDe(el)
      const cortadoPorPantalla = r.bottom > vh + 1 || r.right > vw + 1 || r.top < -1 || r.left < -1
      if ((por && (vis.b - vis.t) < r.height - 2) || cortadoPorPantalla) {
        agregar('popup-recortado', 'H', cortadoPorPantalla ? 'Se sale de la pantalla' : `Su contenedor lo recorta: se ve ${Math.max(0, Math.round(vis.b - vis.t))} de ${Math.round(r.height)}px`, el)
      }
    }
    // 2. Texto cortado sin aviso.
    if (tieneTexto(el) && (s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1) {
      if (s.textOverflow !== 'ellipsis') agregar('texto-cortado', 'M', 'Texto cortado sin puntos suspensivos', el)
      else if (!el.title && !el.getAttribute('aria-label') && !el.closest('[title]')) agregar('truncado-sin-salida', 'L', 'Truncado con «…» y sin forma de leerlo entero (title, tooltip o detalle)', el)
    }
    // 3. Columna estrangulada: texto partido en muchos renglones por falta de ancho.
    if (tieneTexto(el) && textoPropio(el).length > 12) {
      const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3
      if (r.height / lh >= 2.6 && r.width < 100 && s.display !== 'inline') agregar('estrangulado', 'M', `El texto se parte en ${Math.round(r.height / lh)} renglones en ${Math.round(r.width)}px`, el)
    }
    // 4. Se sale de su caja (celda, tarjeta, chip): T5c generalizado. Lo que
    //    vive dentro de algo que se desliza de lado ya sale en «fuera-de-vista».
    if (s.position !== 'absolute' && s.position !== 'fixed' && el.parentElement && !dentroDeDeslizable(el)) {
      let caja = el.parentElement
      for (let i = 0; caja && i < 4; i++, caja = caja.parentElement) {
        const cs = getComputedStyle(caja)
        if (caja.tagName === 'TD' || caja.tagName === 'TH' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0) break
      }
      if (caja && caja !== document.body) {
        const cr = caja.getBoundingClientRect()
        const sobra = Math.max(r.right - cr.right, cr.left - r.left)
        if (sobra > 2 && getComputedStyle(caja).overflowX === 'visible') agregar('desborde', 'M', `Se sale ${Math.round(sobra)}px de su ${caja.tagName === 'TD' ? 'celda' : 'caja'}`, el)
      }
    }
    // 5. Táctil < 44px (sólo en celular). Los enlaces dentro de un párrafo están exentos (WCAG 2.5.8).
    if (opts.movil && el.matches(INTERACTIVO) && (r.width < 44 || r.height < 44)) {
      const enParrafo = s.display === 'inline' && el.parentElement && /^(P|LI|SPAN|LABEL)$/.test(el.parentElement.tagName) && el.parentElement.textContent.trim().length > el.textContent.trim().length + 10
      if (!enParrafo && !el.disabled) agregar('tactil-chico', 'M', `Objetivo táctil de ${Math.round(r.width)}×${Math.round(r.height)}px (mínimo 44)`, el)
    }
    // 6. Contraste del texto contra su fondo real.
    if (tieneTexto(el) && !el.closest('[disabled],[aria-disabled=true]')) {
      const parse = colorAsRGB
      let fg = parse(s.color), bg = null, medible = true
      const capas = []
      for (let a = el; a; a = a.parentElement) {
        const as = getComputedStyle(a)
        if (as.backgroundImage !== 'none' && !/^linear-gradient\(rgba?\([^)]*\) 0%, rgba?\([^)]*\) 100%\)$/.test(as.backgroundImage)) { medible = false; break }
        const c = parse(as.backgroundColor)
        if (c && c.a > 0) { capas.push(c); if (c.a >= 1) break }
      }
      if (medible) {
        bg = { r: 255, g: 255, b: 255 }
        for (const c of capas.reverse()) bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) }
        if (fg && fg.a < 1) fg = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) }
        const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
        const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x)
        const ratio = (l1 + 0.05) / (l2 + 0.05)
        const grande = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700)
        const min = grande ? 3 : 4.5
        if (ratio < min) agregar('contraste', ratio < 3 ? 'H' : 'M', `Contraste ${ratio.toFixed(2)}:1 (mínimo ${min}:1)`, el)
      }
    }
    // 7. Fuera de la escala del proyecto (letra, radio, espacio).
    if (tieneTexto(el) && tok.letra.size && !enEscala(parseFloat(s.fontSize), escalaLetra)) anotarEscala(`letra ${s.fontSize}`, `Tamaño de letra ${s.fontSize} fuera de la escala`, el)
    if (tok.radio.size && s.borderTopLeftRadius !== '0px' && !/%/.test(s.borderTopLeftRadius) && parseFloat(s.borderTopLeftRadius) < 999 && !enEscala(parseFloat(s.borderTopLeftRadius), escalaRadio)) anotarEscala(`radio ${s.borderTopLeftRadius}`, `Radio ${s.borderTopLeftRadius} fuera de la escala`, el)
    for (const p of ['paddingTop', 'paddingLeft', 'rowGap', 'columnGap']) {
      const v = parseFloat(s[p])
      if (v && isFinite(v) && !enEscala(v, escalaEspacio)) { anotarEscala(`espacio ${s[p]}`, `Espacio ${s[p]} fuera de la escala`, el); break }
    }
    // 8. Animación infinita que no es de carga (ruido visual).
    for (const a of el.getAnimations?.() ?? []) {
      const t = a.effect?.getComputedTiming?.()
      if (t && t.iterations === Infinity && !el.closest('[role=progressbar],[aria-busy=true]') && !/spin|load|skeleton|carg/i.test(el.className?.toString?.() ?? '')) {
        agregar('animacion-infinita', 'M', 'Animación que nunca se detiene', el); break
      }
    }
  }

  for (const [valor, f] of [...fueraDeEscala].sort((a, b) => b[1].n - a[1].n)) {
    agregar('fuera-de-escala', 'L', `${f.texto} (${f.n} elementos)`, f.el, { valor, veces: f.n })
  }

  // 9. Columnas o controles que sólo se ven deslizando de lado (tablas anchas).
  for (const c of todos) {
    const s = getComputedStyle(c)
    if (!/(auto|scroll)/.test(s.overflowX) || c.scrollWidth <= c.clientWidth + 1) continue
    const cr = c.getBoundingClientRect()
    const fuera = [...c.querySelectorAll('th,[role=columnheader],button,a[href],input,select')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > cr.right + 1 || r.left < cr.left - 1) })
    if (fuera.length) agregar('fuera-de-vista', 'M', `Sólo se alcanza deslizando de lado: ${[...new Set(fuera.map((e) => (e.textContent.trim() || e.getAttribute('aria-label') || e.tagName).slice(0, 18)))].slice(0, 6).join(', ')}`, c)
  }
  // 10. Se sale del borde de la pantalla (y no está dentro de algo que deslice).
  for (const el of todos) {
    if (!el.matches(INTERACTIVO + ',h1,h2,h3,th,label')) continue
    const r = el.getBoundingClientRect()
    if (r.right <= vw + 1 && r.left >= -1) continue
    const { vis } = recorteDe(el)
    if (vis.r - vis.l < r.width - 1 && [...function* () { for (let a = el.parentElement; a; a = a.parentElement) yield a }()].some((a) => /(auto|scroll)/.test(getComputedStyle(a).overflowX))) continue
    agregar('fuera-de-pantalla', 'H', 'Se sale del borde de la pantalla', el)
  }
  // 11. Casi alineados: hermanos apilados cuyo borde izquierdo difiere 1-3px.
  const vistos = new Set()
  for (const el of todos) {
    const p = el.parentElement
    if (!p || vistos.has(p)) continue
    vistos.add(p)
    const hijos = [...p.children].filter((h) => enTodos.has(h))
    if (hijos.length < 2) continue
    const izq = hijos.map((h) => h.getBoundingClientRect()).filter((r, i, a) => i === 0 || r.top >= a[i - 1].bottom - 1).map((r) => r.left)
    for (let i = 1; i < izq.length; i++) {
      const d = Math.abs(izq[i] - izq[0])
      if (d > 0.5 && d <= 3) { agregar('casi-alineado', 'L', `Hermanos apilados desalineados ${d.toFixed(1)}px`, p); break }
    }
  }
  // 13. Encimado: un control tapa el texto de otro (en celular, la casilla de
  //     selección quedó sobre el nombre y ninguna otra medición lo veía).
  const conTexto = todos.filter((t) => tieneTexto(t) && !soloLector(t, t.getBoundingClientRect()))
  for (const el of todos) {
    if (!el.matches(INTERACTIVO)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || soloLector(el, r)) continue
    // Con el rect VISIBLE (recortado por sus contenedores), no el de caja.
    const rv = recorteDe(el).vis
    if (rv.r - rv.l < 4 || rv.b - rv.t < 4) continue
    for (const t of conTexto) {
      if (t === el || t.contains(el) || el.contains(t)) continue
      if (t.tagName === 'LABEL' && (t.htmlFor === el.id || t.control === el)) continue
      const tv = recorteDe(t).vis
      const tr = { left: tv.l, right: tv.r, top: tv.t, bottom: tv.b }
      const ancho = Math.min(rv.r, tr.right) - Math.max(rv.l, tr.left)
      const alto = Math.min(rv.b, tr.bottom) - Math.max(rv.t, tr.top)
      if (ancho > 3 && alto > 3 && ancho * alto > 0.15 * (rv.r - rv.l) * (rv.b - rv.t)) {
        agregar('encimado', 'H', `Tapa el texto «${textoPropio(t).slice(0, 30)}»`, el)
        break
      }
    }
  }

  // 12. La página entera se desliza de lado.
  if (document.documentElement.scrollWidth > vw + 1) H.push({ tipo: 'scroll-lateral', sev: 'H', texto: `La página mide ${document.documentElement.scrollWidth}px en una pantalla de ${vw}px`, quien: 'documento', rect: null, id: null })

  // Tope de 40 por tipo: lo que se repite es UN patrón (se arregla en la primitiva);
  // el total queda en `totales` para medir antes → después.
  const totales = {}
  const porTipo = {}
  const H2 = H.filter((h) => { totales[h.tipo] = (totales[h.tipo] || 0) + (h.veces || 1); return (porTipo[h.tipo] = (porTipo[h.tipo] || 0) + 1) <= 40 })
  return { hallazgos: H2, totales, elementos: todos.length, stats, tokens: { espacio: [...tok.espacio].sort((a, b) => a - b), letra: [...tok.letra].sort((a, b) => a - b), radio: [...tok.radio].sort((a, b) => a - b), colores: tok.color.size } }
}

// ───────────────────────── recorrido ─────────────────────────
const browser = await chromium.launch()
let storageState
if (args.login) {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  await p.goto(new URL(args.login, args.base).href, { waitUntil: 'networkidle' })
  const correo = p.locator('input[type=email], input[autocomplete=username], input[name*=mail i], input[type=text]').first()
  await correo.fill(String(args.correo))
  await p.locator('input[type=password]').first().fill(String(args.clave))
  await p.keyboard.press('Enter')
  await p.waitForURL((u) => !u.pathname.startsWith(new URL(args.login, args.base).pathname), { timeout: 15000 }).catch(() => {})
  await p.waitForTimeout(1500)
  storageState = await ctx.storageState()
  await ctx.close()
}

const resultado = { base: args.base, fecha: new Date().toISOString(), oscuro: !!args.oscuro, tamanos: TAMANOS.map((t) => t.nombre), paginas: [] }
for (const ruta of RUTAS) {
  for (const t of TAMANOS) {
    const ctx = await browser.newContext({ storageState, viewport: { width: t.width, height: t.height }, deviceScaleFactor: t.deviceScaleFactor, isMobile: t.isMobile, hasTouch: t.hasTouch, colorScheme: args.oscuro ? 'dark' : 'light', locale: 'es-MX' })
    const p = await ctx.newPage()
    const errores = []
    p.on('pageerror', (e) => errores.push(String(e).slice(0, 200)))
    await p.goto(new URL(ruta, args.base).href, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {})
    await p.waitForTimeout(1200)
    const clave = `${ruta.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'inicio'}__${t.nombre.replace(/[^a-z0-9]+/gi, '_')}`
    await p.screenshot({ path: path.join(SALIDA, `${clave}.png`) })
    const r = await p.evaluate(ANALIZAR, { movil: t.isMobile, ancho: t.width, alto: t.height })
    // Recortes: hasta 30 por página, los más graves primero.
    const orden = { H: 0, M: 1, L: 2 }
    r.hallazgos.sort((a, b) => orden[a.sev] - orden[b.sev])
    for (const h of r.hallazgos.slice(0, 30)) {
      if (!h.id) continue
      const loc = p.locator(`[data-pulir="${h.id}"]`)
      // Topes cortos: un elemento en un cajón cerrado (fuera de pantalla) hacía
      // esperar 30 s por recorte y la página en celular no terminaba.
      if (!(await loc.isVisible().catch(() => false))) continue
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      const b = await loc.boundingBox({ timeout: 1500 }).catch(() => null)
      if (!b || b.x + b.width < 0 || b.y + b.height < 0 || b.x > t.width || b.y > t.height) continue
      const m = 24
      const x = Math.max(0, b.x - m), y = Math.max(0, b.y - m)
      const clip = { x, y, width: Math.max(1, Math.min(t.width - x, b.width + 2 * m)), height: Math.max(1, Math.min(t.height - y, b.height + 2 * m)) }
      if (clip.width < 4 || clip.height < 4) continue
      h.recorte = `recortes/${clave}__${h.id}.png`
      await p.screenshot({ path: path.join(SALIDA, h.recorte), clip, timeout: 5000 }).catch(() => { delete h.recorte })
    }
    // Movimiento reducido: ¿sigue animando algo con prefers-reduced-motion?
    if (t === TAMANOS[0]) {
      await p.emulateMedia({ reducedMotion: 'reduce' })
      await p.waitForTimeout(300)
      const anim = await p.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming?.().iterations === Infinity || (a.effect?.getComputedTiming?.().duration ?? 0) > 50)).length)
      if (anim) r.hallazgos.push({ tipo: 'movimiento-reducido', sev: 'M', texto: `${anim} animaciones siguen corriendo con «reducir movimiento» activado`, quien: 'documento', rect: null, id: null })
    }
    resultado.paginas.push({ ruta, tamano: t.nombre, captura: `${clave}.png`, errores, ...r })
    const cuenta = r.hallazgos.reduce((m, h) => ((m[h.sev] = (m[h.sev] || 0) + 1), m), {})
    console.log(`${ruta} @ ${t.nombre}: H ${cuenta.H || 0} · M ${cuenta.M || 0} · L ${cuenta.L || 0}${errores.length ? ` · ${errores.length} errores de página` : ''}`)
    await ctx.close()
  }
}
await browser.close()
fs.writeFileSync(path.join(SALIDA, 'inventario.json'), JSON.stringify(resultado, null, 1))
console.log(`→ ${path.join(SALIDA, 'inventario.json')}`)
