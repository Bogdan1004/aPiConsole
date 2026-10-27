// Cloud Drive: the NAS. Pi health and storage on the left; on the right a file browser for Shared and your own
// folder with upload (button or drag and drop, from any browser), previews, downloads, share links, rename, move
// and a trash. Remote access goes through Tailscale, shown when it's installed.
import { api } from '../api.js';
import { mountTopbar } from '../chrome.js';
import { focus, focusFirst, getFocused } from '../focus.js';
import { icon } from '../icons.js';
import { lastSource } from '../input.js';
import { store } from '../store.js';
import { celebrate, closeOverlay, esc, fmtBytes, fmtUptime, hints, keyboardPrompt, openOverlay, toast } from '../ui.js';

const KIND_ICON = { folder: 'folder', image: 'image', video: 'film', audio: 'music', text: 'file', pdf: 'file', other: 'file' };
const kiosk = () => new URLSearchParams(location.search).has('kiosk');
const fileUrl = (path, download = false) =>
  `/api/drive/file?profile_id=${store.profile.id}&path=${encodeURIComponent(path)}${download ? '&download=true' : ''}`;

function serviceRows() {
  const h = store.health || { services: {}, ai: {} };
  const s = h.services || {};
  const row = (ic, name, state, tone) => `<div class="svc"><span class="svc-icon">${icon(ic, 22)}</span><span class="svc-name">${name}</span><span class="tag ${tone}">${state}</span></div>`;
  const media = (v, real) => (v === real ? ['Connected', 'ok'] : v?.endsWith('error') ? ['Unreachable', 'warn'] : ['Demo data', '']);
  return [
    row('film', 'Jellyfin', ...media(s.movies, 'jellyfin')),
    row('music', 'Navidrome', ...media(s.music, 'navidrome')),
    row('home', 'Home Assistant', ...media(s.home, 'homeassistant')),
    row('sparkles', 'Claude (picks)', ...(h.ai?.enabled ? [h.ai.model, 'ok'] : ['Offline oracle', ''])),
    row('sparkles', 'Assistant (free, local)', ...(h.assistant?.enabled ? [h.assistant.model, 'ok'] : ['Not running', 'warn'])),
  ].join('');
}

function gauge(ic, label, value, pct, tone = '') {
  return `<div class="gauge ${tone}"><div class="gauge-top">${icon(ic, 24)}<span>${label}</span></div><div class="gauge-value num">${value}</div><div class="bar"><i style="width:${Math.min(100, Math.max(2, pct * 100))}%"></i></div></div>`;
}

/** Text from the person: on-screen keyboard with a controller, a normal text field otherwise. */
function askText({ title, value = '', placeholder = '' }) {
  if (lastSource === 'gamepad') return keyboardPrompt({ title, value, placeholder });
  return new Promise((resolve) => {
    let done = false;
    const finish = (result, layer) => {
      if (done) return;
      done = true;
      resolve(result);
      closeOverlay(layer, { silent: true });
    };
    openOverlay({
      className: 'center-panel',
      render(body, layer) {
        body.innerHTML = `<div class="panel confirm-panel">
          <div class="kicker">${esc(title)}</div>
          <input class="field" data-focus value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="200">
          <div class="btn-row"><button class="btn" data-focus data-act="cancel">Cancel</button>
          <button class="btn primary" data-focus data-act="ok">${icon('check', 22)} OK</button></div></div>`;
        const input = body.querySelector('input');
        setTimeout(() => { input.focus(); input.select(); }, 60);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null, layer); });
        body.addEventListener('click', (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (act) finish(act === 'ok' ? input.value.trim() || null : null, layer);
        });
      },
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
  });
}

function confirmDelete(entry) {
  return new Promise((resolve) => {
    let done = false;
    openOverlay({
      className: 'center-panel',
      render(body, layer) {
        body.innerHTML = `<div class="panel confirm-panel">
          <div class="kicker">Move to trash</div><h2 class="title-lg">${esc(entry.name)}</h2>
          <p class="muted">It stays in the trash for 30 days, then it's gone for good.</p>
          <div class="btn-row"><button class="btn" data-focus data-autofocus data-act="keep">${icon('back', 22)} Keep it</button>
          <button class="btn danger" data-focus data-act="delete">${icon('trash', 22)} Move to trash</button></div></div>`;
        body.addEventListener('click', (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (!act) return;
          done = true;
          resolve(act === 'delete');
          closeOverlay(layer, { silent: true });
        });
      },
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/** Full-screen preview; left/right walks through the folder's files. */
function openPreview(files, index) {
  let i = index;
  let step = () => {};
  openOverlay({
    className: 'full-panel preview-overlay',
    render(body) {
      const paint = async () => {
        const f = files[i];
        const url = fileUrl(f.path);
        let view = '';
        if (f.kind === 'image') view = `<img class="pv-media" src="${url}" alt="">`;
        else if (f.kind === 'video') view = `<video class="pv-media" src="${url}" controls autoplay></video>`;
        else if (f.kind === 'audio') view = `<div class="pv-audio">${icon('music', 120, 1.2)}<audio src="${url}" controls autoplay></audio></div>`;
        else if (f.kind === 'pdf') view = `<iframe class="pv-media pv-doc" src="${url}"></iframe>`;
        else if (f.kind === 'text') view = '<pre class="pv-text">Loading…</pre>';
        else view = `<div class="pv-audio">${icon('file', 120, 1.2)}<p class="muted">No preview for .${esc(f.ext || 'file')} files</p></div>`;
        body.innerHTML = `<div class="pv">
          <div class="pv-head"><span class="pv-title">${esc(f.name)}</span>
            <span class="muted num">${fmtBytes(f.size)} · ${esc(f.modified.replace('T', ' '))} · ${i + 1}/${files.length}</span>
            ${kiosk() ? '' : `<a class="btn small" data-focus href="${fileUrl(f.path, true)}" download>${icon('download', 18)} Download</a>`}</div>
          <div class="pv-stage">${view}</div>
          ${hints([['←', 'Previous'], ['→', 'Next'], ['b', 'Close']])}</div>`;
        if (f.kind === 'text') {
          const res = await fetch(url, { headers: { Range: 'bytes=0-200000' } });
          body.querySelector('.pv-text').textContent = await res.text();
        }
      };
      paint();
      step = (d) => { i = (i + d + files.length) % files.length; paint(); };
    },
    onButton(action) {
      if (action === 'left' || action === 'right') {
        step(action === 'left' ? -1 : 1);
        return true;
      }
      return false;
    },
  });
}

export default {
  hue: [205, 245],
  async mount(el, params = {}) {
    const pid = store.profile.id;
    el.innerHTML = `
      <div class="drive-side">
        <div class="panel drive-storage"></div>
        <div class="gauges"></div>
        <div class="panel drive-remote"></div>
        <div class="panel services"><div class="row-title">${icon('layers', 24)} Services</div>${serviceRows()}</div>
      </div>
      <div class="panel drive-files">
        <div class="files-head"></div>
        <div class="files-tools" data-group="tools"></div>
        <div class="file-list" data-group="files" data-scroll="y" data-scroll-pad="20"></div>
        <div class="drop-hint">${icon('download', 64, 1.4)}<b>Drop files to upload</b></div>
      </div>
      <input type="file" class="upload-input" multiple hidden>
      ${hints([['a', 'Open'], ['x', 'File options'], ['b', 'Up / Back']])}`;
    const cleanup = mountTopbar(el, 'Cloud Drive');
    const storageEl = el.querySelector('.drive-storage');
    const gaugesEl = el.querySelector('.gauges');
    const remoteEl = el.querySelector('.drive-remote');
    const head = el.querySelector('.files-head');
    const tools = el.querySelector('.files-tools');
    const list = el.querySelector('.file-list');
    const picker = el.querySelector('.upload-input');
    const filesPanel = el.querySelector('.drive-files');
    let path = '';
    let entries = [];
    let areas = [];

    const paintStats = async () => {
      let s;
      try { s = await api.system(); } catch { return; }
      const pct = s.storage.used / s.storage.total;
      storageEl.innerHTML = `
        <div class="donut small" style="--p:${pct}"><div><b class="num">${Math.round(pct * 100)}%</b><span>used</span></div></div>
        <div class="storage-text">
          <div class="kicker">aPiCloud storage</div>
          <div class="title-lg num">${fmtBytes(s.storage.free)} <span class="muted">free</span></div>
          <p class="muted">${fmtBytes(s.storage.used)} of ${fmtBytes(s.storage.total)}</p>
          ${store.guest ? '' : `<p class="dim">${esc(s.model)} · ${esc(s.hostname)} · ${esc(s.ip || 'offline')}</p>`}
        </div>`;
      const temp = s.cpu_temp ?? 0;
      gaugesEl.innerHTML = [
        gauge('thermometer', 'CPU temp', `${temp}°C`, temp / 85, temp > 70 ? 'bad' : temp > 58 ? 'warn' : 'ok'),
        gauge('cpu', 'CPU load', s.cpu_percent == null ? `${s.load[0].toFixed(2)}` : `${Math.round(s.cpu_percent)}%`, s.cpu_percent == null ? s.load[0] / s.cpu_count : s.cpu_percent / 100),
        gauge('layers', 'Memory', fmtBytes(s.mem_used), s.mem_used / s.mem_total),
        gauge('clock', 'Uptime', fmtUptime(s.uptime), 1),
      ].join('');
    };

    const paintRemote = (remote) => {
      const host = `${store.health?.hostname || 'apiconsole'}.local:${location.port || 8420}`;
      const publicLink = remote?.public ? `<p class="muted">Public demo link, Guest only: <b class="num">${esc(remote.public)}</b></p>` : '';
      remoteEl.innerHTML = (remote?.connected
        ? `<div class="row-title">${icon('wifi', 24)} Access from anywhere <span class="tag ok">Tailscale on</span></div>
           <p class="muted">On your phone or laptop with Tailscale: <b class="num">http://${esc(remote.name || remote.ips?.[0] || '')}:${location.port || 8420}</b></p>`
        : `<div class="row-title">${icon('wifi', 24)} Access from anywhere <span class="tag">${remote?.public ? 'Demo link on' : remote?.tailscale ? 'Tailscale off' : 'Home network only'}</span></div>
           <p class="muted">At home: <b class="num">http://${esc(host)}</b>. Outside, install Tailscale (free, private) on the Pi and your devices; see README.</p>`) + publicLink;
    };

    const crumbsHtml = () => {
      const parts = path ? path.split('/') : [];
      return `${icon('cloud', 26)}<span><button class="path-crumb" data-crumb="">aPiCloud</button>${parts.map((p, i) => `<i> / </i><button class="path-crumb" data-crumb="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('')}</span>
        <small class="dim">${entries.length} item${entries.length === 1 ? '' : 's'}</small>`;
    };

    const row = (e) => `
      <button class="file" data-focus data-path="${esc(e.path)}">
        <span class="file-icon ${e.kind}">${e.kind === 'image' ? `<img src="${fileUrl(e.path)}" alt="" loading="lazy">` : icon(KIND_ICON[e.kind] || 'file', 24)}</span>
        <span class="file-name">${esc(e.name)}${path === '' ? `<small class="dim"> · ${{ Shared: 'everyone', Guest: 'demo files' }[e.name] || 'only you'}</small>` : ''}</span>
        <span class="file-size num">${e.dir ? `${e.items} item${e.items === 1 ? '' : 's'}` : fmtBytes(e.size)}</span>
        <span class="file-date num dim">${esc(e.modified.replace('T', ' '))}</span>
      </button>`;

    const openDir = async (rel, focusPath = null) => {
      let data;
      try {
        data = await api.drive(pid, rel);
      } catch (err) {
        toast({ icon: 'x', title: 'Cannot open that folder', text: err.message, tone: 'error' });
        return;
      }
      path = data.path;
      entries = data.entries;
      areas = data.areas;
      paintRemote(data.remote);
      head.innerHTML = crumbsHtml();
      const inside = path !== '' && !store.guest;
      tools.innerHTML = store.guest ? '<span class="dim tools-note">Guest demo folder: look and download, uploads are for signed-in players.</span>' : inside ? `
        ${kiosk() ? '' : `<button class="chip-btn" data-focus data-tool="upload">${icon('download', 20)} Upload</button>`}
        <button class="chip-btn" data-focus data-tool="folder">${icon('plus', 20)} New folder</button>
        ${kiosk() ? '' : '<span class="dim tools-note">or drag files here</span>'}` : '<span class="dim tools-note">Shared is for everyone on the console; your folder is just for you.</span>';
      list.innerHTML = (path ? `<button class="file" data-focus data-up>${icon('back', 24)}<span class="file-name">Up one level</span></button>` : '')
        + (entries.map(row).join('') || '<div class="empty">This folder is empty. Upload something!</div>');
      list.scrollTop = 0;
      const target = focusPath && list.querySelector(`[data-path="${CSS.escape(focusPath)}"]`);
      if (target) focus(target, { silent: true });
      else focusFirst(list);
    };

    const preview = (entry) => {
      const files = entries.filter((e) => !e.dir);
      openPreview(files, Math.max(files.indexOf(entry), 0));
    };

    // ----- upload -----
    const upload = async (fileList) => {
      if (!path) return toast({ icon: 'x', title: 'Open Shared or your folder first', tone: 'error' });
      const folder = path;
      for (const file of fileList) {
        const note = toast({ icon: 'download', title: `Uploading ${file.name}`, text: '0%', duration: 600000 });
        try {
          const res = await api.driveUpload(pid, folder, file, (p) => note.update({ text: `${Math.round(p * 100)}% of ${fmtBytes(file.size)}` }));
          note.close();
          celebrate(res.event, `Uploaded ${file.name}`);
        } catch (err) {
          note.close();
          toast({ icon: 'x', title: `Could not upload ${file.name}`, text: err.message, tone: 'error' });
        }
      }
      if (path === folder) openDir(folder);
    };
    picker.addEventListener('change', () => { upload([...picker.files]); picker.value = ''; });
    let dragDepth = 0;
    el.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; filesPanel.classList.add('dropping'); } });
    el.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; filesPanel.classList.remove('dropping'); } });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      filesPanel.classList.remove('dropping');
      if (e.dataTransfer?.files?.length) upload([...e.dataTransfer.files]);
    });

    // ----- file options -----
    const options = (entry) => {
      if (!entry || path === '' || store.guest) return;
      const other = areas.find((a) => a !== entry.path.split('/')[0]);
      openOverlay({
        className: 'center-panel',
        render(body, layer) {
          body.innerHTML = `<div class="panel confirm-panel file-options">
            <div class="kicker">${entry.dir ? 'Folder' : 'File'}</div><h2 class="title-lg">${esc(entry.name)}</h2>
            <div class="option-list">
              ${!entry.dir && !kiosk() ? `<a class="btn" data-focus href="${fileUrl(entry.path, true)}" download>${icon('download', 22)} Download</a>` : ''}
              ${entry.dir ? '' : `<button class="btn" data-focus data-opt="link">${icon('share', 22)} Share link (7 days)</button>`}
              <button class="btn" data-focus data-opt="rename">${icon('sliders', 22)} Rename</button>
              ${other ? `<button class="btn" data-focus data-opt="move">${icon('folder', 22)} Move to ${esc(other === 'Shared' ? 'Shared' : 'my folder')}</button>` : ''}
              <button class="btn danger" data-focus data-opt="delete">${icon('trash', 22)} Move to trash</button>
            </div></div>`;
          body.addEventListener('click', async (e) => {
            const opt = e.target.closest('[data-opt]')?.dataset.opt;
            if (!opt) return;
            closeOverlay(layer, { silent: true });
            try {
              if (opt === 'link') {
                const link = await api.driveLink(pid, entry.path);
                showLink(entry, `${location.origin}${link.url}`, link.expires);
              } else if (opt === 'rename') {
                const name = await askText({ title: 'Rename', value: entry.name });
                if (name && name !== entry.name) {
                  const renamed = await api.driveAction('rename', pid, { path: entry.path, name });
                  openDir(path, renamed.path);
                }
              } else if (opt === 'move') {
                await api.driveAction('move', pid, { path: entry.path, to: other });
                toast({ icon: 'folder', title: `Moved to ${other}`, duration: 2000 });
                openDir(path);
              } else if (opt === 'delete' && await confirmDelete(entry)) {
                await api.driveAction('delete', pid, { path: entry.path });
                toast({ icon: 'trash', title: `${entry.name} is in the trash`, duration: 2000 });
                openDir(path);
              }
            } catch (err) {
              toast({ icon: 'x', title: 'That didn\'t work', text: err.message, tone: 'error' });
            }
          });
        },
      });
    };

    const showLink = (entry, url, expires) => {
      openOverlay({
        className: 'center-panel',
        render(body, layer) {
          body.innerHTML = `<div class="panel confirm-panel">
            <div class="kicker">Share link · valid until ${esc(expires.replace('T', ' '))}</div><h2 class="title-lg">${esc(entry.name)}</h2>
            <input class="field link-field num" data-focus readonly value="${esc(url)}">
            <p class="muted">Anyone with the link can download this file while it's valid, on your home network (or anywhere through Tailscale).</p>
            <div class="btn-row"><button class="btn primary" data-focus data-act="copy">${icon('check', 22)} Copy link</button>
            <button class="btn" data-focus data-act="close">Close</button></div></div>`;
          body.addEventListener('click', async (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (act === 'copy') {
              const field = body.querySelector('.link-field');
              field.select();
              try { await navigator.clipboard.writeText(url); } catch { document.execCommand('copy'); }
              toast({ icon: 'check', title: 'Link copied', duration: 1500 });
            }
            if (act) closeOverlay(layer, { silent: true });
          });
        },
      });
    };

    el.addEventListener('click', async (e) => {
      const crumb = e.target.closest('[data-crumb]');
      if (crumb) return openDir(crumb.dataset.crumb);
      const tool = e.target.closest('[data-tool]')?.dataset.tool;
      if (tool === 'upload') return picker.click();
      if (tool === 'folder') {
        const name = await askText({ title: 'New folder', placeholder: 'Holiday photos' });
        if (!name) return null;
        try {
          const made = await api.driveAction('folder', pid, { path, name });
          return openDir(path, made.path);
        } catch (err) {
          return toast({ icon: 'x', title: 'Could not create the folder', text: err.message, tone: 'error' });
        }
      }
      const f = e.target.closest('.file');
      if (!f) return null;
      if (f.hasAttribute('data-up')) return openDir(path.split('/').slice(0, -1).join('/'), path);
      const entry = entries.find((x) => x.path === f.dataset.path);
      if (entry?.dir) return openDir(entry.path);
      if (entry) return preview(entry);
      return null;
    });
    el.addEventListener('contextmenu', (e) => {
      const f = e.target.closest('.file[data-path]');
      if (!f) return;
      e.preventDefault();
      options(entries.find((x) => x.path === f.dataset.path));
    });

    // Opened from For You / Home with a file: show its folder and preview it.
    const start = params.open || params.path || '';
    const isFile = params.open && !params.open.endsWith('/');
    await Promise.all([paintStats(), openDir(isFile ? start.split('/').slice(0, -1).join('/') : start, isFile ? start : null)]);
    if (isFile) {
      const entry = entries.find((x) => x.path === start);
      if (entry && !entry.dir) preview(entry);
    }
    const timer = setInterval(paintStats, 3000);

    return {
      onButton(action) {
        if (action === 'x') {
          const f = getFocused();
          options(f && list.contains(f) ? entries.find((x) => x.path === f.dataset.path) : null);
          return true;
        }
        return false;
      },
      onBack() {
        if (!path) return false;
        openDir(path.split('/').slice(0, -1).join('/'), path);
        return true;
      },
      unmount() {
        cleanup();
        clearInterval(timer);
      },
    };
  },
};

