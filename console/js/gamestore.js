// Game Store actions shared by the Store and Games screens: install, delete, and watching jobs.
import { api } from './api.js';
import { cover } from './art.js';
import { icon } from './icons.js';
import { sfx } from './sfx.js';
import { emit, loadLibrary, store } from './store.js';
import { celebrate, closeOverlay, esc, hints, openOverlay, toast } from './ui.js';

export function fmtSize(mb) {
  if (mb == null) return '';
  if (mb < 1) return `${Math.max(1, Math.round(mb * 1024))} KB`;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export const isActive = (job) => job && (job.state === 'queued' || job.state === 'running');

let pollTimer = null;
const announced = new Set();

/** Poll the hub while jobs run; celebrate finished installs wherever you are in the console. */
export function watchJobs() {
  if (pollTimer) return;
  const tick = async () => {
    let jobs;
    try { jobs = await api.storeJobs(); } catch { return; }
    emit('store-jobs', jobs);
    for (const job of jobs) {
      const key = `${job.id}:${job.action}:${job.started}`;
      if (isActive(job) || announced.has(key)) continue;
      announced.add(key);
      await loadLibrary().catch(() => {});
      if (job.state === 'error') {
        sfx.error();
        toast({ icon: 'x', title: `${job.title}: ${job.action === 'install' ? 'download' : 'delete'} failed`, text: job.message, tone: 'error', duration: 6000 });
      } else if (job.action === 'install') {
        if (job.event) celebrate(job.event, `${job.title} is ready to play`);
        else toast({ icon: 'download', title: `${job.title} is ready to play`, tone: 'xp' });
      } else {
        toast({ icon: 'trash', title: `${job.title} deleted`, text: 'Your saves are kept', tone: 'muted' });
      }
    }
    if (!jobs.some(isActive)) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  pollTimer = setInterval(tick, 1000);
  tick();
}

export async function installGame(entry) {
  try {
    const job = await api.storeInstall(store.profile.id, entry.id);
    sfx.select();
    toast({ icon: 'download', title: `Downloading ${entry.title}`, text: fmtSize(entry.size_mb), tone: 'info', duration: 2500 });
    emit('store-jobs', [job]);
    watchJobs();
    return job;
  } catch (err) {
    toast({ icon: 'x', title: `Could not download ${entry.title}`, text: err.message, tone: 'error' });
    return null;
  }
}

/** Ask first, then delete a Store game (uninstall) or a ROM you added yourself. Resolves true when started. */
export function deleteGame(item) {
  return new Promise((resolve) => {
    let decided = false;
    const done = (value, layer) => {
      decided = true;
      resolve(value);
      closeOverlay(layer, { silent: true });
    };
    openOverlay({
      className: 'center-panel',
      render(body, layer) {
        const ownRom = item.source === 'roms';
        body.innerHTML = `
          <div class="panel confirm-panel">
            <div class="confirm-head">${cover(item, 'wide')}
              <div><div class="kicker">${ownRom ? 'Delete ROM' : 'Delete game'}</div><h2 class="title-lg">${esc(item.title)}</h2>
              <p class="muted">${ownRom ? 'The ROM file is removed from the Pi.' : `Frees about ${fmtSize(item.size_mb) || 'some space'}. You can download it again any time.`}
              Save files stay on the Pi.</p></div>
            </div>
            <div class="btn-row">
              <button class="btn" data-focus data-autofocus data-act="keep">${icon('back', 22)} Keep it</button>
              <button class="btn danger" data-focus data-act="delete">${icon('trash', 22)} Delete</button>
            </div>
            ${hints([['a', 'Select'], ['b', 'Cancel']])}
          </div>`;
        body.addEventListener('click', async (e) => {
          const act = e.target.closest('[data-act]')?.dataset.act;
          if (act === 'keep') return done(false, layer);
          if (act !== 'delete') return;
          try {
            if (item.source === 'roms') {
              await api.deleteRom(item.id);
              await loadLibrary();
              toast({ icon: 'trash', title: `${item.title} deleted`, tone: 'muted' });
            } else {
              const job = await api.storeUninstall(store.profile.id, item.id);
              emit('store-jobs', [job]);
              watchJobs();
            }
            sfx.back();
            done(true, layer);
          } catch (err) {
            toast({ icon: 'x', title: 'Could not delete', text: err.message, tone: 'error' });
            done(false, layer);
          }
        });
        layer.onClose = () => { if (!decided) resolve(false); };
      },
    });
  });
}
