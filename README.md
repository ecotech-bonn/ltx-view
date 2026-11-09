# ltx-view

Visualisierung von LTX-Loggerdaten: Messwerte aus `.edt`-Dateien als Zeitreihen-Diagramme, optional mit
Kanal-Infos aus `iparam.lxp`. Reines ES-Modul ohne Build-Schritt, Diagramme mit [uPlot](https://github.com/leeoniya/uPlot)
(MIT, liegt unter `vendor/uplot/`).

Verwendet in **enviLog** (Bluetooth-App) und als eigenständige Seite, z. B. auf einem Server.

## Funktionen

- ein Diagramm je Einheit, Gerätewerte (Kanäle 90–99: Batterie, Innentemperatur …) getrennt
- gemeinsame Zeitachse: Ziehen = zoomen (alle Diagramme), Doppelklick = alles, Knöpfe Alles / 30 / 7 / 1 Tag(e)
- Zeitanzeige: Loggerzeit (UTC-Versatz aus iparam), UTC oder Ortszeit des Geräts
- echte Lücken: Fehlerwerte (`NoReply` …) und Messpausen werden nicht überbrückt; einzelne Werte als Punkt
- Markierungen: neuer Parametersatz (gestrichelt), Reset (Marke oben), Alarmgrenzen aus iparam
- Hinweise: Fehlerwerte, Alarmwerte, ungültige Loggerzeit, nicht lesbare Zeilen
- hell/dunkel, Deutsch/Englisch

## Eigenständige Seite

`index.html` über einen beliebigen Webserver ausliefern (wegen ES-Modulen nicht per `file://`).

| Aufruf | Wirkung |
|---|---|
| `index.html` | Dateien öffnen oder hineinziehen (`.edt`, optional `iparam.lxp`; `data.edt.old` + `data.edt` gemeinsam möglich) |
| `index.html?edt=/daten/x.edt&iparam=/daten/x_iparam.lxp` | Daten vom Server laden (gleiche Domain oder CORS) |
| `&lang=en`, `&title=Pegel Nord` | Sprache, Titel |

## Als Modul einbinden

Ordner `src/` und `vendor/` gemeinsam kopieren (relative Pfade bleiben erhalten). CSS wird automatisch geladen.

```js
import { createViewer } from './ltx-view/src/ltx-view.js'

const viewer = createViewer(document.getElementById('chart'), { lang: 'de' })
viewer.setData({ edt: edtText, iparam: iparamText })          // Texte; iparam optional
await viewer.loadUrls({ edt: '/daten/x.edt', iparam: '/daten/x_iparam.lxp' })
await viewer.loadFiles(inputElement.files)                     // Art wird am Inhalt erkannt
viewer.setOptions({ lang: 'en', theme: 'dark', time: 'utc' })
viewer.destroy()
```

Optionen von `createViewer(el, opts)`:

| Option | Standard | Bedeutung |
|---|---|---|
| `lang` | Browsersprache | `'de'` oder `'en'` |
| `theme` | `'auto'` | `'light'`, `'dark'`; `'auto'` = `data-theme` am `<html>`, sonst Systemeinstellung |
| `time` | `'logger'` bzw. `'local'` | `'logger'` (nur mit iparam), `'utc'`, `'local'` |
| `height`, `hkHeight` | 260, 150 | Diagrammhöhe in px (Messwerte, Gerätewerte) |
| `title` | – | Titel, falls weder iparam noch EDT einen Namen liefern |
| `injectCss` | `true` | CSS selbst laden; `false`, wenn die Host-Seite `src/ltx-view.css` und `vendor/uplot/uPlot.min.css` einbindet |

Farben lassen sich über CSS-Variablen `--lv-fg`, `--lv-muted`, `--lv-panel`, `--lv-border`, `--lv-grid`,
`--lv-accent`, `--lv-btn` … am Container überschreiben.

Nur die Parser (ohne DOM, auch in Node):

```js
import { parseEdt, parseIparam, buildSeries } from './ltx-view/src/ltx-view.js'
const series = buildSeries(parseEdt(edtText), parseIparam(iparamText))
```

## Tests

```sh
node --test test/*.test.mjs
```

## Quellen

LTX-Doku: „LTX-Logger EDT-Dateiformat“ (Stand 2026-05-08), „LTX-Parameterreferenz“.
