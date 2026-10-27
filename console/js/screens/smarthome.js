// Smart home: scenes on the left, devices grouped by room, a control panel for lights and heating.
import { api } from '../api.js';
import { mountTopbar } from '../chrome.js';
import { focus, getFocused } from '../focus.js';
import { icon } from '../icons.js';
import { sfx } from '../sfx.js';
import { store } from '../store.js';
import { celebrate, closeOverlay, esc, hints, openOverlay, toast } from '../ui.js';

export const DEVICE_ICON = { light: 'bulb', switch: 'plug', fan: 'fan', media: 'tv', climate: 'thermometer', lock: 'lock' };
const SWATCHES = ['#ffd8a8', '#fff4e0', '#e0f2fe', '#8b5cf6', '#ec4899', '#22d3ee', '#4ade80', '#f97316'];

const shortName = (d) => d.name.replace(d.room, '').trim() || d.name;

function stateText(d) {
  if (d.type === 'light') return d.on ? `On · ${d.brightness}%` : 'Off';
  if (d.type === 'climate') return `${Number(d.target).toFixed(1)}°C · now ${d.current ?? '—'}°`;
  if (d.type === 'lock') return d.on ? 'Locked' : 'Unlocked';
  if (d.type === 'fan') return d.on ? `Speed ${d.speed || 1}` : 'Off';
  return d.on ? 'On' : 'Off';
}

function deviceCard(d) {
  const glow = d.type === 'light' ? d.color || '#ffd8a8' : d.type === 'climate' ? '#fb923c' : d.type === 'lock' ? '#4ade80' : '#fde68a';
  return `<button class="device ${d.on ? 'on' : ''} device-${d.type}" data-focus data-device="${esc(d.id)}" style="--c:${glow};--b:${d.type === 'light' ? (d.brightness ?? 80) / 100 : 0.7}">
    <span class="device-icon">${icon(d.type === 'lock' && !d.on ? 'unlock' : DEVICE_ICON[d.type] || 'bulb', 40)}</span>
    <span class="device-room">${esc(d.room)}</span>
    <span class="device-name">${esc(shortName(d))}</span>
    <span class="device-state">${esc(stateText(d))}</span>
    <span class="switch ${d.on ? 'on' : ''}"><i></i></span>
  </button>`;
}

export default {
  hue: [36, 12],
  async mount(el) {
    try { store.home = await api.home(); } catch { /* keep cached */ }
    el.innerHTML = `
      <div class="sh-scenes">
        <div class="row-title">${icon('zap', 26)} Scenes</div>
        <div class="scene-list" data-group="scenes"></div>
      </div>
      <div class="sh-devices" data-scroll="y" data-scroll-pad="40"></div>
      ${hints([['a', 'Control'], ['x', 'Quick toggle'], ['y', 'Assistant'], ['b', 'Back']])}`;
    const cleanup = mountTopbar(el, 'Smart Home');
    const sceneList = el.querySelector('.scene-list');
    const devicesEl = el.querySelector('.sh-devices');

    const render = () => {
      const h = store.home;
      const focusedKey = getFocused()?.dataset.device || getFocused()?.dataset.scene;
      sceneList.innerHTML = h.scenes.map((s) => `
        <button class="scene ${h.active_scene === s.id ? 'active' : ''}" data-focus data-scene="${esc(s.id)}" style="--sh:${s.hue}">
          <span class="scene-icon">${icon(s.icon, 32)}</span>
          <span class="scene-text"><b>${esc(s.name)}</b><small>${esc(s.description)}</small></span>
          ${h.active_scene === s.id ? `<span class="scene-check">${icon('check', 22, 2.4)}</span>` : ''}
        </button>`).join('');
      const byRoom = [...h.devices].sort((a, b) => a.room.localeCompare(b.room));
      devicesEl.innerHTML = `
        <div class="row-title">${icon('bulb', 26)} Devices <small>${h.devices.filter((d) => d.on && d.type !== 'lock').length} on</small></div>
        <div class="device-grid" data-group="devices">${byRoom.map(deviceCard).join('')}</div>
        <div class="sh-mode">${h.mode === 'demo' ? `${icon('home', 20)} Demo house · connect Home Assistant in hub/.env` : `${icon('wifi', 20)} Home Assistant`}</div>`;
      const again = focusedKey && el.querySelector(`[data-device="${CSS.escape(focusedKey)}"], [data-scene="${CSS.escape(focusedKey)}"]`);
      if (again) focus(again, { silent: true, scroll: false });
    };

    const apply = (res, label) => {
      store.home = res.home;
      render();
      celebrate(res.event, res.event.xp ? label : '');
    };

    const toggle = async (dev) => {
      try {
        const res = await api.setDevice(store.profile.id, dev.id, { on: !dev.on });
        sfx.toggle(!dev.on);
        apply(res, `${shortName(dev)} ${res.device.on ? 'on' : 'off'}`);
      } catch (err) {
        toast({ icon: 'x', title: 'Device not responding', text: err.message, tone: 'error' });
      }
    };

    el.addEventListener('click', async (e) => {
      const sceneBtn = e.target.closest('[data-scene]');
      if (sceneBtn) {
        const res = await api.scene(store.profile.id, sceneBtn.dataset.scene);
        apply(res, `Scene: ${res.scene.name}`);
        return;
      }
      const devBtn = e.target.closest('[data-device]');
      if (!devBtn) return;
      const dev = store.home.devices.find((d) => d.id === devBtn.dataset.device);
      if (dev.type === 'light' || dev.type === 'climate') openControl(dev, apply);
      else toggle(dev);
    });

    render();
    return {
      onButton(action) {
        const id = getFocused()?.dataset.device;
        if (action === 'x' && id) {
          toggle(store.home.devices.find((d) => d.id === id));
          return true;
        }
        return false;
      },
      unmount: cleanup,
    };
  },
};

function openControl(device, apply) {
  let dev = { ...device };
  let timer = null;
  let pending = null;
  const send = async () => {
    if (!pending) return;
    const { change, label } = pending;
    pending = null;
    try {
      const res = await api.setDevice(store.profile.id, dev.id, change);
      apply(res, label);
    } catch (err) {
      toast({ icon: 'x', title: 'Device not responding', text: err.message, tone: 'error' });
    }
  };
  // Batch rapid changes (holding the D-pad on the slider) into one request.
  const push = (change, label) => {
    pending = { change: { ...pending?.change, ...change }, label };
    clearTimeout(timer);
    timer = setTimeout(send, 350);
  };

  openOverlay({
    className: 'center-panel',
    render(body, layer) {
      const paint = () => {
        const light = dev.type === 'light';
        body.innerHTML = `
          <div class="panel device-panel">
            <div class="dp-preview ${dev.on ? 'on' : ''}" style="--c:${light ? dev.color : '#fb923c'};--b:${light ? dev.brightness / 100 : 0.8}">
              <div class="dp-glow"></div>${icon(DEVICE_ICON[dev.type], 110, 1.4)}
              ${light ? '' : `<div class="dp-temp num">${Number(dev.target).toFixed(1)}°</div>`}
            </div>
            <div class="dp-controls">
              <div><div class="kicker">${esc(dev.room)}</div><h2 class="title-lg">${esc(dev.name)}</h2></div>
              <button class="btn ${dev.on ? 'primary' : ''}" data-focus data-autofocus data-act="power">${icon('power', 24)} ${dev.on ? 'Turn off' : 'Turn on'}</button>
              ${light ? `
                <button class="slider" data-focus data-slider>
                  <span>${icon('sun', 22)} Brightness <small class="dim">◀ ▶</small></span>
                  <span class="slider-track"><i style="width:${dev.brightness}%"></i></span>
                  <b class="num">${dev.brightness}%</b>
                </button>
                <div class="swatches" data-group="swatches">${SWATCHES.map((c) => `<button class="swatch ${c === dev.color ? 'sel' : ''}" data-focus data-color="${c}" style="--sw:${c}"></button>`).join('')}</div>`
              : `<div class="btn-row" data-group="temp">
                  <button class="icon-btn big" data-focus data-temp="-0.5">${icon('minus', 36)}</button>
                  <button class="icon-btn big" data-focus data-temp="0.5">${icon('plus', 36)}</button>
                  <span class="muted">Now ${dev.current ?? '—'}°C</span></div>`}
              ${hints([['a', 'Select'], ['b', 'Close']])}
            </div>
          </div>`;
      };
      paint();
      const refocus = (sel) => focus(body.querySelector(sel), { silent: true });
      body.addEventListener('click', (e) => {
        const t = e.target.closest('[data-act], [data-color], [data-temp]');
        if (!t) return;
        if (t.dataset.act === 'power') {
          dev.on = !dev.on;
          sfx.toggle(dev.on);
          push({ on: dev.on }, `${dev.name} ${dev.on ? 'on' : 'off'}`);
          paint();
          refocus('[data-act="power"]');
        } else if (t.dataset.color) {
          dev = { ...dev, color: t.dataset.color, on: true };
          push({ color: dev.color, on: true }, `${dev.name} color`);
          paint();
          refocus(`[data-color="${t.dataset.color}"]`);
        } else if (t.dataset.temp) {
          dev.target = Math.round((Number(dev.target) + Number(t.dataset.temp)) * 10) / 10;
          push({ target: dev.target }, `Heating to ${dev.target}°C`);
          paint();
          refocus(`[data-temp="${t.dataset.temp}"]`);
        }
      });
      layer.onButton = (action) => {
        const slider = getFocused()?.hasAttribute('data-slider');
        if (slider && (action === 'left' || action === 'right')) {
          dev.brightness = Math.max(5, Math.min(100, dev.brightness + (action === 'right' ? 10 : -10)));
          dev.on = true;
          sfx.move();
          push({ brightness: dev.brightness, on: true }, `${dev.name} at ${dev.brightness}%`);
          paint();
          refocus('[data-slider]');
          return true;
        }
        return false;
      };
      layer.onClose = () => {
        clearTimeout(timer);
        send();
      };
    },
  });
}
