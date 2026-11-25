/* view.js - Viewer: Diagramme (uPlot) fuer EDT-Daten, gemeinsame Zeitachse. Darstellung der Messkanaele waehlbar:
 * ein Diagramm je Einheit ('unit'), alle Messkanaele kombiniert in einem Diagramm ('all') mit EINER gemeinsamen
 * y-Achse ohne Trennung nach Einheiten (bis zu ~90 Kanaele: eine Achse je Einheit wird unlesbar) oder ein Diagramm je
 * SDI-12-Geraet ('sdi', Adresse aus iparam; ebenfalls eine y-Achse fuer alle Kanaele des Geraets). Der y-Bereich jedes
 * Diagramms steht als Zahlen in y min / y max im Diagrammkopf (aenderbar; "auto" berechnet runde Grenzen aus den
 * sichtbaren Werten, meist ab 0). Anordnung waehlbar: untereinander oder als Kacheln nebeneinander (je Bereich
 * Messwerte / Geraetewerte ein Raster, Spaltenzahl nach Breite).
 *
 *   const v = createViewer(element, { lang: 'de' })
 *   v.setData({ edt: text, iparam: text })          // iparam optional
 *
 * Bedienung: Leiste oben = Diagramme ein/aus (sofort, Zoom bleibt), Kanalliste rechts am Diagramm = Kanal ein/aus,
 * Ziehen = Zeitbereich zoomen (alle Diagramme), Doppelklick = alles, Von/Bis = Zeitraum frei,
 * Cursor rastet auf Messpunkte ein, Werte am Cursor im schwebenden Feld (verschiebt das Layout nicht). Messpunkte als kleine Punkte auf der Kurve,
 * sobald sie weit genug auseinander liegen (Zoom); einzelne Werte zwischen Luecken immer.
 */

import uPlot from '../vendor/uplot/uPlot.esm.js'
import { parseEdt, stripBom } from './edt.js'
import { parseIparam } from './iparam.js'
import { buildSeries, niceRange, sdiGroups } from './series.js'
import { texts } from './i18n.js'

const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f']
const color = i => i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)} 65% 45%)`
const DAY = 86400
const TIP_ROWS = 12 // max. Kanaele im Werte-Feld
const PT_SIZE = 4 // Messpunkt (Durchmesser, px)
const PT_SPACE = 6 // Messpunkte erst zeigen, wenn sie mind. so weit (px) auseinander liegen
const ALL_KEY = 'all' // Gruppe 'alle Messkanaele' (Darstellung 'all'); andere Keys beginnen mit 'ch:'/'hk:'/'sdi:'
const LAYOUTS = ['all', 'unit', 'sdi']
const normLayout = v => LAYOUTS.includes(v) ? v : 'unit'
const AX_SIZE = 64 // Breite der y-Achse (Zahlen), in allen Diagrammen gleich -> Zeitachsen stehen untereinander
const Y_PAD = 0.1 // automatischer y-Bereich: Rand ober-/unterhalb der Werte (Anteil, wie uPlot)

/* Linie einer Reihe fuer uPlot (series.paths). An Luecken (null) wird die Linie abgesetzt; undefined (Kanal hat zu
 * diesem Zeitpunkt keinen Eintrag) wird uebersprungen, die Linie also verbunden.
 * Warum eigen: uPlot zieht die Linie durch die Luecke und schneidet sie per Clip-Rechteck zwischen den Werten davor
 * und danach aus. Die Linie hat aber eine Breite: bei schmalen Luecken mit Sprung (herausgezoomt) bleibt am Rand ein
 * duenner senkrechter Strich stehen - eine angedeutete Linie, wo keine ist.
 * Viele Werte je Pixelspalte: nur Min/Max der Spalte zeichnen (wie uPlot). Koordinaten auf ganze Pixel gerundet
 * (uPlot verschiebt die Zeichnung selbst um die halbe Linienbreite). */
function gapPaths(u, si, i0, i1) {
    const xs = u.data[0], ys = u.data[si]
    const stroke = new Path2D()
    let pen = false // Linie laeuft (letzter Eintrag war ein Wert, keine Luecke)
    let colX = null, lo = 0, hi = 0, last = 0 // aktuelle Pixelspalte: Min, Max, letzter Wert
    const flush = () => {
        if (colX != null && lo !== hi) {
            stroke.lineTo(colX, lo)
            stroke.lineTo(colX, hi)
            stroke.lineTo(colX, last)
        }
        colX = null
    }
    for (let i = i0; i <= i1; i++) {
        const v = ys[i]
        if (v === undefined) continue
        if (v === null) {
            flush()
            pen = false
            continue
        }
        const x = Math.round(u.valToPos(xs[i], 'x', true))
        const y = Math.round(u.valToPos(v, 'y', true))
        if (pen && x === colX) {
            if (y < lo) lo = y
            if (y > hi) hi = y
            last = y
            continue
        }
        flush()
        if (pen) stroke.lineTo(x, y)
        else stroke.moveTo(x, y)
        pen = true
        colX = x
        lo = hi = last = y
    }
    flush()
    return { stroke, fill: null, clip: null, band: null, gaps: null, flags: 0 }
}

// Stylesheets einmal je Seite einbinden -> Promise, erfuellt wenn geladen (oder fehlgeschlagen)
let cssReady = null, cssLoaded = false
function injectCss() {
    if (cssReady) return cssReady
    if (typeof document === 'undefined') return (cssReady = Promise.resolve())
    const wait = []
    for (const rel of ['../vendor/uplot/uPlot.min.css', './ltx-view.css']) {
        const href = new URL(rel, import.meta.url).href
        if (document.querySelector(`link[href="${href}"]`)) continue
        const l = document.createElement('link')
        l.rel = 'stylesheet'
        l.href = href
        wait.push(new Promise(r => { l.addEventListener('load', r); l.addEventListener('error', r) }))
        document.head.appendChild(l)
    }
    if (!wait.length) cssLoaded = true // schon eingebunden (z. B. von der Seite selbst)
    cssReady = Promise.all(wait).then(() => { cssLoaded = true })
    return cssReady
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const p2 = n => String(n).padStart(2, '0')

function offText(sec) {
    const a = Math.abs(sec)
    return `UTC${sec < 0 ? '-' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor(a % 3600 / 60))}`
}

function durText(sec) {
    if (sec % 86400 === 0) return `${sec / 86400} d`
    if (sec % 3600 === 0) return `${sec / 3600} h`
    if (sec % 60 === 0) return `${sec / 60} min`
    return `${sec} s`
}

/* el: Container (wird geleert), opts:
 *   lang       'de' | 'en' (Standard: Browsersprache)
 *   theme      'auto' | 'light' | 'dark' ('auto': data-theme am <html>, sonst Systemeinstellung)
 *   time       'logger' | 'utc' | 'local' (Standard: 'logger', wenn der UTC-Versatz aus iparam bekannt ist, sonst 'local')
 *   layout     'unit' (ein Diagramm je Einheit, Standard) | 'all' (alle Messkanaele kombiniert, eine y-Achse) |
 *              'sdi' (ein Diagramm je SDI-12-Geraet, braucht iparam; sonst wie 'unit')
 *   yMin, yMax y-Bereich im kombinierten Diagramm (Standard: aus den Daten, meist ab 0); im Viewer aenderbar wie
 *              der Bereich jedes anderen Diagramms
 *   onLayout   Rueckruf (layout) nach Umschalten durch den Benutzer, z. B. zum Merken
 *   tiles      true: Diagramme als Kacheln nebeneinander (Standard false: untereinander)
 *   onTiles    Rueckruf (tiles) nach Umschalten durch den Benutzer
 *   height     Hoehe je Messwert-Diagramm in px oder 'auto' (nach Fensterhoehe, 300-560, als Kachel 220-400),
 *              hkHeight dito (200-320, als Kachel 180-280)
 *   injectCss  CSS automatisch laden (true)
 *   title      Titel, falls weder iparam noch EDT einen Namen liefern */
export function createViewer(el, opts = {}) {
    const o = { theme: 'auto', height: 'auto', hkHeight: 'auto', injectCss: true, ...opts }
    // Solange das CSS laedt, stimmen die Breiten nicht (Kanalliste, Diagrammflaeche): wurde schon gezeichnet, danach
    // neu aufbauen. Sonst ist beim ersten Oeffnen das Diagramm zu breit und rechts unter der Kanalliste abgeschnitten
    if (o.injectCss) injectCss()
    let cssWait = !!o.injectCss && !cssLoaded, drawnEarly = false, dead = false
    if (cssWait) cssReady.then(() => {
        cssWait = false
        if (drawnEarly && !dead && st.series) render()
    })
    const st = {
        edt: null, ip: null, ipError: '', series: null, plots: [], tips: new Map(),
        sdi: [], // Gruppen der Darstellung 'sdi' (leer: keine SDI-Adressen bekannt)
        syncing: false, building: false, hover: null,
        time: o.time ?? null,
        layout: normLayout(o.layout), // gewaehlt; gilt nur, wenn mit den Daten moeglich (curLayout)
        tiles: !!o.tiles, // Kacheln nebeneinander statt untereinander
        on: new Set(), // Gruppen-Keys der angezeigten Diagramme
        off: new Map(), // Gruppen-Key -> Set ausgeblendeter Kanaele
        range: null, // gewaehlter Zeitraum in UTC-Sekunden { min, max } (bleibt bei Zeitzonen-Wechsel)
        yr: new Map(), // Gruppen-Key -> y-Bereich { min, max } des Diagramms (Felder y min / y max, null = berechnen)
    }
    // y-Bereich des kombinierten Diagramms aus den Optionen (ungueltig -> berechnen)
    function yInit() {
        const f = v => typeof v === 'number' && Number.isFinite(v) ? v : null
        let min = f(o.yMin), max = f(o.yMax)
        if (min != null && max != null && min >= max) min = max = null
        return { min, max }
    }
    st.yr.set(ALL_KEY, yInit())
    const syncKey = 'lv' + Math.random().toString(36).slice(2)
    el.classList.add('lv')
    let t = texts(o.lang)
    let locale = 'en-GB'

    const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    const onScheme = () => { if (o.theme === 'auto') api.refresh() }
    mql?.addEventListener?.('change', onScheme)
    // Diagrammbreite folgt der eigenen Flaeche (.lv-plot, wird je Diagramm beobachtet), nicht nur dem Container:
    // die Flaeche aendert sich auch durch die Kanalliste daneben oder CSS, das spaeter wirkt
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        for (const p of st.plots) {
            const w = p.root.parentElement?.clientWidth
            if (w && w !== p.width) p.setSize({ width: w, height: p.height })
        }
    }) : null
    ro?.observe(el)

    function themeName() {
        if (o.theme === 'light' || o.theme === 'dark') return o.theme
        const ht = document.documentElement.dataset.theme
        if (ht === 'dark' || ht === 'light') return ht
        return mql?.matches ? 'dark' : 'light'
    }
    const cssVar = (name, fb) => getComputedStyle(el).getPropertyValue(name).trim() || fb

    // tiled: Diagramm steht als Kachel neben anderen -> niedriger, damit mehr auf einen Blick passt
    function plotHeight(hk, tiled) {
        const h = hk ? o.hkHeight : o.height
        if (typeof h === 'number') return h
        const vh = typeof innerHeight === 'number' ? innerHeight : 800
        if (tiled) return hk ? clamp(Math.round(vh * 0.26), 180, 280) : clamp(Math.round(vh * 0.36), 220, 400)
        return hk ? clamp(Math.round(vh * 0.3), 200, 320) : clamp(Math.round(vh * 0.5), 300, 560)
    }

    // Zeitmodus -> Verschiebung (s) und uPlot-Zeitzone
    function timeMode() {
        const off = st.ip?.utcOffset
        let m = st.time ?? (Number.isInteger(off) ? 'logger' : 'local')
        if (m === 'logger' && !Number.isInteger(off)) m = 'local'
        return { mode: m, shift: m === 'logger' ? off : 0, utc: m !== 'local' }
    }

    // Zeitpunkt (bereits verschoben) -> Teile [J, M, T, h, m, s] in der Anzeige-Zeitzone
    function parts(v, tm) {
        const d = new Date(Math.round(v) * 1000)
        return tm.utc
            ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
            : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
    }
    function fmtTime(v, tm) {
        const g = parts(v, tm)
        const date = locale === 'de-DE' ? `${p2(g[2])}.${p2(g[1])}.${g[0]}` : `${g[0]}-${p2(g[1])}-${p2(g[2])}`
        return `${date} ${p2(g[3])}:${p2(g[4])}${g[5] ? ':' + p2(g[5]) : ''}`
    }
    // <input type="datetime-local"> <-> Zeitpunkt (verschoben)
    function toInput(v, tm) {
        const g = parts(v, tm)
        return `${g[0]}-${p2(g[1])}-${p2(g[2])}T${p2(g[3])}:${p2(g[4])}`
    }
    function fromInput(s, tm) {
        if (!s) return null
        const ms = tm.utc ? Date.parse(s + ':00Z') : new Date(s).getTime()
        return Number.isFinite(ms) ? ms / 1000 : null
    }

    function axisStamps() {
        const de = locale === 'de-DE'
        const dm = de ? '{D}.{M}.' : '{M}/{D}'
        const dmy = de ? '{D}.{M}.{YYYY}' : '{YYYY}-{MM}-{DD}'
        const _ = null
        return [
            [365 * DAY, '{YYYY}', _, _, _, _, _, _, 1],
            [28 * DAY, '{MMM}', '\n{YYYY}', _, _, _, _, _, 1],
            [DAY, dm, '\n{YYYY}', _, _, _, _, _, 1],
            [3600, '{HH}:{mm}', '\n' + dmy, _, '\n' + dm, _, _, _, 1],
            [60, '{HH}:{mm}', '\n' + dmy, _, '\n' + dm, _, _, _, 1],
            [1, ':{ss}', '\n' + dmy + ' {HH}:{mm}', _, '\n' + dm + ' {HH}:{mm}', _, '\n{HH}:{mm}', _, 1],
        ]
    }

    function destroyPlots() {
        for (const p of st.plots) {
            if (p.root.parentElement) ro?.unobserve(p.root.parentElement)
            p.destroy()
        }
        st.plots = []
        st.tips.clear()
        st.hover = null
    }

    // withSdi: SDI-Adresse anhaengen (nicht im Diagramm eines SDI-Geraets, dort steht sie im Titel)
    function chanLabel(c, withSdi = true) {
        if (c.hk) return t.hk[c.ch] ?? `${t.channel} ${c.ch}`
        let s = `${t.channel} ${c.ch}`
        const sdi = c.meta?.sdi ?? c.meta?.srcSdi // Cache-Kanal: Adresse des Sensors, aus dessen Cache er liest
        if (sdi && withSdi) s += ` (SDI ${sdi.addr})`
        return s
    }

    // Name eines Kanals in Liste/Werte-Feld; in Diagrammen mit gemischten Einheiten (kombiniert, SDI-Geraet) mit
    // Einheit (die Achse hat keine)
    function seriesLabel(g, c) {
        return g.mixed ? `${chanLabel(c, !g.bySdi)} · ${c.unit || t.noUnit}` : chanLabel(c)
    }

    const sdiName = g => g.sdi != null ? t.sdiDevice(g.sdi) : t.noSdi
    const unitsHtml = units => `<small>${esc(units.map(u => u || t.noUnit).join(', '))}</small>`

    // Waehlbare Darstellungen der Messkanaele: Kombiniert / Nach Einheiten ab 2 Einheiten, Nach SDI-12-Geraet, wenn
    // iparam SDI-Adressen liefert. Die gewaehlte gilt nur, wenn sie dabei ist, sonst 'unit'
    function layoutsOf(s) {
        const res = s.groups.filter(g => !g.hk).length > 1 ? ['all', 'unit'] : ['unit']
        if (st.sdi.length) res.push('sdi')
        return res
    }
    const curLayout = s => layoutsOf(s).includes(st.layout) ? st.layout : 'unit'

    // Diagramme der aktuellen Darstellung: 'all' fasst die Messkanaele (ab 2 Einheiten) zu einem Diagramm zusammen,
    // 'sdi' teilt sie nach SDI-12-Geraet auf; Geraetewerte (HK) immer nach Einheit
    function viewGroups(s) {
        const hk = s.groups.filter(g => g.hk)
        const lay = curLayout(s)
        if (lay === 'sdi') return [...st.sdi, ...hk]
        if (lay !== 'all') return s.groups
        const meas = s.groups.filter(g => !g.hk)
        const channels = meas.flatMap(g => g.channels).sort((a, b) => a.ch - b.ch)
        return [{ key: ALL_KEY, hk: false, all: true, mixed: true, unit: '', units: meas.map(g => g.unit), channels }, ...hk]
    }

    // Titel (HTML): Einheit bzw. HK-Name; fruehere Einheiten der Kanaele (anderer Parametersatz) gedimmt
    function groupTitle(g) {
        if (g.all) return esc(t.allChannels) + ' ' + unitsHtml(g.units)
        if (g.bySdi) return esc(sdiName(g)) + ' ' + unitsHtml(g.units)
        const unit = g.unit || t.noUnit
        if (g.hk) return esc(`${g.channels.map(c => chanLabel(c)).join(', ')} · ${unit}`)
        const older = [...new Set(g.channels.flatMap(c => c.units))].filter(u => u !== g.unit).map(u => u || t.noUnit)
        return esc(unit) + (older.length ? ` <small>${esc(t.unitChanged)}: ${esc(older.join(', '))}</small>` : '')
    }

    // ---------- Cursor rastet ein: naechster Zeitpunkt, an dem ein sichtbarer Kanal des Diagramms einen Messwert hat ----------
    function hasValue(u, k) {
        for (let i = 1; i < u.series.length; i++) if (u.series[i].show && typeof u.data[i][k] === 'number') return true
        return false
    }
    function snapIdx(u, xv) {
        const xd = u.data[0]
        let lo = 0, hi = xd.length
        while (lo < hi) { // erster Index mit xd >= xv
            const m = (lo + hi) >> 1
            if (xd[m] < xv) lo = m + 1
            else hi = m
        }
        let l = lo - 1, r = lo
        while (l >= 0 && !hasValue(u, l)) l--
        while (r < xd.length && !hasValue(u, r)) r++
        if (l < 0) return r < xd.length ? r : null
        if (r >= xd.length) return l
        return xv - xd[l] <= xd[r] - xv ? l : r
    }

    // ---------- Werte am Cursor: schwebendes Feld im Diagramm (kein Einfluss auf das Layout) ----------
    function updateTip(u, tm, nf) {
        const tip = st.tips.get(u)
        if (!tip) return
        const { left, top } = u.cursor
        const idx = u.cursor.idxs?.[0] ?? u.cursor.idx
        if (st.hover !== u || idx == null || left == null || left < 0) {
            tip.hidden = true
            return
        }
        const rows = []
        for (let i = 1; i < u.series.length; i++) {
            if (!u.series[i].show) continue
            const v = u.data[i][idx] // nur Werte genau an diesem Zeitpunkt
            if (v !== undefined) rows.push([i, v])
        }
        tip.innerHTML = `<div class="lv-tip-t">${esc(fmtTime(u.data[0][idx], tm))}</div>`
            + rows.slice(0, TIP_ROWS).map(([i, v]) => `<div class="lv-tip-r"><i style="background:${color(i - 1)}"></i>`
                + `<span>${esc(u.series[i].label)}</span><b>${v === null ? '–' : esc(nf.format(v))}</b></div>`).join('')
            + (rows.length > TIP_ROWS ? `<div class="lv-tip-more">${esc(t.more(rows.length - TIP_ROWS))}</div>` : '')
        tip.hidden = false
        const W = u.over.clientWidth, H = u.over.clientHeight
        const w = tip.offsetWidth, h = tip.offsetHeight
        let x = left + 14
        if (x + w > W) x = left - w - 14
        let y = top + 14
        if (y + h > H) y = H - h
        tip.style.transform = `translate(${Math.max(0, Math.round(x))}px, ${Math.max(0, Math.round(y))}px)`
    }

    // y-Achse: eine links, in allen Diagrammen gleich breit (auch kombiniert: keine Achse je Einheit)
    function yAxes(fg, grid, nf) {
        return [{ stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: AX_SIZE,
            values: (u, splits) => splits.map(v => v == null ? '' : nf.format(v)) }]
    }

    // y-Bereich eines Diagramms (uPlot scales.y.range): feste Grenzen aus st.yr (Normalfall, die Felder zeigen immer
    // Zahlen); nur ohne sichtbare Werte bleibt ein Feld leer, dann automatisch
    function yRangeFn(key) {
        return (u, dmin, dmax) => {
            const { min, max } = st.yr.get(key) ?? { min: null, max: null }
            if (min != null && max != null) return [min, max]
            let [a, b] = dmin == null ? [0, 1] : uPlot.rangeNum(dmin, dmax, Y_PAD, true)
            if (min != null) { a = min; if (b <= a) b = a + (Math.abs(a) || 1) }
            if (max != null) { b = max; if (a >= b) a = b - (Math.abs(b) || 1) }
            return [a, b]
        }
    }

    function makePlot(g, xs, mount, tm, markers, theme, onRange, height) {
        const chans = g.channels
        const off = st.off.get(g.key)
        const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
        const fg = cssVar('--lv-fg', theme === 'dark' ? '#d8dadd' : '#3e3d40')
        const grid = cssVar('--lv-grid', theme === 'dark' ? '#33373b' : '#e6e7e8')
        const names = { MMMM: t.months, MMM: t.months, WWWW: ['', '', '', '', '', '', ''], WWW: ['', '', '', '', '', '', ''] }
        const series = [{ label: t.timeZone }]
        let snap = null // eingerasteter Index (Cursor-Linie auf Messpunkt)
        chans.forEach((c, i) => series.push({
            label: seriesLabel(g, c),
            stroke: color(i),
            width: 1.5,
            spanGaps: false,
            paths: gapPaths,
            show: !off.has(c.ch),
            // Messpunkte, sobald sie mind. PT_SPACE px auseinander liegen (uPlot-Regel), Einzelwerte zwischen
            // Luecken immer
            points: { size: PT_SIZE, width: 1, space: PT_SPACE, stroke: color(i), fill: color(i),
                filter: (u, si, show) => show ? null : (c.isolated.length ? c.isolated : null) },
        }))
        const opts = {
            width: mount.clientWidth || 600,
            height,
            fmtDate: tpl => uPlot.fmtDate(tpl, names),
            cursor: {
                sync: { key: syncKey },
                drag: { x: true, y: false },
                // Senkrechte Linie auf den naechsten Messpunkt setzen (nur im Diagramm unter der Maus; die anderen
                // bekommen ueber sync dieselbe Zeit)
                move: (u, left, top) => {
                    snap = null
                    if (st.hover !== u || left == null || left < 0) return [left, top]
                    snap = snapIdx(u, u.posToVal(left, 'x'))
                    return snap == null ? [left, top] : [u.valToPos(u.data[0][snap], 'x'), top]
                },
                // Index je Kanal: genau der eingerastete Zeitpunkt; ohne Wert dort kein Cursor-Punkt
                dataIdx: (u, si, ci) => {
                    const k = snap ?? ci
                    return si === 0 || typeof u.data[si][k] === 'number' ? k : null
                },
            },
            scales: { x: { time: true }, y: { range: yRangeFn(g.key) } },
            legend: { show: false }, // eigene Kanalliste rechts, Werte im schwebenden Feld
            series,
            axes: [
                { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: axisStamps(), size: 46 },
                ...yAxes(fg, grid, nf),
            ],
            hooks: {
                setScale: [(u, key) => {
                    if (key !== 'x' || st.syncing) return
                    st.syncing = true
                    const { min, max } = u.scales.x
                    for (const p of st.plots) if (p !== u) p.setScale('x', { min, max })
                    st.syncing = false
                    onRange(min, max)
                }],
                setCursor: [u => updateTip(u, tm, nf)],
                draw: [u => drawMarks(u, chans, markers, tm)],
            },
        }
        if (tm.utc) opts.tzDate = ts => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC')
        const u = new uPlot(opts, [xs, ...chans.map(c => c.data)], mount)
        const tip = document.createElement('div')
        tip.className = 'lv-tip'
        tip.hidden = true
        u.over.appendChild(tip)
        st.tips.set(u, tip)
        u.over.addEventListener('mouseenter', () => { st.hover = u })
        u.over.addEventListener('mouseleave', () => { if (st.hover === u) st.hover = null; tip.hidden = true })
        return u
    }

    // Markierungen: Reset = kurze Marke oben; Alarmgrenzen = waagerechte Linie in Kanalfarbe
    // (Linien fuer neue Parametersaetze bewusst nicht: wirkten unruhig, siehe Git-Historie)
    function drawMarks(u, chans, markers, tm) {
        const { ctx } = u
        const { left, top, width, height } = u.bbox
        const dpr = devicePixelRatio || 1
        ctx.save()
        ctx.lineWidth = dpr
        for (const m of markers) {
            const px = Math.round(u.valToPos(m.t + tm.shift, 'x', true))
            if (px < left || px > left + width) continue
            ctx.strokeStyle = m.color
            ctx.globalAlpha = 0.9
            ctx.beginPath()
            ctx.moveTo(px, top)
            ctx.lineTo(px, top + 7 * dpr)
            ctx.stroke()
        }
        ctx.globalAlpha = 1
        ctx.setLineDash([4 * dpr, 4 * dpr])
        chans.forEach((c, i) => {
            if (!u.series[i + 1].show) return
            for (const lim of [c.alarmHi, c.alarmLo]) {
                if (lim == null) continue
                const py = Math.round(u.valToPos(lim, 'y', true))
                if (py < top || py > top + height) continue
                ctx.strokeStyle = color(i)
                ctx.beginPath()
                ctx.moveTo(left, py)
                ctx.lineTo(left + width, py)
                ctx.stroke()
            }
        })
        ctx.restore()
    }

    // ---------- Kopf (beide Ansichten) ----------
    function headHtml(s, tm) {
        const ip = st.ip
        const name = ip?.name || st.edt.name || o.title || ''
        const facts = [`${fmtTime(s.stats.t0 + tm.shift, tm)} – ${fmtTime(s.stats.t1 + tm.shift, tm)}`,
            `${s.stats.rows} ${t.rows}`, `${s.channels.length} ${t.channels}`]
        if (ip?.period) facts.push(`${t.interval} ${durText(ip.period)}`)
        else if (s.stats.step) facts.push(`${t.intervalAuto} ${durText(s.stats.step)}`)
        if (s.sets.length > 1) facts.push(`${s.sets.length} ${t.sets}`)
        const notes = []
        if (s.stats.errors) notes.push(t.errors(s.stats.errors))
        if (s.stats.alarms) notes.push(t.alarms(s.stats.alarms))
        if (s.stats.invalidTime) notes.push(t.invalidTime(s.stats.invalidTime))
        if (st.ipError) notes.push('iparam: ' + st.ipError)
        let warnHtml = ''
        if (s.stats.warnings) {
            warnHtml = `<details class="lv-warn"><summary>${esc(t.warnings(s.stats.warnings))}</summary>`
                + `<ul>${st.edt.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>`
        }
        return `<div class="lv-head">
                <div class="lv-title">${esc(name)}${st.edt.mac ? ` <span class="lv-mac">${esc(st.edt.mac)}</span>` : ''}</div>
                <div class="lv-facts">${facts.map(esc).join(' · ')}</div>
                ${notes.length ? `<div class="lv-notes">${notes.map(esc).join(' · ')}</div>` : ''}${warnHtml}
            </div>`
    }

    // ---------- Diagramme ----------
    // Knopf je Diagramm in der Auswahl-Leiste (ein/aus)
    function chipHtml(g) {
        const label = g.all ? t.allChannels : g.bySdi ? sdiName(g) : g.hk ? g.channels.map(c => chanLabel(c)).join(', ') : (g.unit || t.noUnit)
        const info = g.hk ? (g.unit || t.noUnit) : t.nChannels(g.channels.length)
        const values = new Intl.NumberFormat(locale).format(g.channels.reduce((n, c) => n + c.count, 0))
        return `<button type="button" class="lv-chip" data-key="${esc(g.key)}" aria-pressed="${st.on.has(g.key)}"`
            + ` title="${esc(t.nValues(values))}"><span class="lv-chip-box" aria-hidden="true"></span>`
            + `<span class="lv-chip-name">${esc(label)}</span><small>${esc(info)}</small></button>`
    }

    // Kanalliste rechts am Diagramm: Kanal ein/aus (ohne Neuaufbau)
    function legendHtml(g) {
        const off = st.off.get(g.key)
        let html = g.channels.map((c, i) => `<li><button type="button" data-i="${i + 1}" aria-pressed="${!off.has(c.ch)}">`
            + `<i style="background:${color(i)}"></i><span>${esc(seriesLabel(g, c))}</span></button></li>`).join('')
        if (g.channels.length > 3) {
            html = `<li class="lv-leg-all"><button type="button" data-all="1">${esc(t.selAll)}</button>`
                + `<button type="button" data-all="0">${esc(t.selNone)}</button></li>` + html
        }
        return `<ul class="lv-legend" aria-label="${esc(t.channels)}">${html}</ul>`
    }

    function bindLegend(ul, u, g) {
        const off = st.off.get(g.key)
        const set = (i, show) => {
            const c = g.channels[i - 1]
            if (show) off.delete(c.ch)
            else off.add(c.ch)
            ul.querySelector(`[data-i="${i}"]`).setAttribute('aria-pressed', String(show))
            if (u.series[i].show !== show) u.setSeries(i, { show })
        }
        ul.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
            const i = Number(b.dataset.i)
            set(i, !u.series[i].show)
        }))
        ul.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => {
            const show = b.dataset.all === '1'
            u.batch(() => g.channels.forEach((c, k) => set(k + 1, show)))
        }))
    }

    // Felder y min / y max im Kopf jedes Diagramms. Sie zeigen immer die Zahlen des aktuellen Bereichs; 'auto' und
    // leere Felder werden aus den sichtbaren Werten berechnet und eingetragen (Werte setzt bindYRange)
    function yRangeHtml() {
        const inp = (k, l) => `<label>${esc(l)} <input type="text" inputmode="decimal" data-y="${k}" placeholder="${esc(t.auto)}"`
            + ` autocomplete="off" spellcheck="false"></label>`
        return `<div class="lv-yr" role="group" aria-label="${esc(t.yRange)}" title="${esc(t.yRangeTip)}">`
            + `${inp('min', t.yMin)}${inp('max', t.yMax)}<button type="button" data-y="auto" title="${esc(t.autoTip)}">${esc(t.auto)}</button></div>`
    }

    // Runder Bereich (niceRange) ueber die sichtbaren Kanaele; full: ganze Daten, sonst nur der gezeigte Zeitraum
    function autoRange(u, full) {
        const xd = u.data[0]
        let i0 = 0, i1 = xd.length - 1
        if (!full && u.scales.x.min != null) {
            const { min, max } = u.scales.x
            while (i0 <= i1 && xd[i0] < min) i0++
            while (i1 >= i0 && xd[i1] > max) i1--
        }
        let lo = Infinity, hi = -Infinity
        for (let si = 1; si < u.series.length; si++) {
            if (!u.series[si].show) continue
            const d = u.data[si]
            for (let i = i0; i <= i1; i++) {
                const v = d[i]
                if (typeof v !== 'number') continue
                if (v < lo) lo = v
                if (v > hi) hi = v
            }
        }
        return lo <= hi ? niceRange(lo, hi) : null
    }

    // Eingabe (Komma oder Punkt) -> Zahl, leer -> null, ungueltig -> NaN. Stehen beide Zeichen drin, ist das
    // hintere das Dezimalzeichen und das andere Tausendertrennung (1.000,5 und 1,000.5 -> 1000.5)
    function parseNum(v) {
        let x = v.replace(/\s/g, '')
        const c = x.lastIndexOf(','), d = x.lastIndexOf('.')
        if (c >= 0 && d >= 0) x = c > d ? x.replace(/\./g, '').replace(',', '.') : x.replace(/,/g, '')
        else x = x.replace(',', '.')
        if (x === '') return null
        return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(x) ? Number(x) : NaN
    }

    // Felder eines Diagramms (Gruppe key) binden. apply(vals, full): vals [min, max] (Zahl, null = berechnen,
    // NaN = ungueltig); full: Berechnung ueber die ganzen Daten statt ueber den gezeigten Zeitraum
    function bindYRange(box, u, key) {
        const ins = [...box.querySelectorAll('input[data-y]')]
        const nf = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 6 })
        const apply = (vals, full = false) => {
            let [a, b] = vals
            const bad = Number.isNaN(a) || Number.isNaN(b) || (a != null && b != null && a >= b)
            for (const i of ins) i.classList.toggle('lv-bad', bad)
            if (bad) return
            if (a == null || b == null) {
                const r = autoRange(u, full)
                if (r) {
                    // eine Grenze vorgegeben, die andere berechnet: muss dazu passen, sonst Abstand wie yRangeFn
                    if (a == null && b == null) [a, b] = r
                    else if (a == null) a = r[0] < b ? r[0] : b - (Math.abs(b) || 1)
                    else b = r[1] > a ? r[1] : a + (Math.abs(a) || 1)
                }
            }
            const yr = { min: a, max: b }
            st.yr.set(key, yr)
            for (const i of ins) i.value = yr[i.dataset.y] == null ? '' : nf.format(yr[i.dataset.y])
            // min/max null = neu skalieren, dabei bestimmt yRangeFn den Bereich. (Feste Zahlen hier wuerden uPlot
            // genau diesen Bereich setzen lassen, ohne yRangeFn aufzurufen.)
            u.setScale('y', { min: null, max: null })
        }
        const fromInputs = () => apply(ins.map(i => parseNum(i.value)))
        ins.forEach(i => {
            i.addEventListener('change', fromInputs)
            i.addEventListener('keydown', ev => { if (ev.key === 'Enter') fromInputs() })
        })
        // auto: Bereich aus den sichtbaren Kanaelen im gezeigten Zeitraum
        box.querySelector('button[data-y="auto"]').addEventListener('click', () => apply([null, null]))
        // Start: vorgegebene Grenzen (Optionen oder vorherige Eingabe), fehlende aus den ganzen Daten berechnen
        const cur = st.yr.get(key)
        apply([cur?.min ?? null, cur?.max ?? null], true)
    }

    function renderCharts(s, tm, theme) {
        const ip = st.ip
        const span = s.stats.t1 - s.stats.t0
        const timeOpts = []
        if (Number.isInteger(ip?.utcOffset)) timeOpts.push(['logger', t.loggerTime(offText(ip.utcOffset))])
        timeOpts.push(['utc', t.utc], ['local', t.localTime])
        const ranges = [30, 7, 1].filter(d => d * DAY < span)

        const groups = viewGroups(s)
        const layouts = layoutsOf(s), layout = curLayout(s)
        let selHtml = ''
        if (s.groups.length > 1 || layouts.length > 1) {
            const row = hk => {
                const gs = groups.filter(g => g.hk === hk)
                return gs.length ? `<div class="lv-sel-row"><span class="lv-sel-h">${esc(hk ? t.device : t.measurements)}</span>`
                    + gs.map(chipHtml).join('') + `</div>` : ''
            }
            const seg = (attr, v, pressed, l, tip = '') => `<button type="button" data-${attr}="${v}" aria-pressed="${pressed}"`
                + `${tip ? ` title="${esc(tip)}"` : ''}>${esc(l)}</button>`
            const segs = []
            // Darstellung der Messkanaele: Kombiniert / Nach Einheiten nur mit mehreren Einheiten, Nach SDI-12-Geraet
            // nur mit SDI-Adressen
            if (layouts.length > 1) {
                const name = { all: [t.layoutAll], unit: [t.layoutUnit], sdi: [t.layoutSdi, t.layoutSdiTip] }
                segs.push(`<div class="lv-seg" role="group" aria-label="${esc(t.layout)}">`
                    + layouts.map(l => seg('layout', l, layout === l, ...name[l])).join('') + `</div>`)
            }
            // Untereinander / Kacheln: nur, wenn ein Bereich (Messwerte oder Geraetewerte) mehrere Diagramme hat
            if (groups.filter(g => !g.hk).length > 1 || groups.filter(g => g.hk).length > 1) {
                segs.push(`<div class="lv-seg" role="group" aria-label="${esc(t.arrange)}">`
                    + seg('tiles', '0', !st.tiles, t.stacked, t.stackedTip) + seg('tiles', '1', st.tiles, t.tiles, t.tilesTip) + `</div>`)
            }
            const layoutRow = segs.length ? `<div class="lv-sel-row"><span class="lv-sel-h">${esc(t.layout)}</span>${segs.join('')}</div>` : ''
            selHtml = `<div class="lv-sel" role="group" aria-label="${esc(t.charts)}">${layoutRow}${row(false)}${row(true)}</div>`
        }

        el.innerHTML = headHtml(s, tm) + selHtml + `<div class="lv-bar">
                <div class="lv-ranges"><button type="button" data-days="0">${esc(t.all)}</button>${ranges.map(d =>
                    `<button type="button" data-days="${d}">${esc(t.days(d))}</button>`).join('')}</div>
                <div class="lv-span">
                    <label>${esc(t.from)} <input type="datetime-local" class="lv-from" step="60"></label>
                    <label>${esc(t.to)} <input type="datetime-local" class="lv-to" step="60"></label>
                </div>
                <label class="lv-tz">${esc(t.timeZone)} <select>${timeOpts.map(([v, l]) =>
                    `<option value="${v}"${v === tm.mode ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            </div>
            <div class="lv-panels"></div>`

        const fromEl = el.querySelector('.lv-from')
        const toEl = el.querySelector('.lv-to')
        const x0 = s.stats.t0 + tm.shift, x1 = s.stats.t1 + tm.shift
        // Zoom/Knoepfe -> Von/Bis und gemerkter Zeitraum
        const onRange = (min, max) => {
            if (st.building || min == null || max == null) return
            st.range = { min: min - tm.shift, max: max - tm.shift }
            if (document.activeElement !== fromEl) fromEl.value = toInput(min, tm)
            if (document.activeElement !== toEl) toEl.value = toInput(max, tm)
            fromEl.classList.remove('lv-bad')
            toEl.classList.remove('lv-bad')
        }
        const setX = (min, max) => {
            if (st.plots.length) st.plots[0].setScale('x', { min, max }) // Hook uebertraegt auf alle
            else onRange(min, max) // kein Diagramm gewaehlt: Zeitraum trotzdem merken
        }
        const applyInputs = () => {
            const a = fromInput(fromEl.value, tm), b = fromInput(toEl.value, tm)
            const ok = a !== null && b !== null && a < b
            fromEl.classList.toggle('lv-bad', !ok)
            toEl.classList.toggle('lv-bad', !ok)
            if (ok) setX(a, b)
        }
        fromEl.addEventListener('change', applyInputs)
        toEl.addEventListener('change', applyInputs)
        el.querySelectorAll('.lv-ranges [data-days]').forEach(b => b.addEventListener('click', () => {
            const d = Number(b.dataset.days)
            setX(d ? Math.max(x0, x1 - d * DAY) : x0, x1)
        }))
        el.querySelector('.lv-tz select').addEventListener('change', ev => { st.time = ev.target.value; render() })

        const markers = []
        const muted = cssVar('--lv-muted', '#8a8d91')
        for (const e of s.events) if (e.tag.startsWith('RESET')) markers.push({ t: e.t, color: muted })

        const xs = tm.shift ? s.x.map(v => v + tm.shift) : s.x
        const panels = el.querySelector('.lv-panels')

        // Diagramme (neu) aufbauen, z. B. nach Ein-/Ausschalten in der Leiste; Zeitraum bleibt.
        // Je Bereich (Messwerte, Geraetewerte) ein Behaelter .lv-group; als Kacheln (.lv-tiles) nur, wenn der Bereich
        // mehrere Diagramme zeigt - ein einzelnes bleibt gross mit Kanalliste daneben
        const buildPanels = () => {
            destroyPlots()
            panels.innerHTML = ''
            const shown = groups.filter(g => st.on.has(g.key))
            const tiled = hk => st.tiles && shown.filter(g => g.hk === hk).length > 1
            let lastHk = null, box = null
            st.building = true
            const built = []
            for (const g of shown) {
                if (g.hk !== lastHk) {
                    const h = document.createElement('h3')
                    h.className = 'lv-section'
                    h.textContent = g.hk ? t.device : t.measurements
                    box = document.createElement('div')
                    box.className = 'lv-group' + (tiled(g.hk) ? ' lv-tiles' : '')
                    panels.append(h, box)
                    lastHk = g.hk
                }
                const height = plotHeight(g.hk, tiled(g.hk))
                const sec = document.createElement('section')
                sec.className = 'lv-panel' + (g.hk ? ' lv-panel-hk' : '')
                sec.style.setProperty('--lv-h', height + 'px')
                sec.innerHTML = `<div class="lv-ph"><h4>${groupTitle(g)}</h4>${yRangeHtml()}</div>`
                    + `<div class="lv-body"><div class="lv-plot"></div>${legendHtml(g)}</div>`
                box.appendChild(sec)
                built.push({ g, sec, height })
            }
            // Kanallisten gleich breit, damit die Zeitachsen aller Diagramme untereinander stehen. Gemessen wird der
            // breiteste Eintrag (gleich, ob die Liste gerade rechts oder - schmal - unter dem Diagramm steht)
            panels.style.removeProperty('--lv-legw')
            let legW = 0
            for (const { sec } of built) {
                const ul = sec.querySelector('.lv-legend')
                const cap = 15 * (parseFloat(getComputedStyle(ul).fontSize) || 12)
                for (const li of ul.querySelectorAll('li:not(.lv-leg-all)')) legW = Math.max(legW, Math.min(cap, li.getBoundingClientRect().width))
            }
            if (legW) panels.style.setProperty('--lv-legw', Math.ceil(legW) + 'px')
            for (const { g, sec, height } of built) {
                const mount = sec.querySelector('.lv-plot')
                const u = makePlot(g, xs, mount, tm, markers, theme, onRange, height)
                st.plots.push(u)
                ro?.observe(mount)
                bindLegend(sec.querySelector('.lv-legend'), u, g)
                bindYRange(sec.querySelector('.lv-yr'), u, g.key)
            }
            st.building = false
            if (!st.plots.length) panels.innerHTML = `<div class="lv-empty">${esc(t.noChart)}</div>`
            const r = st.range
            if (r) setX(r.min + tm.shift, r.max + tm.shift)
            else onRange(x0, x1)
        }

        el.querySelectorAll('.lv-seg [data-layout]').forEach(b => b.addEventListener('click', () => {
            if (layout === b.dataset.layout) return
            st.layout = b.dataset.layout
            o.onLayout?.(st.layout)
            render() // Zeitraum (st.range) bleibt
        }))
        // Untereinander / Kacheln: nur die Diagramme neu aufbauen (Zeitraum, y-Bereiche, Kanalauswahl bleiben)
        const tileBtns = el.querySelectorAll('.lv-seg [data-tiles]')
        tileBtns.forEach(b => b.addEventListener('click', () => {
            const on = b.dataset.tiles === '1'
            if (st.tiles === on) return
            st.tiles = on
            tileBtns.forEach(x => x.setAttribute('aria-pressed', String((x.dataset.tiles === '1') === on)))
            o.onTiles?.(on)
            buildPanels()
        }))
        el.querySelectorAll('.lv-chip').forEach(b => b.addEventListener('click', () => {
            const key = b.dataset.key
            const on = !st.on.has(key)
            if (on) st.on.add(key)
            else st.on.delete(key)
            b.setAttribute('aria-pressed', String(on))
            buildPanels()
        }))
        buildPanels()
    }

    function render() {
        if (cssWait) drawnEarly = true
        destroyPlots()
        t = texts(o.lang)
        locale = t === texts('de') ? 'de-DE' : 'en-GB'
        const theme = themeName()
        el.dataset.lvTheme = theme
        const s = st.series
        if (!s || !s.x.length) {
            el.innerHTML = `<div class="lv-empty">${esc(t.noData)}</div>`
            return
        }
        renderCharts(s, timeMode(), theme)
    }

    const api = {
        /* Daten setzen. edt: EDT-Text (Pflicht). iparam: Text, bereits geparstes Objekt oder null.
         * Ungueltiges iparam wird ignoriert (Hinweis in der Ansicht). Liefert das Ergebnis von buildSeries(). */
        setData({ edt, iparam = null, title } = {}) {
            if (title !== undefined) o.title = title
            st.edt = typeof edt === 'string' ? parseEdt(edt) : edt
            st.ip = null
            st.ipError = ''
            if (iparam) {
                try {
                    st.ip = typeof iparam === 'string' ? parseIparam(iparam) : iparam
                } catch (err) {
                    st.ipError = err.message
                }
            }
            st.series = buildSeries(st.edt, st.ip)
            st.sdi = sdiGroups(st.series).map(g => ({ ...g, bySdi: true, mixed: true }))
            // Vorauswahl: alle Messwert-Diagramme (gibt es keine: alle Diagramme), alle Kanaele sichtbar
            const groups = st.series.groups
            const meas = groups.filter(g => !g.hk)
            st.on = new Set((meas.length ? meas : groups).map(g => g.key))
            if (meas.length) st.on.add(ALL_KEY)
            for (const g of st.sdi) st.on.add(g.key)
            st.off = new Map([...groups, ...st.sdi].map(g => [g.key, new Set()]))
            st.off.set(ALL_KEY, new Set())
            st.range = null
            st.yr = new Map([[ALL_KEY, yInit()]]) // neue Daten: y-Bereiche neu berechnen (kombiniert: wie in den Optionen)
            render()
            return st.series
        },
        /* Daten per URL laden (fetch). iparam optional; Fehler beim iparam werden nur angezeigt. */
        async loadUrls({ edt, iparam, title } = {}) {
            const get = async url => {
                const r = await fetch(url)
                if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
                return r.text()
            }
            const [e, ip] = await Promise.all([get(edt), iparam ? get(iparam).catch(err => ({ error: err })) : null])
            if (ip?.error) {
                const res = api.setData({ edt: e, title })
                st.ipError = ip.error.message
                render()
                return res
            }
            return api.setData({ edt: e, iparam: ip, title })
        },
        /* Dateien (FileList/Array) laden: Art wird am Inhalt erkannt ('@100' = iparam, sonst EDT). */
        async loadFiles(files, title) {
            let edt = null, iparam = null
            for (const f of files) {
                const text = await f.text()
                const kind = detectKind(text)
                if (kind === 'iparam') iparam = text
                else if (kind === 'edt') edt = (edt ? edt + '\n' : '') + text // z. B. data.edt.old + data.edt
            }
            if (edt === null) throw new Error('no EDT file')
            return api.setData({ edt, iparam, title })
        },
        /* Optionen aendern (lang, theme, time, layout, tiles, yMin, yMax, height, hkHeight) und neu zeichnen */
        setOptions(n = {}) {
            Object.assign(o, n)
            if (n.time !== undefined) st.time = n.time
            if (n.layout !== undefined) st.layout = normLayout(n.layout)
            if (n.tiles !== undefined) st.tiles = !!n.tiles
            if (n.yMin !== undefined || n.yMax !== undefined) st.yr.set(ALL_KEY, yInit())
            render()
        },
        refresh: () => render(),
        destroy() {
            dead = true
            destroyPlots()
            ro?.disconnect()
            mql?.removeEventListener?.('change', onScheme)
            el.innerHTML = ''
            el.classList.remove('lv')
        },
        get series() { return st.series },
        get layout() { return st.layout },
        get tiles() { return st.tiles },
        // y-Bereich des kombinierten Diagramms bzw. aller Diagramme { <Gruppen-Key>: { min, max } }
        get yRange() { return { ...(st.yr.get(ALL_KEY) ?? { min: null, max: null }) } },
        get yRanges() { return Object.fromEntries([...st.yr].map(([k, v]) => [k, { ...v }])) },
    }
    return api
}

/* Inhalt einer Datei erkennen: 'iparam' (beginnt mit '@100'), 'sysparam' ('@200') oder 'edt' */
export function detectKind(text) {
    const first = stripBom(String(text)).trimStart().split(/\r?\n/, 1)[0].trim()
    if (first === '@100') return 'iparam'
    if (first === '@200') return 'sysparam'
    return 'edt'
}
