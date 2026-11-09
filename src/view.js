/* view.js - Viewer: Diagramme (uPlot) fuer EDT-Daten, ein Diagramm je Einheit, gemeinsame Zeitachse.
 *
 *   const v = createViewer(element, { lang: 'de' })
 *   v.setData({ edt: text, iparam: text })          // iparam optional
 *
 * Bedienung: Ziehen = Zeitbereich zoomen (alle Diagramme), Doppelklick = alles, Legende = Kanal ein/aus.
 */

import uPlot from '../vendor/uplot/uPlot.esm.js'
import { parseEdt } from './edt.js'
import { parseIparam } from './iparam.js'
import { buildSeries } from './series.js'
import { texts } from './i18n.js'

const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#bcbd22', '#7f7f7f']
const color = i => i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.508) % 360)} 65% 45%)`
const DAY = 86400

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

function offText(sec) {
    const a = Math.abs(sec)
    const p2 = n => String(n).padStart(2, '0')
    return `UTC${sec < 0 ? '-' : '+'}${p2(Math.floor(a / 3600))}:${p2(Math.floor(a % 3600 / 60))}`
}

function durText(sec, lang) {
    if (sec % 86400 === 0) return `${sec / 86400} d`
    if (sec % 3600 === 0) return `${sec / 3600} h`
    if (sec % 60 === 0) return `${sec / 60} min`
    return `${sec} s`
}

/* el: Container (wird geleert), opts:
 *   lang       'de' | 'en' (Standard: Browsersprache)
 *   theme      'auto' | 'light' | 'dark' ('auto': data-theme am <html>, sonst Systemeinstellung)
 *   time       'logger' | 'utc' | 'local' (Standard: 'logger', wenn der UTC-Versatz aus iparam bekannt ist, sonst 'local')
 *   height     Hoehe je Messwert-Diagramm in px (260), hkHeight Hoehe je Geraetewert-Diagramm (150)
 *   injectCss  CSS automatisch laden (true)
 *   title      Titel, falls weder iparam noch EDT einen Namen liefern */
export function createViewer(el, opts = {}) {
    const o = { theme: 'auto', height: 260, hkHeight: 150, injectCss: true, ...opts }
    if (o.injectCss) injectCss()
    const st = { edt: null, ip: null, ipError: '', series: null, plots: [], syncing: false, time: o.time ?? null }
    const syncKey = 'lv' + Math.random().toString(36).slice(2)
    el.classList.add('lv')
    let t = texts(o.lang)
    let locale = t === texts('de') ? 'de-DE' : 'en-GB'

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

    // Zeitmodus -> Verschiebung (s) und uPlot-Zeitzone
    function timeMode() {
        const off = st.ip?.utcOffset
        let m = st.time ?? (Number.isInteger(off) ? 'logger' : 'local')
        if (m === 'logger' && !Number.isInteger(off)) m = 'local'
        return { mode: m, shift: m === 'logger' ? off : 0, utc: m !== 'local' }
    }

    function fmtTime(v, tm) {
        const d = new Date(v * 1000)
        const g = tm.utc
            ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
            : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
        const p2 = n => String(n).padStart(2, '0')
        const date = locale === 'de-DE' ? `${p2(g[2])}.${p2(g[1])}.${g[0]}` : `${g[0]}-${p2(g[1])}-${p2(g[2])}`
        return `${date} ${p2(g[3])}:${p2(g[4])}${g[5] ? ':' + p2(g[5]) : ''}`
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

    function makePlot(g, xs, mount, tm, markers, theme) {
        const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
        const fg = cssVar('--lv-fg', theme === 'dark' ? '#d8dadd' : '#3e3d40')
        const grid = cssVar('--lv-grid', theme === 'dark' ? '#33373b' : '#e6e7e8')
        const names = { MMMM: t.months, MMM: t.months, WWWW: ['', '', '', '', '', '', ''], WWW: ['', '', '', '', '', '', ''] }
        const series = [{ label: t.timeZone, value: (u, v) => v == null ? '–' : fmtTime(v, tm) }]
        g.channels.forEach((c, i) => series.push({
            label: chanLabel(c),
            stroke: color(i),
            width: 1.5,
            spanGaps: false,
            // Einzelwerte zwischen Luecken als Punkt, sonst Punkte nur bei wenigen Werten (uPlot-Standard)
            points: { filter: (u, si, show) => show ? null : (c.isolated.length ? c.isolated : null) },
            value: (u, v) => v == null ? '–' : nf.format(v),
        }))
        const opts = {
            width: mount.clientWidth || 600,
            height: g.hk ? o.hkHeight : o.height,
            tzDate: tm.utc ? ts => uPlot.tzDate(new Date(ts * 1e3), 'Etc/UTC') : undefined,
            fmtDate: tpl => uPlot.fmtDate(tpl, names),
            cursor: { sync: { key: syncKey }, drag: { x: true, y: false } },
            scales: { x: { time: true } },
            legend: { live: true },
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
                }],
                draw: [u => drawMarks(u, g, markers, tm)],
            },
        }
        if (!tm.utc) delete opts.tzDate
        const data = [xs, ...g.channels.map(c => c.data)]
        return new uPlot(opts, data, mount)
    }

    // Markierungen: neuer Parametersatz = senkrechte Linie (gestrichelt, dezent), Reset = kurze Marke oben;
    // Alarmgrenzen = waagerechte Linie in Kanalfarbe
    function drawMarks(u, g, markers, tm) {
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
        g.channels.forEach((c, i) => {
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

    function setRange(days) {
        const p = st.plots[0]
        const xs = p?.data[0]
        if (!xs?.length) return
        const max = xs[xs.length - 1]
        const min = days ? Math.max(xs[0], max - days * DAY) : xs[0]
        p.setScale('x', { min, max }) // setScale-Hook uebertraegt auf alle
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
        const tm = timeMode()
        const ip = st.ip
        const name = ip?.name || st.edt.name || o.title || ''
        const span = s.stats.t1 - s.stats.t0

        const facts = [`${fmtTime(s.stats.t0 + tm.shift, tm)} – ${fmtTime(s.stats.t1 + tm.shift, tm)}`,
            `${s.stats.rows} ${t.rows}`, `${s.channels.length} ${t.channels}`]
        if (ip?.period) facts.push(`${t.interval} ${durText(ip.period)}`)
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

        const timeOpts = []
        if (Number.isInteger(ip?.utcOffset)) timeOpts.push(['logger', t.loggerTime(offText(ip.utcOffset))])
        timeOpts.push(['utc', t.utc], ['local', t.localTime])
        const ranges = [30, 7, 1].filter(d => d * DAY < span)

        el.innerHTML = `<div class="lv-head">
                <div class="lv-title">${esc(name)}${st.edt.mac ? ` <span class="lv-mac">${esc(st.edt.mac)}</span>` : ''}</div>
                <div class="lv-facts">${facts.map(esc).join(' · ')}</div>
                ${notes.length ? `<div class="lv-notes">${notes.map(esc).join(' · ')}</div>` : ''}${warnHtml}
            </div>
            <div class="lv-bar">
                <div class="lv-ranges"><button type="button" data-days="0">${esc(t.all)}</button>${ranges.map(d =>
                    `<button type="button" data-days="${d}">${esc(t.days(d))}</button>`).join('')}</div>
                <label class="lv-tz">${esc(t.timeZone)} <select>${timeOpts.map(([v, l]) =>
                    `<option value="${v}"${v === tm.mode ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
            </div>
            <div class="lv-panels"></div>`
        el.querySelectorAll('.lv-ranges button').forEach(b => b.addEventListener('click', () => setRange(Number(b.dataset.days))))
        el.querySelector('.lv-tz select').addEventListener('change', ev => { st.time = ev.target.value; render() })

        const markers = []
        const accent = cssVar('--lv-accent', '#0e7c89')
        const muted = cssVar('--lv-muted', '#8a8d91')
        s.sets.slice(1).forEach(set => markers.push({ t: set.t0, color: accent }))
        for (const e of s.events) if (e.tag.startsWith('RESET')) markers.push({ t: e.t, color: muted, tick: true })

        const xs = tm.shift ? s.x.map(v => v + tm.shift) : s.x
        const panels = el.querySelector('.lv-panels')
        let lastHk = null
        for (const g of s.groups) {
            if (g.hk !== lastHk) {
                const h = document.createElement('h3')
                h.className = 'lv-section'
                h.textContent = g.hk ? t.device : t.measurements
                panels.appendChild(h)
                lastHk = g.hk
            }
            const sec = document.createElement('section')
            sec.className = 'lv-panel' + (g.hk ? ' lv-panel-hk' : '')
            sec.innerHTML = `<h4>${groupTitle(g)}</h4><div class="lv-plot"></div>`
            panels.appendChild(sec)
            st.plots.push(makePlot(g, xs, sec.querySelector('.lv-plot'), tm, markers, theme))
        }
        lastWidth = el.clientWidth
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
    const first = String(text).replace(/^﻿/, '').trimStart().split(/\r?\n/, 1)[0].trim()
    if (first === '@100') return 'iparam'
    if (first === '@200') return 'sysparam'
    return 'edt'
}
