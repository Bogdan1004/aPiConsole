// YouTube's official embedded player (IFrame API). The music player uses it for full songs; it stays visible
// (docked on the Music screen, picture-in-picture elsewhere) while it plays, as YouTube's terms require.
let ready = null;
let player = null;
const listeners = { state: () => {}, error: () => {} };

/** Resolves to the shared player, or null when YouTube can't be reached. */
export function youtube() {
  if (player) return Promise.resolve(player);
  if (ready) return ready;
  ready = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      new window.YT.Player('yt-player', {
        host: 'https://www.youtube-nocookie.com',
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, origin: location.origin },
        events: {
          onReady: (e) => { player = e.target; resolve(player); },
          onStateChange: (e) => listeners.state(e.data),
          onError: (e) => listeners.error(e.data),
        },
      });
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => { ready = null; script.remove(); resolve(null); };
    document.head.append(script);
    setTimeout(() => resolve(null), 12000);
  });
  return ready;
}

export function onYoutube(state, error) {
  listeners.state = state;
  listeners.error = error;
}

export const YT_STATE = { ended: 0, playing: 1, paused: 2, buffering: 3, cued: 5 };
