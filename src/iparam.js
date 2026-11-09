/* iparam.js - Parser fuer LTX-Parameterdateien iparam.lxp (nur lesen, fuer Metadaten der Visualisierung).
 *
 * Aufbau (LTX-Parameterreferenz): Block '@100' mit 21 Zeilen (Index 0 = '@100'), danach je Kanal ein Block
 * '@<n>' mit 14 Zeilen (Index 0 = '@<n>'). Leere Zeilen sind gueltige (leere) Werte.
 */

import { stripBom } from './edt.js'

const BASE_LINES = 21
const CHAN_LINES = 14

const int = s => {
    const n = Number(s)
    return Number.isFinite(n) && String(s).trim() !== '' ? Math.trunc(n) : null
}
const float = s => {
    const n = Number(s)
    return Number.isFinite(n) && String(s).trim() !== '' ? n : null
}

// Extra-Bytes SDI-12: '[*<Vorlauf_ms> ]<Adresse><Befehl>', z. B. '*1800 0MC'
function sdiParts(x) {
    const m = /^(?:\*(\d+)\s+)?([0-9A-Za-z])([A-Za-z0-9!?]*)$/.exec(String(x).trim())
    return m ? { warmup: m[1] ? Number(m[1]) : null, addr: m[2], cmd: m[3] } : null
}

/* iparam-Text -> {
 *   type, maxChannels, hkFlags, cookie, name, period, periodOffset, alarmPeriod, utcOffset,
 *   recFlags, hkActive, hkReload,
 *   channels: { <n>: { action, measure, cache, alarm, phys, unit, format, dbId, offset, factor,
 *                      alarmHi, alarmLo, xbytes, sdi: {warmup, addr, cmd} | null } }
 * }
 * Wirft einen Error, wenn die Datei keine iparam-Datei ist. */
export function parseIparam(text) {
    const lines = stripBom(String(text)).replaceAll('\r', '').split('\n')
    if (lines[0].trim() !== '@100') throw new Error("not an iparam file (missing '@100')")
    if (lines.length < BASE_LINES) throw new Error('iparam file too short')
    const b = lines
    const res = {
        type: int(b[1]),
        maxChannels: int(b[2]),
        hkFlags: int(b[3]),
        cookie: b[4].trim(),
        name: b[5].trim(),
        period: int(b[6]),
        periodOffset: int(b[7]),
        alarmPeriod: int(b[8]),
        utcOffset: int(b[11]),
        recFlags: int(b[12]),
        hkActive: int(b[13]),
        hkReload: int(b[14]),
        channels: {},
    }
    for (let i = BASE_LINES; i < lines.length;) {
        const head = lines[i].trim()
        if (!head) { i++; continue } // Leerzeilen zwischen/nach Bloecken
        const m = /^@(\d+)$/.exec(head)
        if (!m) throw new Error(`unexpected line ${i + 1}: '${head.substring(0, 20)}'`)
        const c = lines.slice(i, i + CHAN_LINES)
        while (c.length < CHAN_LINES) c.push('')
        const action = int(c[1]) ?? 0
        res.channels[Number(m[1])] = {
            action,
            measure: (action & 1) !== 0,
            cache: (action & 2) !== 0,
            alarm: (action & 4) !== 0,
            phys: int(c[2]),
            unit: c[5].trim(),
            format: int(c[6]),
            dbId: int(c[7]),
            offset: float(c[8]),
            factor: float(c[9]),
            alarmHi: float(c[10]),
            alarmLo: float(c[11]),
            xbytes: c[13].trim(),
            sdi: sdiParts(c[13]),
        }
        i += CHAN_LINES
    }
    return res
}
