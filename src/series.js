/* series.js - EDT (+ optional iparam) -> Datenreihen fuer die Diagramme. Ohne DOM.
 *
 * Je Kanal eine Reihe ueber alle Parametersaetze. Einheit = zuletzt verwendete Einheit des Kanals.
 * Gruppen (= ein Diagramm): Messkanaele (0-89) nach Einheit, HK-Kanaele (90-99) nach Einheit.
 * Werte in den Datenarrays (uPlot-Konvention):
 *   Zahl      Messwert
 *   null      Luecke: Fehlertext (z. B. NoReply) oder Aussetzer (Abstand deutlich groesser als normal)
 *   undefined Kanal hat zu diesem Zeitpunkt keinen Eintrag (Linie wird durchgezogen = interpoliert)
 *
 * Normaler Messabstand: wird je Kanal aus den Daten ermittelt, und zwar lokal (Median der Abstaende kurz davor
 * und kurz danach). So bleiben wechselnde Messintervalle (anderer Parametersatz, Alarm-Intervall, HK seltener)
 * verbunden; nur ein Abstand, der groesser ist als normal davor UND danach, gilt als Aussetzer.
 */

import { parseValue } from './edt.js'

export const HK_FIRST = 90
const WIN = 8 // Abstaende je Seite fuer den lokalen Median

function median(a) {
    if (!a.length) return 0
    const b = [...a].sort((x, y) => x - y)
    return b[b.length >> 1]
}

function medianStep(times) {
    if (times.length < 3) return 0
    const d = []
    for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1])
    return median(d)
}

/* Aussetzer finden. times: sortiert. -> [{ i, step }]: Luecke zwischen times[i-1] und times[i], step = normaler
 * Abstand davor (fuer den null-Punkt). Abstand d[i] ist ein Aussetzer, wenn d > factor x max(Median davor,
 * Median danach); fehlt eine Seite, zaehlt die andere. Mit weniger als 3 Abstaenden gilt fallback (typischer
 * Abstand aller Messzeilen) als normal, sonst wuerden wenige Werte ueber beliebig lange Zeit verbunden. */
export function findGaps(times, factor = 1.5, fallback = 0) {
    const n = times.length
    if (n < 2) return []
    if (n < 4) {
        const res = []
        if (fallback > 0) for (let i = 1; i < n; i++) if (times[i] - times[i - 1] > factor * fallback) res.push({ i, step: fallback })
        return res
    }
    const d = new Array(n).fill(0)
    for (let i = 1; i < n; i++) d[i] = times[i] - times[i - 1]
    const res = []
    for (let i = 1; i < n; i++) {
        const before = median(d.slice(Math.max(1, i - WIN), i))
        const after = median(d.slice(i + 1, i + 1 + WIN))
        const ref = Math.max(before, after)
        if (ref > 0 && d[i] > factor * ref) res.push({ i, step: before || after })
    }
    return res
}

// Luecke bis zum naechsten bzw. vorherigen Wert ausdehnen: uPlot schneidet nur aufeinanderfolgende null aus,
// dazwischen liegende Zeitpunkte anderer Kanaele (undefined) wuerden die Linie sonst ueber die Luecke ziehen
function nullExpand(data) {
    for (let i = 0; i < data.length; i++) {
        if (data[i] !== null) continue
        for (let k = i - 1; k >= 0 && data[k] === undefined; k--) data[k] = null
        let k = i + 1
        for (; k < data.length && data[k] === undefined; k++) data[k] = null
        i = k - 1
    }
}

// Einzelne Werte zwischen Luecken (keine Linie moeglich) -> Indizes, dort zeichnet der Viewer einen Punkt
function isolatedIdx(data) {
    const res = []
    let prev = null // letzter Eintrag != undefined
    for (let i = 0; i < data.length; i++) {
        const v = data[i]
        if (v === undefined) continue
        if (typeof v === 'number' && (prev === null || data[prev] === null)) {
            let k = i + 1
            while (k < data.length && data[k] === undefined) k++
            if (k >= data.length || data[k] === null) res.push(i)
        }
        prev = i
    }
    return res
}

/* Runder y-Bereich fuer die Werte lo..hi (Knopf 'auto' im kombinierten Diagramm) -> [min, max], ohne Werte null.
 * Untergrenze in der Regel 0: nur nicht, wenn Werte negativ sind oder so hoch liegen, dass sie ab 0 weniger als ein
 * Viertel der Hoehe nutzen wuerden (lo > 3/4 hi, z. B. Luftdruck 1000-1010). Nur negative Werte: Obergrenze 0
 * (gespiegelt). Grenzen auf eine runde Schrittweite (1, 2, 2,5, 5 x 10^n, etwa 5 Schritte), mit etwas Rand. */
export function niceRange(lo, hi) {
    if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi)) return null
    if (lo === 0 && hi === 0) return [0, 1]
    const zeroLo = lo >= 0 && hi > 0 && lo <= 0.75 * hi
    const zeroHi = !zeroLo && hi <= 0 && lo < 0 && hi >= 0.75 * lo
    const a = zeroLo ? 0 : lo, b = zeroHi ? 0 : hi
    const span = b - a || Math.abs(a) || 1
    const raw = span / 5
    const mag = 10 ** Math.floor(Math.log10(raw))
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw * 0.999)
    const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1)
    const r = v => Number(v.toFixed(dec))
    const pad = span * 0.02
    const min = zeroLo ? 0 : r(Math.floor((a - pad) / step) * step)
    const max = zeroHi ? 0 : r(Math.ceil((b + pad) / step) * step)
    return [min, max]
}

/* Messkanaele nach SDI-12-Geraet (Adresse) gruppieren, fuer die Darstellung 'sdi'. series: Ergebnis von buildSeries().
 * Adresse aus iparam wie im Kanalnamen: eigene Extra-Bytes, bei Cache-Kanaelen die des Sensors davor. Geraete in der
 * Reihenfolge ihrer kleinsten Kanalnummer, Kanaele ohne SDI-Adresse (anderer Sensor, Kanal fehlt im iparam) am Ende in
 * einer eigenen Gruppe. -> [{ key: 'sdi:<Adresse>' bzw. 'sdi:-', hk: false, sdi: Adresse | null, units, channels }],
 * leer, wenn kein Kanal eine SDI-Adresse hat (z. B. ohne iparam) */
export function sdiGroups(series) {
    const map = new Map()
    for (const c of series.channels) {
        if (c.hk) continue
        const addr = (c.meta?.sdi ?? c.meta?.srcSdi)?.addr ?? null
        const key = 'sdi:' + (addr ?? '-')
        if (!map.has(key)) map.set(key, { key, hk: false, sdi: addr, units: [], channels: [] })
        const g = map.get(key)
        g.channels.push(c)
        if (!g.units.includes(c.unit)) g.units.push(c.unit)
    }
    const groups = [...map.values()]
    if (!groups.some(g => g.sdi != null)) return []
    return groups.sort((a, b) => ((a.sdi == null) - (b.sdi == null)) || (a.channels[0].ch - b.channels[0].ch))
}

/* edt: Ergebnis von parseEdt(), ip: Ergebnis von parseIparam() oder null
 * opts: { gapFactor: Abstand > gapFactor x normaler Abstand = Aussetzer (Standard 1.5, d. h. ab einem fehlenden Wert) }
 * -> { x: [zeit...] (UTC-Sekunden, sortiert), channels: [...], groups: [...], sets: [{no, t0, t1, cookie}], events, stats } */
export function buildSeries(edt, ip = null, opts = {}) {
    const gapFactor = opts.gapFactor ?? 1.5
    const per = new Map() // kanal -> { pts: Map(t -> wert|null), units: Set, unit, errors, alarms }
    const sets = []
    const rowTimes = new Set()
    for (const set of edt.sets) {
        sets.push({ no: set.no, cookie: set.cookie, t0: set.rows[0].t, t1: set.rows[set.rows.length - 1].t })
        for (const row of set.rows) {
            if (Object.keys(row.v).some(k => Number(k) < HK_FIRST)) rowTimes.add(row.t)
            for (const [chs, val] of Object.entries(row.v)) {
                const ch = Number(chs)
                let c = per.get(ch)
                if (!c) per.set(ch, c = { pts: new Map(), units: new Set(), unit: '', errors: 0, alarms: 0 })
                const u = set.units[ch] ?? ''
                c.units.add(u)
                c.unit = u
                const pv = parseValue(val)
                if (pv.alarm) c.alarms++
                if (pv.num === null) c.errors++
                c.pts.set(row.t, pv.num) // doppelte Zeit (Ueberlappung): letzter Wert gilt
            }
        }
    }

    // Aussetzer: zusaetzlicher null-Punkt einen normalen Abstand nach dem letzten Wert davor
    const rowStep = medianStep([...rowTimes].sort((a, b) => a - b))
    const xs = new Set()
    const chans = []
    for (const ch of [...per.keys()].sort((a, b) => a - b)) {
        const c = per.get(ch)
        const times = [...c.pts.keys()].sort((a, b) => a - b)
        const step = medianStep(times)
        const gaps = findGaps(times, gapFactor, ch < HK_FIRST ? rowStep : 0) // HK oft seltener als die Messzeilen
        for (const g of gaps) c.pts.set(times[g.i - 1] + g.step, null)
        for (const t of c.pts.keys()) xs.add(t)
        const meta = ip?.channels?.[ch]
        chans.push({
            ch,
            hk: ch >= HK_FIRST,
            unit: c.unit,
            units: [...c.units],
            step,
            errors: c.errors,
            alarms: c.alarms,
            count: times.length,
            gaps: gaps.length,
            alarmHi: meta?.alarm ? meta.alarmHi : null,
            alarmLo: meta?.alarm ? meta.alarmLo : null,
            meta: meta ?? null,
            pts: c.pts,
        })
    }
    const x = [...xs].sort((a, b) => a - b)
    const index = new Map(x.map((t, i) => [t, i]))
    for (const c of chans) {
        const data = new Array(x.length) // undefined = kein Eintrag
        for (const [t, v] of c.pts) data[index.get(t)] = v
        nullExpand(data)
        c.data = data
        c.isolated = isolatedIdx(data)
        delete c.pts
    }

    // Gruppen: erst Messkanaele, dann HK; Reihenfolge nach kleinster Kanalnummer
    const gmap = new Map()
    for (const c of chans) {
        const key = (c.hk ? 'hk:' : 'ch:') + c.unit
        if (!gmap.has(key)) gmap.set(key, { key, hk: c.hk, unit: c.unit, channels: [] })
        gmap.get(key).channels.push(c)
    }
    const groups = [...gmap.values()].sort((a, b) => (a.hk - b.hk) || (a.channels[0].ch - b.channels[0].ch))

    const values = chans.reduce((n, c) => n + c.count, 0)
    return {
        x,
        channels: chans,
        groups,
        sets,
        events: edt.events,
        stats: {
            rows: edt.sets.reduce((n, s) => n + s.rows.length, 0),
            values,
            t0: x.length ? x[0] : null,
            t1: x.length ? x[x.length - 1] : null,
            errors: chans.reduce((n, c) => n + c.errors, 0),
            alarms: chans.reduce((n, c) => n + c.alarms, 0),
            invalidTime: edt.invalidTime,
            warnings: edt.warnCnt,
            step: rowStep, // typischer Abstand der Messzeilen (ermittelt)
            gaps: chans.reduce((n, c) => n + c.gaps, 0),
        },
    }
}
