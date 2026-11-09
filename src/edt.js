/* edt.js - Parser fuer LTX-EDT-Dateien (Easy Data Text), ohne DOM- und UI-Abhaengigkeiten.
 *
 * Format: Info-Tags <...>, Kopf !U <kanal>:<einheit> ..., Messzeilen !<zeit> <kanal>:<wert> ...
 * (Zeit absolut in Unix-UTC-Sekunden oder relativ '+<sek>'), Base64-Zeilen $... (komprimiert).
 *
 * Ein Parametersatz (set) beginnt mit einem !U, dessen Kanaele/Einheiten sich vom vorherigen unterscheiden.
 * Ein gleicher Kopf (z. B. nach <RESET> oder neuem COOKIE ohne Aenderung der Kanaele) setzt den Satz fort.
 */

// Byte-Order-Mark am Dateianfang entfernen (als charCode, damit die Quelle reines ASCII bleibt)
export function stripBom(s) {
    return s.charCodeAt(0) === 0xFEFF ? s.substring(1) : s
}

// Zeitstempel davor gelten als ungueltig (Logger-Uhr nach Reset noch nicht gestellt)
export const MIN_VALID_TIME = 946684800 // 2000-01-01T00:00:00Z

// Fehlercodes in komprimierten Kanalwerten (0xFD + 24 Bit)
function errText(errno) {
    switch (errno) {
        case 1: return 'NoValue'
        case 2: return 'NoReply'
        case 3: return 'OldValue'
        case 6: return 'ErrorCRC'
        case 7: return 'DataError'
        case 8: return 'NoCachedValue'
        default: return 'Err' + errno
    }
}

function b64ToBytes(b64) {
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4)) // Logger schreiben ohne Padding
    return Uint8Array.from(bin, c => c.charCodeAt(0))
}

// '$'-Zeile -> [[kanal, wert], ...]. st: { lux: letzte Zeit, dt: letzte Delta-Zeit }
// Tokens laut Doku: 0-89 Kanal (Float32 BE), 90-99 HK (UInt16 BE), 110 Alarm, 111 Delta-Zeit
function decodeB64(b64, st) {
    const bbuf = b64ToBytes(b64)
    const dv = new DataView(bbuf.buffer)
    const pairs = []
    let alarm = false
    for (let idx = 0; idx < bbuf.length;) {
        const tok = bbuf[idx++]
        if (tok < 90) {
            if (idx + 4 > bbuf.length) throw new Error('short value')
            let val
            if (bbuf[idx] === 0xFD) val = errText((bbuf[idx + 1] << 16) | (bbuf[idx + 2] << 8) | bbuf[idx + 3])
            else val = (alarm ? '*' : '') + Number(dv.getFloat32(idx).toPrecision(7))
            idx += 4
            pairs.push([tok, val])
            alarm = false
        } else if (tok < 100) {
            if (idx + 2 > bbuf.length) throw new Error('short HK value')
            const raw = dv.getUint16(idx)
            idx += 2
            pairs.push([tok, raw === 0x80FD ? 'Error' : hkScale(tok, raw)])
        } else if (tok === 110) {
            alarm = true
        } else if (tok === 111) {
            if (idx + 2 > bbuf.length) throw new Error('short delta time')
            st.dt = dv.getUint16(idx)
            idx += 2
        } else {
            throw new Error('unknown token ' + tok)
        }
    }
    if (!st.dt || st.dt >= 43200) throw new Error('illegal delta time')
    st.lux += st.dt
    return pairs
}

// Komprimierte HK-Werte -> Anzeigeeinheit wie im ASCII-EDT
function hkScale(ch, raw) {
    switch (ch) {
        case 90: return String(raw / 1000) // mV -> V
        case 91: return String((raw > 32767 ? raw - 65536 : raw) / 10) // 0,1 °C, vorzeichenbehaftet
        case 92: return String(raw / 10) // 0,1 %rH
        case 93: return String(raw) // mAh
        case 94: return String(raw / 10) // 0,1 mbar
        default: return String(raw)
    }
}

/* EDT-Text -> {
 *   mac, name, lines,
 *   sets: [{ no, cookie, sig, units: {kanal: einheit}, cols: [kanal...], rows: [{ t, v: {kanal: text}, info: [tags] }] }],
 *   events: [{ t, tag }]      Info-Tags (ausser MAC/NAME/COOKIE) mit Zeit der naechsten Messzeile (sonst der letzten)
 *   warnings: [text], warnCnt,
 *   invalidTime               Anzahl Messzeilen mit ungueltiger Zeit (vor MIN_VALID_TIME), werden uebersprungen
 * }
 * Werte bleiben Text wie im EDT: Zahl, Alarm '*Zahl' oder Fehlertext (z. B. 'NoReply'). */
export function parseEdt(text) {
    const res = { mac: '', name: '', lines: 0, sets: [], events: [], warnings: [], warnCnt: 0, invalidTime: 0 }
    const warn = (i, msg) => {
        if (res.warnings.length < 50) res.warnings.push(`Line ${i + 1}: ${msg}`)
        res.warnCnt++
    }
    const st = { lux: 0, dt: 0 }
    let set = null
    let cookie = ''
    let pending = [] // Info-Tags fuer die naechste Messzeile

    const newSet = (units, sig) => {
        if (set && !set.rows.length) res.sets.pop() // Kopf ohne Messzeilen: ersetzen
        const last = res.sets[res.sets.length - 1]
        if (last && last.sig === sig) { set = last; return } // gleicher Kopf wie davor: fortsetzen
        set = { no: 0, cookie, sig, units: {}, cols: [], rows: [] }
        for (const [ch, u] of units) {
            if (set.units[ch] === undefined) set.cols.push(ch)
            set.units[ch] = u
        }
        res.sets.push(set)
        res.sets.forEach((s, i) => s.no = i + 1)
    }
    const addRow = (i, t, pairs) => {
        if (t < MIN_VALID_TIME) {
            res.invalidTime++
            pending = []
            return
        }
        if (!set) newSet([], '')
        for (const tag of pending) res.events.push({ t, tag })
        const row = { t, v: {}, info: pending }
        pending = []
        for (const [ch, val] of pairs) {
            if (row.v[ch] !== undefined) { warn(i, `double value for channel ${ch}`); continue }
            if (set.units[ch] === undefined) { set.units[ch] = '?'; set.cols.push(ch) }
            row.v[ch] = val
        }
        set.rows.push(row)
    }

    const lines = stripBom(String(text)).replaceAll('\r', '').split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        res.lines++
        const c0 = line.charAt(0)
        if (c0 === '<') {
            const tag = line.endsWith('>') ? line.slice(1, -1) : line.slice(1)
            if (tag.startsWith('MAC: ')) res.mac = tag.substring(5).trim()
            else if (tag.startsWith('NAME: ')) res.name = tag.substring(6).trim()
            else if (tag.startsWith('COOKIE ')) cookie = tag.substring(7).trim()
            else pending.push(tag)
        } else if (c0 === '$') {
            try {
                const pairs = decodeB64(line.substring(1), st) // setzt st.lux
                addRow(i, st.lux, pairs)
            } catch (err) {
                warn(i, `Base64: ${err.message}`)
            }
        } else if (c0 === '!') {
            const parts = line.substring(1).split(/\s+/)
            const isUnits = parts[0] === 'U'
            const pairs = []
            for (let k = 1; k < parts.length; k++) {
                const p = parts[k].indexOf(':')
                const ch = p > 0 ? Number(parts[k].substring(0, p)) : NaN
                // Im Kopf !U ist eine leere Einheit erlaubt ('0:' = Kanal ohne Einheit), in Messzeilen kein leerer Wert
                if (!Number.isInteger(ch) || ch < 0 || ch > 255 || (p === parts[k].length - 1 && !isUnits)) {
                    warn(i, `format '${parts[k]}'`)
                    continue
                }
                pairs.push([ch, parts[k].substring(p + 1)])
            }
            if (isUnits) {
                // Kennung nur aus Kanaelen + Einheiten (sortiert), COOKIE allein trennt nicht
                const sig = pairs.map(([c, u]) => c + ':' + u).sort().join(' ')
                if (!set || set.sig !== sig) newSet(pairs, sig)
                continue
            }
            const ts = parts[0]
            const n = Number(ts)
            if (!/^\+?\d+$/.test(ts) || !Number.isFinite(n)) { warn(i, `time '${ts}'`); continue }
            if (ts.charAt(0) === '+') {
                st.dt = n
                st.lux += n
            } else {
                st.lux = n
            }
            addRow(i, st.lux, pairs)
        } else if (c0 !== '#') {
            warn(i, `format '${line.substring(0, 40)}'`)
        }
    }
    if (pending.length && set?.rows.length) {
        const last = set.rows[set.rows.length - 1]
        last.info.push(...pending)
        for (const tag of pending) res.events.push({ t: last.t, tag })
    }
    res.sets = res.sets.filter(s => s.rows.length)
    res.sets.forEach((s, i) => s.no = i + 1)
    return res
}

const NUM_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

/* Wert aus dem EDT (Text) -> { num, alarm, err }
 * num: Zahl oder null (Fehlertext), alarm: true bei '*', err: Fehlertext oder '' */
export function parseValue(s) {
    let txt = String(s)
    let alarm = false
    if (txt.startsWith('*')) { alarm = true; txt = txt.substring(1) }
    if (NUM_RE.test(txt)) return { num: Number(txt), alarm, err: '' }
    return { num: null, alarm, err: txt }
}
