# ltx-view

Visualisierung von LTX-Loggerdaten: Messwerte aus `.edt`-Dateien als Zeitreihen-Diagramme, optional mit
Kanal-Infos aus `iparam.lxp`. Reines ES-Modul ohne Build-Schritt, Diagramme mit [uPlot](https://github.com/leeoniya/uPlot)
(MIT, liegt unter `vendor/uplot/`).

Verwendet in **enviLog** (Bluetooth-App) und als eigenständige Seite, z. B. auf einem Server.

## Funktionen

- Messkanäle wahlweise ein Diagramm je Einheit oder alle in einem Diagramm (Kombiniert: eine gemeinsame y-Achse ohne Trennung nach Einheiten, auch bei bis zu 90 Kanälen); y-Bereich bei jedem Diagramm in y min / y max änderbar, „auto“ trägt runde Grenzen aus den sichtbaren Werten ein, meist ab 0;
  Gerätewerte (Kanäle 90–99: Batterie, Innentemperatur …) getrennt
- Anordnung untereinander oder als Kacheln nebeneinander (je Bereich Messwerte/Gerätewerte so viele Spalten, wie mit
  Mindestbreite passen, schmal eine; Kanalliste dann unter dem Diagramm, Diagramme etwas niedriger). Zeigt ein Bereich
  nur ein Diagramm, bleibt es groß
- Leiste oben: Diagramme per Klick ein-/ausschalten, wirkt sofort (Zoom/Zeitraum bleibt); vorgewählt sind die
  Messwert-Diagramme
- Kanalliste rechts neben jedem Diagramm (schmal/Handy und Kacheln: darunter): Kanal ein/aus, ab 4 Kanälen „Alle“/„Keine“
- gemeinsame Zeitachse: Ziehen = zoomen (alle Diagramme), Doppelklick = alles, Knöpfe Alles / 30 / 7 / 1 Tag(e),
  Zeitraum frei über Von/Bis
- Werte am Cursor in einem schwebenden Feld (Layout bleibt ruhig)
- Messpunkte als kleine Punkte auf der Kurve, sobald sie beim Zoomen weit genug auseinander liegen (≥ 6 px)
- Zeitanzeige: Loggerzeit (UTC-Versatz aus iparam), UTC oder Ortszeit des Geräts
- zwischen normalen Messabständen wird verbunden (linear), bei Aussetzern nicht: der normale Abstand wird je Kanal
  aus den Daten ermittelt (Median der 8 Abstände davor bzw. danach), ein Abstand > 1,5 × normal davor **und**
  danach gilt als Aussetzer (also schon ein fehlender Wert). Wechselnde Intervalle (Parametersatz, Alarm-Intervall)
  bleiben verbunden. Fehlerwerte (`NoReply` …) sind immer Lücken; einzelne Werte zwischen Lücken als Punkt
- Markierungen: Reset (Marke oben), Alarmgrenzen aus iparam
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
| `layout` | `'unit'` | Messkanäle: `'unit'` = ein Diagramm je Einheit, `'all'` = alle kombiniert in einem Diagramm (eine gemeinsame y-Achse); im Viewer umschaltbar (ab 2 Einheiten) |
| `yMin`, `yMax` | – | y-Bereich im kombinierten Diagramm (fehlt = aus den Daten berechnet, meist ab 0); im Viewer änderbar, `viewer.yRange` liefert den aktuellen, `viewer.yRanges` die aller Diagramme (Schlüssel = Diagramm) |
| `onLayout` | – | Rückruf `(layout)` nach Umschalten durch den Benutzer, z. B. zum Merken |
| `tiles` | `false` | `true` = Diagramme als Kacheln nebeneinander; im Viewer umschaltbar (Untereinander/Kacheln), Getter `viewer.tiles` |
| `onTiles` | – | Rückruf `(tiles)` nach Umschalten durch den Benutzer |
| `height`, `hkHeight` | `'auto'` | Diagrammhöhe in px oder `'auto'` (nach Fensterhöhe: Messwerte 300–560, Gerätewerte 200–320; als Kachel 220–400 bzw. 180–280) |
| `title` | – | Titel, falls weder iparam noch EDT einen Namen liefern |
| `injectCss` | `true` | CSS selbst laden; `false`, wenn die Host-Seite `src/ltx-view.css` und `vendor/uplot/uPlot.min.css` einbindet |

Farben lassen sich über CSS-Variablen `--lv-fg`, `--lv-muted`, `--lv-panel`, `--lv-border`, `--lv-grid`,
`--lv-accent`, `--lv-btn` … am Container überschreiben, die Mindestbreite einer Kachel über `--lv-tile-min`
(Standard `30em`).

Nur die Parser (ohne DOM, auch in Node):

```js
import { parseEdt, parseIparam, buildSeries } from './ltx-view/src/ltx-view.js'
const series = buildSeries(parseEdt(edtText), parseIparam(iparamText), { gapFactor: 1.5 })
```

## Tests

```sh
node --test test/*.test.mjs
```

## Quellen

LTX-Doku: „LTX-Logger EDT-Dateiformat“ (Stand 2026-05-08), „LTX-Parameterreferenz“.
