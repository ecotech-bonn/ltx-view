// node --test test/*.test.mjs  -  Parser-Tests mit den Beispielen aus der LTX-Doku (EDT-Dateiformat, Kap. 11)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEdt, parseValue } from '../src/edt.js'
import { parseIparam } from '../src/iparam.js'
import { buildSeries } from '../src/series.js'

const EX1 = `<NEW>
<NT AUTO OK(6)>
<COOKIE 1569494503>
!U 0:oC 1:oC 2:oC 90:V_HK 91:oC_HK 92:rH_HK
!1591782000 0:15.74 1:15.77 2:15.72 90:5.89 91:17.3 92:82.6
!+600 0:15.74 1:15.77 2:15.73
!+600 0:15.74 1:15.77 2:15.73
!+600 0:15.73 1:15.75 2:15.72
!+600 0:15.73 1:15.75 2:15.72
!+600 0:15.74 1:15.75 2:15.73
!1591785600 0:15.74 1:15.76 2:15.73 90:5.89 91:17.4 92:83.3
!+600 0:15.73 1:15.75 2:15.72
!+600 0:15.75 1:15.77 2:15.72
!+600 0:15.75 1:15.77 2:SensorError
!+600 0:15.76 1:15.78 2:15.73
!+600 0:15.77 1:15.80 2:15.73
<NT AUTO OK(6)>
!1591789200 0:15.77 1:15.78 2:15.73 90:5.89 91:17.6 92:83.1
!+600 0:15.76 1:15.77 2:15.73
`
const EX2 = `<MAC: 83EA5ACE6C30B9CC>
<NAME: LTX6C30B9CC>
<NOWUTC: 15.03.2023 16:55:09>
<COOKIE 1678833613>
!U 0:uS/cm 90:V(Bat) 91:°C(int) 93:mAh(Bat)
!1678889595 0:573.00 90:3.525 91:19.2 93:0.65
$bwAtAEQOQAA
$bwA8AEQOwAA
`

test('EDT example 11.1: relative times, text errors, events', () => {
    const r = parseEdt(EX1)
    assert.equal(r.sets.length, 1)
    const rows = r.sets[0].rows
    assert.equal(rows.length, 14)
    assert.equal(rows[1].t, 1591782600)
    assert.equal(rows[9].v[2], 'SensorError')
    assert.deepEqual(r.events.map(e => e.tag + '@' + e.t), ['NEW@1591782000', 'NT AUTO OK(6)@1591782000', 'NT AUTO OK(6)@1591789200'])
    assert.equal(r.warnCnt, 0)
})

test('EDT example 11.2: Base64 payload with delta time', () => {
    const r = parseEdt(EX2)
    assert.equal(r.mac, '83EA5ACE6C30B9CC')
    const rows = r.sets[0].rows
    assert.equal(rows.length, 3)
    assert.equal(rows[1].t, 1678889595 + 45) // 15:14:00 UTC
    assert.equal(rows[1].v[0], '569')
    assert.equal(rows[2].t, 1678889595 + 105)
    assert.equal(rows[2].v[0], '571')
})

test('invalid logger time is skipped', () => {
    const r = parseEdt('!U 0:m\n!30 0:1\n!1700000000 0:2\n')
    assert.equal(r.invalidTime, 1)
    assert.equal(r.sets[0].rows.length, 1)
})

test('parseValue', () => {
    assert.deepEqual(parseValue('*12.5'), { num: 12.5, alarm: true, err: '' })
    assert.deepEqual(parseValue('NoReply'), { num: null, alarm: false, err: 'NoReply' })
})

test('series: gaps and HK spanning', () => {
    const edt = parseEdt('!U 0:m 90:V\n!1700000000 0:1 90:3.6\n!+600 0:2\n!+600 0:3\n!+6000 0:4 90:3.5\n!+600 0:NoReply\n')
    const s = buildSeries(edt, null)
    const c0 = s.channels.find(c => c.ch === 0)
    assert.equal(c0.step, 600)
    assert.ok(c0.data.includes(null)) // Pause von 6000 s und NoReply
    assert.equal(c0.errors, 1)
    assert.equal(s.groups.length, 2)
    assert.equal(s.groups[1].hk, true)
})

test('iparam: base block and channels incl. empty lines', () => {
    const ip = parseIparam('@100\n1700\n30\n31\n1000000000\nLTXAB284B80\n600\n0\n0\n3600\n0\n3600\n3\n31\n6\n1\n0\n-10\n0\n\n0\n@0\n5\n768\n\n0\nbar\n9\n0\n0.0\n1.0\n10.5\n-1\n60\n*1800 0MC\n')
    assert.equal(ip.period, 600)
    assert.equal(ip.utcOffset, 3600)
    assert.equal(ip.channels[0].unit, 'bar')
    assert.equal(ip.channels[0].alarm, true)
    assert.equal(ip.channels[0].alarmHi, 10.5)
    assert.deepEqual(ip.channels[0].sdi, { warmup: 1800, addr: '0', cmd: 'MC' })
    assert.throws(() => parseIparam('@200\n'))
})

test('series: gap reaches the next value although other channels have points in between', () => {
    const edt = parseEdt('!U 0:m 1:m\n!1700000000 0:1 1:1\n!+600 0:2 1:2\n!+600 0:3 1:3\n!+600 1:4\n!+600 1:5\n!+600 1:6\n!+600 0:4 1:7\n')
    const d = buildSeries(edt, null).channels.find(c => c.ch === 0).data
    // nach 0:3 bis vor 0:4 nur null (keine undefined), damit uPlot die Linie nicht durchzieht
    assert.deepEqual(d, [1, 2, 3, null, null, null, 4])
    // 10-min-Takt, Wert 5 einzeln zwischen zwei Pausen -> wird als Punkt markiert
    const s2 = buildSeries(parseEdt('!U 0:m\n!1700000000 0:1\n!+600 0:2\n!+600 0:3\n!+600 0:4\n!+6000 0:5\n!+6000 0:6\n!+600 0:7\n!+600 0:8\n!+600 0:9\n'), null)
    assert.deepEqual(s2.channels[0].isolated.map(i => s2.channels[0].data[i]), [5])
})
