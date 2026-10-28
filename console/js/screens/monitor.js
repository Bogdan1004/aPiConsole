// Monitor: the Pi's health over the last hour, day or week (CPU, temperature, memory, network), who is online,
// signed-in devices, and the security log (sign-ins, wrong PINs, blocked guests, alerts). Players only.
import { api } from '../api.js';
import { mountTopbar } from '../chrome.js';
import { attachTooltips, lineChart, SERIES } from '../charts.js';
import { focus } from '../focus.js';
import { icon } from '../icons.js';
import { store } from '../store.js';
import { esc, fmtBytes, fmtUptime, hints, toast } from '../ui.js';

const RANGES = [['1h', 'Last hour'], ['24h', '24 hours'], ['7d', '7 days']];
// Security log events: icon, label, and a status for the few that need attention (shown with icon + label).
const EVENTS = {
  login: ['user', 'Signed in'], logout: ['power', 'Signed out'], login_failed: ['x', 'Wrong PIN', 'serious'],
  pin_locked: ['lock', 'Locked after wrong PINs', 'critical'], pin_created: ['lock', 'PIN created'], pin_changed: ['lock', 'PIN changed'],
  guest_blocked: ['lock', 'Guest action blocked'], rate_limited: ['clock', 'Too many requests', 'warning'],
  phone_paired: ['gamepad', 'Phone paired'], upload: ['download', 'File uploaded'], delete: ['trash', 'Moved to trash'],
  store_install: ['bag', 'Game installed'], store_uninstall: ['bag', 'Game removed'], signed_out_others: ['power', 'Other devices signed out'],
  alert: ['thermometer', 'Alert', 'critical'],
};
let range = '1h';

const rate = (bps) => (bps >= 1024 * 1024 ? `${(bps / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`);

function timeLabel(ts) {
  const d = new Date(ts * 1000);
  return range === '7d' ? `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getHours()}:00`
    : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default {
  hue: [205, 245],
  async mount(el) {
    el.innerHTML = `
      <div class="stats-page monitor-page" data-scroll="y-start" data-scroll-pad="40">
        <div class="stats-filters chips" data-group="ranges">${RANGES.map(([id, label]) => `<button class="chip-btn ${id === range ? 'active' : ''}" data-focus data-range="${id}">${esc(label)}</button>`).join('')}
          <span class="dim monitor-note">Sampled every 15 seconds · kept 7 days</span></div>
        <div class="stats-body"><div class="empty"><div class="spinner"></div></div></div>
      </div>
      ${hints([['a', 'Select'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Monitor');
    const page = el.querySelector('.monitor-page');
    const bodyEl = el.querySelector('.stats-body');
    attachTooltips(page);

    const paint = (d) => {
      const n = d.now;
      const pts = (key, scale = 1) => d.series.map((r) => ({ t: r.t, v: Math.round((r[key] ?? 0) * scale * 10) / 10 }));
      const temp = n.temp ?? 0;
      const hot = temp >= 75;
      const tile = (ic, label, value, extra = '') => `<div class="stat-tile"><span class="stat-label">${icon(ic, 20)} ${esc(label)}</span><b class="stat-value">${value}</b>${extra}</div>`;
      bodyEl.innerHTML = `
        <div class="stat-row">
          ${tile('cpu', 'CPU now', `${Math.round(n.cpu ?? 0)}%`, `<span class="stat-sub dim">load ${(n.load?.[0] ?? 0).toFixed(2)} · ${n.cpu_count} cores</span>`)}
          ${tile('thermometer', 'Temperature', `${temp.toFixed(1)}°C`, hot ? `<span class="status status-critical">${icon('thermometer', 16)} Hot</span>` : '<span class="stat-sub dim">fine below 75°C</span>')}
          ${tile('layers', 'Memory', `${Math.round(n.mem ?? 0)}%`, `<span class="stat-sub dim">of ${fmtBytes(n.mem_total)}</span>`)}
          ${tile('drive', 'Free space', fmtBytes(n.disk_free), `<span class="stat-sub dim">of ${fmtBytes(n.storage_total)}</span>`)}
          ${tile('wifi', 'Network', `${rate(n.rx ?? 0)}`, `<span class="stat-sub dim">down · ${rate(n.tx ?? 0)} up</span>`)}
          ${tile('clock', 'Uptime', fmtUptime(n.uptime || 0), `<span class="stat-sub dim">${esc((n.model || '').replace('Raspberry Pi', 'Pi'))}</span>`)}
        </div>
        <div class="stats-grid">
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('cpu', 20)} CPU usage</div>
            ${lineChart(pts('cpu'), { width: 820, height: 210, unit: '%', max: 100, label: timeLabel })}</div>
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('thermometer', 20)} Temperature</div>
            ${lineChart(pts('temp'), { width: 820, height: 210, unit: '°C', max: 90, label: timeLabel, ref: { value: 75, label: '75°C alert' } })}</div>
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('layers', 20)} Memory in use</div>
            ${lineChart(pts('mem'), { width: 820, height: 210, unit: '%', max: 100, label: timeLabel })}</div>
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('wifi', 20)} Network (KB/s)
            <span class="viz-key"><span><i style="background:${SERIES[0]}"></i>Download</span><span><i style="background:${SERIES[1]}"></i>Upload</span></span></div>
            ${lineChart(pts('rx', 1 / 1024), { width: 820, height: 210, unit: ' KB/s', label: timeLabel, second: pts('tx', 1 / 1024), names: ['down', 'up'] })}</div>
        </div>
        <div class="stats-grid">
          <div class="panel viz-panel" data-focus><div class="viz-title">${icon('zap', 20)} Requests per minute</div>
            ${lineChart(pts('req_per_min'), { width: 820, height: 180, unit: '/min', label: timeLabel })}
            <div class="viz-sub">${d.series.reduce((a, r) => a + r.err_per_min, 0) ? `${icon('x', 14)} Some server errors in this range` : 'No server errors in this range'}</div></div>
          <div class="panel viz-panel monitor-people" data-focus>
            <div class="viz-title">${icon('users', 20)} Online now</div>
            ${d.online.length ? d.online.map((o) => `<div class="mon-row"><span class="dot"></span><b>${esc(o.name)}</b><span class="dim">${o.devices} device${o.devices > 1 ? 's' : ''}${o.activity ? ` · ${esc(o.activity)}` : ''}</span></div>`).join('') : '<div class="viz-empty">Nobody signed in right now</div>'}
            ${d.guests_online ? `<div class="mon-row"><span class="dot"></span><b>Guests</b><span class="dim">${d.guests_online} visitor${d.guests_online > 1 ? 's' : ''} (read-only)</span></div>` : ''}
            ${d.phones ? `<div class="mon-row">${icon('gamepad', 18)}<b>${d.phones} phone${d.phones > 1 ? 's' : ''}</b><span class="dim">as controllers</span></div>` : ''}
            <div class="viz-title small">${icon('lock', 18)} Signed-in devices</div>
            ${d.sessions.map((s) => `<div class="mon-row"><b>${esc(s.name)}</b><span class="dim">${s.count} session${s.count > 1 ? 's' : ''}</span></div>`).join('')}
            <button class="btn small" data-focus data-act="others">${icon('power', 18)} Sign out my other devices</button>
          </div>
        </div>
        <div class="panel viz-panel" data-focus>
          <div class="viz-title">${icon('lock', 20)} Security log <small class="dim">last 40 events · kept 30 days</small></div>
          <div class="audit">${d.events.map((e) => {
            const [ic, label, status] = EVENTS[e.kind] || ['file', e.kind];
            return `<div class="audit-row ${status ? `status-${status}` : ''}"><span class="num dim">${esc(e.ts.slice(5, 16))}</span>
              <span class="audit-kind">${icon(ic, 16)} ${esc(label)}</span><span>${esc(store.profiles.find((p) => p.id === e.profile_id)?.name || e.profile_id || '')}</span>
              <span class="dim num">${esc(e.address || '')}</span><span class="dim audit-detail">${esc(e.detail || '')}</span></div>`;
          }).join('') || '<div class="viz-empty">Nothing yet</div>'}</div>
        </div>`;
    };

    let timer = null;
    const load = async (first = false) => {
      try {
        const data = await api.monitor(range);
        // A refresh keeps the focused panel focused.
        const panels = [...bodyEl.querySelectorAll('[data-focus]')];
        const at = panels.indexOf(document.querySelector('.monitor-page .focused'));
        paint(data);
        if (at >= 0) focus(bodyEl.querySelectorAll('[data-focus]')[at], { silent: true, scroll: false });
      } catch (err) {
        bodyEl.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
      if (first) focus(el.querySelector('.chip-btn.active'), { silent: true });
    };

    el.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-range]')?.dataset.range;
      if (r && r !== range) {
        range = r;
        el.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b.dataset.range === range));
        load();
      }
      if (e.target.closest('[data-act="others"]')) {
        const res = await api.signOutOthers().catch((err) => toast({ icon: 'x', title: err.message, tone: 'error' }));
        if (res) toast({ icon: 'power', title: `Signed out ${res.signed_out} other device${res.signed_out === 1 ? '' : 's'}`, tone: 'info' });
        load();
      }
    });

    await load(true);
    timer = setInterval(() => { if (!document.querySelector('.overlay.open')) load(); }, 15000);
    return { unmount: () => { cleanup(); clearInterval(timer); } };
  },
};
