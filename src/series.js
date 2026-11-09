/* series.js - EDT (+ optional iparam) -> Datenreihen fuer die Diagramme. Ohne DOM.
 *
 * Je Kanal eine Reihe ueber alle Parametersaetze. Einheit = zuletzt verwendete Einheit des Kanals.
 * Gruppen (= ein Diagramm): Messkanaele (0-89) nach Einheit, HK-Kanaele (90-99) nach Einheit.
 * Werte in den Datenarrays (uPlot-Konvention):
 *   Zahl      Messwert
 *   null      Luecke: Fehlertext (z. B. NoReply) oder Messpause laenger als erwartet
 *   undefined Kanal hat zu diesem Zeitpunkt keinen Eintrag (Linie wird durchgezogen)
 */

import { parseValue } from './edt.js'

export const HK_FIRST = 90

function medianStep(times) {
    if (times.length < 3) return 0
    const d = []
    for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1])
    d.sort((a, b) => a - b)
    return d[d.length >> 1]
}

// Erwarteter Abstand je Kanal: iparam-Messintervall (HK: x HK-Reload). Ohne iparam: Messkanaele typischer
// Abstand aller Messzeilen des Loggers (rowStep), HK-Kanaele typischer Abstand ihrer eigenen Werte.
function expectedStep(times, ch, ip, rowStep) {
    if (ip?.period > 0) {
        if (ch < HK_FIRST) return ip.period
        if (ip.hkReload > 0) return ip.period * ip.hkReload
    }
    return ch < HK_FIRST && rowStep > 0 ? rowStep : medianStep(times)
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

/* edt: Ergebnis von parseEdt(), ip: Ergebnis von parseIparam() oder null
 * opts: { gapFactor: Abstand > gapFactor x erwartet = Luecke (Standard 2.5) }
 * -> { x: [zeit...] (UTC-Sekunden, sortiert), channels: [...], groups: [...], sets: [{no, t0, t1, cookie}], events, stats } */
export function buildSeries(edt, ip = null, opts = {}) {
    const gapFactor = opts.gapFactor ?? 2.5
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

    // Luecken: zusaetzlicher null-Punkt kurz nach dem letzten Wert vor einer Messpause
    const rowStep = medianStep([...rowTimes].sort((a, b) => a - b))
    const xs = new Set()
    const chans = []
    for (const ch of [...per.keys()].sort((a, b) => a - b)) {
        const c = per.get(ch)
        const times = [...c.pts.keys()].sort((a, b) => a - b)
        const step = expectedStep(times, ch, ip, rowStep)
        if (step > 0) {
            for (let i = 1; i < times.length; i++) {
                if (times[i] - times[i - 1] > gapFactor * step) c.pts.set(times[i - 1] + step, null)
            }
        }
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
        },
    }
}
