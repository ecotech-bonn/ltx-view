/* view.js - Viewer: Diagramme (uPlot) fuer EDT-Daten, ein Diagramm je Einheit, gemeinsame Zeitachse.
 *
 *   const v = createViewer(element, { lang: 'de' })
 *   v.setData({ edt: text, iparam: text })          // iparam optional
 *
 * Bedienung: Leiste oben = Diagramme ein/aus (sofort, Zoom bleibt), Kanalliste rechts am Diagramm = Kanal ein/aus,
 * Ziehen = Zeitbereich zoomen (alle Diagramme), Doppelklick = alles, Von/Bis = Zeitraum frei,
 * Werte am Cursor im schwebenden Feld (verschiebt das Layout nicht). Messpunkte als kleine Punkte auf der Kurve,
 * sobald sie weit genug auseinander liegen (Zoom); einzelne Werte zwischen Luecken immer.
 */

import uPlot from '../vendor/uplot/uPlot.esm.js'
import { parseEdt, stripBom } from './edt.js'
import { parseIparam } from './iparam.js'
import { buildSeries } from './series.js'
import { texts } from './i18n.js'

const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f']
const color = i => i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)} 65% 45%)`
const DAY = 86400
const TIP_ROWS = 12 // max. Kanaele im Werte-Feld
const PT_SIZE = 4 // Messpunkt (Durchmesser, px)
const PT_SPACE = 6 // Messpunkte erst zeigen, wenn sie mind. so weit (px) auseinander liegen

let cssDone = false
function injectCss() {
    if (cssDone || typeof document === 'undefined') return
    cssDone = true
    for (const rel of ['../vendor/uplot/uPlot.min.css', './ltx-view.css']) {
        const href = new URL(rel, import.meta.url).href
        if (document.querySelector(`link[href="${href}"]`)) continue
        const l = document.createElement('link')
        l.rel = 'stylesheet'
        l.href = href
        document.head.appendChild(l)
    }
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
 *   height     Hoehe je Messwert-Diagramm in px oder 'auto' (nach Fensterhoehe, 300-560), hkHeight dito (200-320)
 *   injectCss  CSS automatisch laden (true)
 *   title      Titel, falls weder iparam noch EDT einen Namen liefern */
export function createViewer(el, opts = {}) {
    const o = { theme: 'auto', height: 'auto', hkHeight: 'auto', injectCss: true, ...opts }
    if (o.injectCss) injectCss()
    const st = {
        edt: null, ip: null, ipError: '', series: null, plots: [], tips: new Map(),
        syncing: false, building: false, hover: null,
        time: o.time ?? null,
        on: new Set(), // Gruppen-Keys der angezeigten Diagramme
        off: new Map(), // Gruppen-Key -> Set ausgeblendeter Kanaele
        range: null, // gewaehlter Zeitraum in UTC-Sekunden { min, max } (bleibt bei Zeitzonen-Wechsel)
    }
    const syncKey = 'lv' + Math.random().toString(36).slice(2)
    el.classList.add('lv')
    let t = texts(o.lang)
    let locale = 'en-GB'

    const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
    const onScheme = () => { if (o.theme === 'auto') api.refresh() }
    mql?.addEventListener?.('change', onScheme)
    let lastWidth = 0
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        const w = el.clientWidth
        if (w === lastWidth) return
        lastWidth = w
        for (const p of st.plots) p.setSize({ width: p.root.parentElement.clientWidth, height: p.height })
    }) : null
    ro?.observe(el)

    function themeName() {
        if (o.theme === 'light' || o.theme === 'dark') return o.theme
        const ht = document.documentElement.dataset.theme
        if (ht === 'dark' || ht === 'light') return ht
        return mql?.matches ? 'dark' : 'light'
    }
    const cssVar = (name, fb) => getComputedStyle(el).getPropertyValue(name).trim() || fb

    function plotHeight(hk) {
        const h = hk ? o.hkHeight : o.height
        if (typeof h === 'number') return h
        const vh = typeof innerHeight === 'number' ? innerHeight : 800
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
        for (const p of st.plots) p.destroy()
        st.plots = []
        st.tips.clear()
        st.hover = null
    }

    function chanLabel(c) {
        if (c.hk) return t.hk[c.ch] ?? `${t.channel} ${c.ch}`
        let s = `${t.channel} ${c.ch}`
        if (c.meta?.sdi) s += ` (SDI ${c.meta.sdi.addr})`
        return s
    }

    // Titel (HTML): Einheit bzw. HK-Name; fruehere Einheiten der Kanaele (anderer Parametersatz) gedimmt
    function groupTitle(g) {
        const unit = g.unit || t.noUnit
        if (g.hk) return esc(`${g.channels.map(chanLabel).join(', ')} · ${unit}`)
        const older = [...new Set(g.channels.flatMap(c => c.units))].filter(u => u !== g.unit).map(u => u || t.noUnit)
        return esc(unit) + (older.length ? ` <small>${esc(t.unitChanged)}: ${esc(older.join(', '))}</small>` : '')
    }

    // ---------- Werte am Cursor: schwebendes Feld im Diagramm (kein Einfluss auf das Layout) ----------
    function updateTip(u, tm, nf) {
        const tip = st.tips.get(u)
        if (!tip) return
        const { left, top, idx } = u.cursor
        if (st.hover !== u || idx == null || left == null || left < 0) {
            tip.hidden = true
            return
        }
        const rows = []
        for (let i = 1; i < u.series.length; i++) {
            if (!u.series[i].show) continue
            const v = u.data[i][u.cursor.idxs?.[i] ?? idx]
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

    function makePlot(g, xs, mount, tm, markers, theme, onRange, height) {
        const chans = g.channels
        const off = st.off.get(g.key)
        const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
        const fg = cssVar('--lv-fg', theme === 'dark' ? '#d8dadd' : '#3e3d40')
        const grid = cssVar('--lv-grid', theme === 'dark' ? '#33373b' : '#e6e7e8')
        const names = { MMMM: t.months, MMM: t.months, WWWW: ['', '', '', '', '', '', ''], WWW: ['', '', '', '', '', '', ''] }
        const series = [{ label: t.timeZone }]
        chans.forEach((c, i) => series.push({
            label: chanLabel(c),
            stroke: color(i),
            width: 1.5,
            spanGaps: false,
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
            cursor: { sync: { key: syncKey }, drag: { x: true, y: false } },
            scales: { x: { time: true } },
            legend: { show: false }, // eigene Kanalliste rechts, Werte im schwebenden Feld
            series,
            axes: [
                { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: axisStamps(), size: 46 },
                { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 64,
                    values: (u, splits) => splits.map(v => v == null ? '' : nf.format(v)) },
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

    // Markierungen: neuer Parametersatz = senkrechte Linie (gestrichelt, dezent), Reset = kurze Marke oben;
    // Alarmgrenzen = waagerechte Linie in Kanalfarbe
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
            ctx.globalAlpha = m.tick ? 0.9 : 0.45
            ctx.setLineDash(m.tick ? [] : [5 * dpr, 4 * dpr])
            ctx.beginPath()
            ctx.moveTo(px, top)
            ctx.lineTo(px, m.tick ? top + 7 * dpr : top + height)
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
        const label = g.hk ? g.channels.map(chanLabel).join(', ') : (g.unit || t.noUnit)
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
            + `<i style="background:${color(i)}"></i><span>${esc(chanLabel(c))}</span></button></li>`).join('')
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

    function renderCharts(s, tm, theme) {
        const ip = st.ip
        const span = s.stats.t1 - s.stats.t0
        const timeOpts = []
        if (Number.isInteger(ip?.utcOffset)) timeOpts.push(['logger', t.loggerTime(offText(ip.utcOffset))])
        timeOpts.push(['utc', t.utc], ['local', t.localTime])
        const ranges = [30, 7, 1].filter(d => d * DAY < span)

        let selHtml = ''
        if (s.groups.length > 1) {
            const row = hk => {
                const gs = s.groups.filter(g => g.hk === hk)
                return gs.length ? `<div class="lv-sel-row"><span class="lv-sel-h">${esc(hk ? t.device : t.measurements)}</span>`
                    + gs.map(chipHtml).join('') + `</div>` : ''
            }
            selHtml = `<div class="lv-sel" role="group" aria-label="${esc(t.charts)}">${row(false)}${row(true)}</div>`
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
        const accent = cssVar('--lv-accent', '#0e7c89')
        const muted = cssVar('--lv-muted', '#8a8d91')
        s.sets.slice(1).forEach(set => markers.push({ t: set.t0, color: accent }))
        for (const e of s.events) if (e.tag.startsWith('RESET')) markers.push({ t: e.t, color: muted, tick: true })

        const xs = tm.shift ? s.x.map(v => v + tm.shift) : s.x
        const panels = el.querySelector('.lv-panels')

        // Diagramme (neu) aufbauen, z. B. nach Ein-/Ausschalten in der Leiste; Zeitraum bleibt
        const buildPanels = () => {
            destroyPlots()
            panels.innerHTML = ''
            let lastHk = null
            st.building = true
            const built = []
            for (const g of s.groups) {
                if (!st.on.has(g.key)) continue
                if (g.hk !== lastHk) {
                    const h = document.createElement('h3')
                    h.className = 'lv-section'
                    h.textContent = g.hk ? t.device : t.measurements
                    panels.appendChild(h)
                    lastHk = g.hk
                }
                const height = plotHeight(g.hk)
                const sec = document.createElement('section')
                sec.className = 'lv-panel' + (g.hk ? ' lv-panel-hk' : '')
                sec.style.setProperty('--lv-h', height + 'px')
                sec.innerHTML = `<h4>${groupTitle(g)}</h4><div class="lv-body"><div class="lv-plot"></div>${legendHtml(g)}</div>`
                panels.appendChild(sec)
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
                const u = makePlot(g, xs, sec.querySelector('.lv-plot'), tm, markers, theme, onRange, height)
                st.plots.push(u)
                bindLegend(sec.querySelector('.lv-legend'), u, g)
            }
            st.building = false
            if (!st.plots.length) panels.innerHTML = `<div class="lv-empty">${esc(t.noChart)}</div>`
            const r = st.range
            if (r) setX(r.min + tm.shift, r.max + tm.shift)
            else onRange(x0, x1)
            lastWidth = el.clientWidth
        }

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
            // Vorauswahl: alle Messwert-Diagramme (gibt es keine: alle Diagramme), alle Kanaele sichtbar
            const groups = st.series.groups
            const meas = groups.filter(g => !g.hk)
            st.on = new Set((meas.length ? meas : groups).map(g => g.key))
            st.off = new Map(groups.map(g => [g.key, new Set()]))
            st.range = null
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
        /* Optionen aendern (lang, theme, time, height, hkHeight) und neu zeichnen */
        setOptions(n = {}) {
            Object.assign(o, n)
            if (n.time !== undefined) st.time = n.time
            render()
        },
        refresh: () => render(),
        destroy() {
            destroyPlots()
            ro?.disconnect()
            mql?.removeEventListener?.('change', onScheme)
            el.innerHTML = ''
            el.classList.remove('lv')
        },
        get series() { return st.series },
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
