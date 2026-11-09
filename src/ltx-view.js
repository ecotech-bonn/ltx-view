/* ltx-view - Visualisierung von LTX-Loggerdaten (EDT, optional iparam) mit uPlot.
 *
 * Einbinden (ES-Modul, keine Build-Schritte; CSS wird automatisch geladen):
 *
 *   import { createViewer } from './ltx-view/src/ltx-view.js'
 *   const viewer = createViewer(document.getElementById('chart'), { lang: 'de' })
 *   viewer.setData({ edt: edtText, iparam: iparamText })        // Texte
 *   await viewer.loadUrls({ edt: '/data/x.edt', iparam: '/data/x_iparam.lxp' })
 *   await viewer.loadFiles(input.files)                          // Dateiauswahl / Drag & Drop
 *
 * Nur die Parser (ohne DOM, auch in Node nutzbar): parseEdt, parseIparam, buildSeries.
 */

export const VERSION = '0.1.0'
export { parseEdt, parseValue, MIN_VALID_TIME } from './edt.js'
export { parseIparam } from './iparam.js'
export { buildSeries } from './series.js'
export { createViewer, detectKind } from './view.js'
