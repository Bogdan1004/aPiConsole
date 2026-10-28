// Small SVG charts for aPi Wrapped and the Monitor (no library). They follow the data-viz rules: thin marks with
// 4px rounded data ends, hairline recessive grid, one hue per single series, a fixed categorical order validated
// for colour-blind safety on the chart surface (#14162a), text in text colours (never the series colour), and a
// hover tooltip on every mark. The palette lives in CSS (--series-1…, --seq-1…) so it is changed in one place.
import { esc } from './ui.js';

export const SERIES = ['var(--series-1)', 'var(--series-2)'];
const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

/** Round a maximum up to a clean axis value (1, 2, 2.5, 5 × 10^n). */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

export const compact = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);

/** A column whose top corners are rounded (4px) and whose base stays square on the baseline. */
function column(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Vertical columns, one series. data: [{label, value, tip}] */
export function columnChart(data, { width = 760, height = 220, unit = '' } = {}) {
  const left = 44;
  const bottom = 26;
  const top = 10;
  const plotW = width - left - 8;
  const plotH = height - top - bottom;
  const max = niceMax(Math.max(...data.map((d) => d.value), 0));
  const band = plotW / Math.max(data.length, 1);
  const w = Math.min(24, band * 0.62);
  const ticks = [0, max / 2, max];
  const every = Math.ceil(data.length / 10);
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" role="img" aria-label="Column chart">
    ${ticks.map((t) => {
      const y = top + plotH - (t / max) * plotH;
      return `<line class="viz-grid ${t === 0 ? 'base' : ''}" x1="${left}" x2="${width - 8}" y1="${y}" y2="${y}"/>
        <text class="viz-tick" x="${left - 8}" y="${y + 5}" text-anchor="end">${compact(t)}</text>`;
    }).join('')}
    ${data.map((d, i) => {
      const h = (d.value / max) * plotH;
      const x = left + i * band + (band - w) / 2;
      return `<g class="viz-hit" data-tip="${esc(d.tip || `${d.label}: ${d.value}${unit}`)}">
        <rect x="${left + i * band}" y="${top}" width="${band}" height="${plotH}" fill="transparent"/>
        <path d="${column(x, top + plotH - h, w, h)}" fill="var(--series-1)"/>
        ${i % every === 0 || i === data.length - 1 ? `<text class="viz-tick" x="${x + w / 2}" y="${height - 6}" text-anchor="middle">${esc(d.label)}</text>` : ''}
      </g>`;
    }).join('')}
  </svg>`;
}

/** Weekday × hour grid, one sequential hue (darker = fewer, brighter = more). rows: 7 arrays of 24 counts. */
export function heatmap(rows, { width = 760, rowLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] } = {}) {
  const left = 44;
  const cell = (width - left) / 24;
  const size = cell - 2; // 2px surface gap between cells
  const max = Math.max(1, ...rows.flat());
  const step = (v) => SEQ[Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length - 1e-9))];
  const height = rows.length * cell + 24;
  return `<svg class="viz" viewBox="0 0 ${width} ${height}" role="img" aria-label="Activity by weekday and hour">
    ${rows.map((row, r) => `<text class="viz-tick" x="${left - 8}" y="${r * cell + size / 2 + 5}" text-anchor="end">${rowLabels[r]}</text>
      ${row.map((v, h) => `<rect class="viz-hit" x="${left + h * cell}" y="${r * cell}" width="${size}" height="${size}" rx="3"
        fill="${v ? step(v) : 'var(--viz-empty)'}" data-tip="${rowLabels[r]} ${String(h).padStart(2, '0')}:00 · ${v} action${v === 1 ? '' : 's'}"/>`).join('')}`).join('')}
    ${[0, 6, 12, 18, 23].map((h) => `<text class="viz-tick" x="${left + h * cell + size / 2}" y="${height - 4}" text-anchor="middle">${h}:00</text>`).join('')}
  </svg>`;
}

/** The sequential legend for the heatmap. */
export function rampLegend(low = 'Fewer', high = 'More') {
  return `<div class="viz-legend"><span>${esc(low)}</span>${SEQ.map((c) => `<i style="background:${c}"></i>`).join('')}<span>${esc(high)}</span></div>`;
}

/** Horizontal bars, one series, value at the tip. rows: [{label, value, tip?, thumb?}] */
export function barList(rows, { unit = '' } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="viz-bars">${rows.map((r) => `
    <div class="viz-bar-row viz-hit" data-tip="${esc(r.tip || `${r.label}: ${r.value}${unit}`)}">
      ${r.thumb ? `<img class="viz-thumb" src="${esc(r.thumb)}" alt="" loading="lazy">` : ''}
      <span class="viz-bar-label">${esc(r.label)}</span>
      <span class="viz-bar-track"><i style="width:${Math.max(2, (r.value / max) * 100)}%"></i></span>
      <b class="viz-bar-value num">${compact(r.value)}${esc(unit)}</b>
    </div>`).join('')}</div>`;
}

/** Two players side by side per metric (each metric on its own scale). players: [{name}], metrics: [{label, values[], unit}] */
export function versus(players, metrics) {
  const legend = players.length > 1
    ? `<div class="viz-key">${players.map((p, i) => `<span><i style="background:${SERIES[i]}"></i>${esc(p.name)}</span>`).join('')}</div>` : '';
  return `${legend}<div class="viz-versus">${metrics.map((m) => {
    const max = Math.max(1, ...m.values);
    return `<div class="viz-vs-metric"><div class="viz-vs-label">${esc(m.label)}</div>${m.values.map((v, i) => `
      <div class="viz-vs-row viz-hit" data-tip="${esc(`${players[i].name} · ${m.label}: ${v}${m.unit || ''}`)}">
        <span class="viz-vs-track"><i style="width:${Math.max(1.5, (v / max) * 100)}%;background:${SERIES[i]}"></i></span>
        <b class="num">${compact(v)}${esc(m.unit || '')}</b>
      </div>`).join('')}</div>`;
  }).join('')}</div>`;
}

/**
 * Line over time: 2px stroke, a 10% area wash, end dot with a surface ring. points: [{t, v}].
 * `second`: an optional second series on the same axis (same unit), drawn in series 2 without a wash; `names`
 * labels the two series in the tooltip.
 * `ref`: an optional reference line ({ value, label }), e.g. a temperature threshold.
 */
export function lineChart(points, { width = 760, height = 200, unit = '', max: fixedMax = null, label = (t) => t, second = null, names = null, ref = null } = {}) {
  const left = 44;
  const bottom = 24;
  const top = 10;
  const plotW = width - left - 12;
  const plotH = height - top - bottom;
  if (points.length < 2) return `<div class="viz-empty">Collecting data… the chart fills in over the next minutes.</div>`;
  const max = fixedMax ?? niceMax(Math.max(...points.map((p) => p.v), ...(second || []).map((p) => p.v), ref?.value || 0));
  const x = (i) => left + (i / (points.length - 1)) * plotW;
  const y = (v) => top + plotH - (Math.min(v, max) / max) * plotH;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = points[points.length - 1];
  const step = Math.max(1, Math.floor(points.length / 6));
  const path2 = second?.length === points.length ? second.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('') : null;
  const tips = points.map((p, i) => [label(p.t), p.v, path2 ? second[i].v : null]);
  return `<svg class="viz viz-line" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart" data-points='${esc(JSON.stringify(tips))}' data-unit="${esc(unit)}" data-names="${esc((names || []).join('|'))}" data-left="${left}" data-plotw="${plotW}">
    ${[0, max / 2, max].map((t) => `<line class="viz-grid ${t === 0 ? 'base' : ''}" x1="${left}" x2="${width - 12}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="viz-tick" x="${left - 8}" y="${y(t) + 5}" text-anchor="end">${compact(t)}</text>`).join('')}
    <path d="${path}L${x(points.length - 1)},${top + plotH}L${left},${top + plotH}Z" fill="var(--series-1)" opacity=".1"/>
    <path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${ref ? `<line class="viz-ref" x1="${left}" x2="${width - 12}" y1="${y(ref.value)}" y2="${y(ref.value)}"/>
      <text class="viz-tick" x="${width - 14}" y="${y(ref.value) - 6}" text-anchor="end">${esc(ref.label)}</text>` : ''}
    ${path2 ? `<path d="${path2}" fill="none" stroke="var(--series-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(points.length - 1)}" cy="${y(second[second.length - 1].v)}" r="5" fill="var(--series-2)" stroke="var(--viz-surface)" stroke-width="2"/>` : ''}
    <circle cx="${x(points.length - 1)}" cy="${y(last.v)}" r="5" fill="var(--series-1)" stroke="var(--viz-surface)" stroke-width="2"/>
    ${points.map((p, i) => (i % step === 0 ? `<text class="viz-tick" x="${x(i)}" y="${height - 4}" text-anchor="middle">${esc(label(p.t))}</text>` : '')).join('')}
    <line class="viz-cross" x1="0" x2="0" y1="${top}" y2="${top + plotH}" visibility="hidden"/>
  </svg>`;
}

/** One shared tooltip for every chart inside `root`: marks carry data-tip; line charts use a crosshair. */
export function attachTooltips(root) {
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  root.append(tip);
  const show = (text, e) => {
    tip.textContent = text;
    const box = root.getBoundingClientRect();
    const scale = box.width / root.offsetWidth || 1;
    tip.style.left = `${(e.clientX - box.left) / scale + 14}px`;
    tip.style.top = `${(e.clientY - box.top) / scale - 10}px`;
    tip.classList.add('on');
  };
  root.addEventListener('pointermove', (e) => {
    const mark = e.target.closest('.viz-hit');
    if (mark) return show(mark.dataset.tip, e);
    const line = e.target.closest('.viz-line');
    if (line) {
      const pts = JSON.parse(line.dataset.points);
      const r = line.getBoundingClientRect();
      const vbX = ((e.clientX - r.left) / r.width) * line.viewBox.baseVal.width;
      const i = Math.round(((vbX - Number(line.dataset.left)) / Number(line.dataset.plotw)) * (pts.length - 1));
      const p = pts[Math.max(0, Math.min(pts.length - 1, i))];
      const cross = line.querySelector('.viz-cross');
      const cx = Number(line.dataset.left) + (Math.max(0, Math.min(pts.length - 1, i)) / (pts.length - 1)) * Number(line.dataset.plotw);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      const names = (line.dataset.names || '').split('|');
      return show(p[2] === null ? `${p[0]} · ${p[1]}${line.dataset.unit}`
        : `${p[0]} · ${names[0] || 'A'} ${p[1]}${line.dataset.unit} · ${names[1] || 'B'} ${p[2]}${line.dataset.unit}`, e);
    }
    tip.classList.remove('on');
    return null;
  });
  root.addEventListener('pointerleave', () => {
    tip.classList.remove('on');
    root.querySelectorAll('.viz-cross').forEach((c) => c.setAttribute('visibility', 'hidden'));
  });
}
