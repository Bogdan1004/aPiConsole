// Procedural cover art and pixel avatars, so the demo library looks good without image files.

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let uid = 0;
const f = (n) => Math.round(n * 10) / 10;

function stars(r, W, H, count, maxY = H) {
  let s = '';
  for (let i = 0; i < count; i++) {
    s += `<circle cx="${f(r() * W)}" cy="${f(r() * maxY)}" r="${f(0.6 + r() * 1.6)}" fill="#fff" opacity="${f(0.2 + r() * 0.7)}"/>`;
  }
  return s;
}

function ridge(r, W, H, base, amp, peaks) {
  const pts = [`0,${H}`, `0,${f(base)}`];
  for (let i = 1; i <= peaks; i++) {
    const x = (W / peaks) * i;
    pts.push(`${f(x - W / peaks / 2)},${f(base - amp * (0.4 + r() * 0.6))}`);
    pts.push(`${f(x)},${f(base - amp * r() * 0.35)}`);
  }
  pts.push(`${W},${H}`);
  return pts.join(' ');
}

const STYLES = {
  sunset(r, W, H, [c1, c2], id) {
    const hz = H * 0.62;
    const cx = W * (0.4 + r() * 0.2);
    const sr = W * 0.3;
    let bars = '';
    for (let i = 0; i < 6; i++) {
      const y = hz - sr * 0.9 + i * sr * 0.22;
      bars += `<rect x="0" y="${f(y)}" width="${W}" height="${f(2 + i * 2.6)}" fill="#000"/>`;
    }
    return `
      <defs>
        <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset=".62" stop-color="${c1}" stop-opacity=".9"/><stop offset="1" stop-color="${c2}"/></linearGradient>
        <linearGradient id="${id}u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6c8"/><stop offset="1" stop-color="${c1}"/></linearGradient>
        <mask id="${id}m"><rect width="${W}" height="${H}" fill="#fff"/>${bars}</mask>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#${id}s)"/>
      <rect width="${W}" height="${H}" fill="#000" opacity=".25"/>
      ${stars(r, W, H, 26, hz * 0.6)}
      <circle cx="${f(cx)}" cy="${f(hz)}" r="${f(sr)}" fill="url(#${id}u)" mask="url(#${id}m)"/>
      <polygon points="${ridge(r, W, H, hz + 4, H * 0.12, 4)}" fill="#000" opacity=".45"/>
      <polygon points="${ridge(r, W, H, hz + 18, H * 0.08, 6)}" fill="#000" opacity=".7"/>
      <rect y="${f(hz + 18)}" width="${W}" height="${f(H - hz)}" fill="#000" opacity=".55"/>`;
  },

  orbit(r, W, H, [c1, c2], id) {
    const cx = W * (0.45 + r() * 0.15);
    const cy = H * (0.4 + r() * 0.1);
    const pr = W * (0.24 + r() * 0.06);
    const tilt = -10 - r() * 20;
    return `
      <defs>
        <radialGradient id="${id}b" cx=".5" cy=".4" r=".8"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="#03030a"/></radialGradient>
        <radialGradient id="${id}p" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".25" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#${id}b)"/>
      ${stars(r, W, H, 60)}
      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(pr)}" fill="url(#${id}p)"/>
      <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(pr * 1.75)}" ry="${f(pr * 0.34)}" fill="none" stroke="${c1}" stroke-width="${f(W * 0.018)}" opacity=".85" transform="rotate(${f(tilt)} ${f(cx)} ${f(cy)})"/>
      <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(pr * 2)}" ry="${f(pr * 0.42)}" fill="none" stroke="#fff" stroke-width="1.2" opacity=".35" transform="rotate(${f(tilt)} ${f(cx)} ${f(cy)})"/>
      <circle cx="${f(W * (0.15 + r() * 0.2))}" cy="${f(H * (0.72 + r() * 0.1))}" r="${f(W * 0.05)}" fill="${c1}" opacity=".8"/>`;
  },

  grid(r, W, H, [c1, c2], id) {
    const hz = H * (0.5 + r() * 0.08);
    let lines = '';
    for (let i = 1; i <= 12; i++) {
      const y = hz + (H - hz) * (i / 12) ** 2;
      lines += `<line x1="0" y1="${f(y)}" x2="${W}" y2="${f(y)}"/>`;
    }
    for (let k = -10; k <= 10; k++) {
      lines += `<line x1="${f(W / 2 + k * W * 0.04)}" y1="${f(hz)}" x2="${f(W / 2 + k * W * 0.32)}" y2="${H}"/>`;
    }
    return `
      <defs>
        <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05040f"/><stop offset=".55" stop-color="${c2}"/><stop offset="1" stop-color="#05040f"/></linearGradient>
        <radialGradient id="${id}g" cx=".5" cy="0" r=".7"><stop offset="0" stop-color="${c1}" stop-opacity=".9"/><stop offset="1" stop-color="${c1}" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#${id}s)"/>
      ${stars(r, W, H, 40, hz * 0.85)}
      <circle cx="${W / 2}" cy="${f(hz)}" r="${f(W * 0.22)}" fill="${c1}" opacity=".9"/>
      <rect y="${f(hz)}" width="${W}" height="${f(H - hz)}" fill="#05040f"/>
      <ellipse cx="${W / 2}" cy="${f(hz)}" rx="${W}" ry="${f(H * 0.25)}" fill="url(#${id}g)"/>
      <g stroke="${c1}" stroke-width="1.6" opacity=".8">${lines}</g>`;
  },

  rings(r, W, H, [c1, c2], id) {
    const cx = W * (0.3 + r() * 0.4);
    const cy = H * (0.3 + r() * 0.4);
    let rings = '';
    for (let i = 1; i <= 14; i++) {
      const rr = i * Math.max(W, H) * 0.06;
      const col = i % 3 === 0 ? '#fff' : c1;
      rings += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rr)}" fill="none" stroke="${col}" stroke-width="${f(1 + r() * (i % 2 ? 6 : 2))}" opacity="${f(0.9 - i * 0.055)}"/>`;
    }
    return `
      <defs><radialGradient id="${id}b" cx=".5" cy=".5" r=".8"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="#030308"/></radialGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#${id}b)"/>
      ${rings}
      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(W * 0.05)}" fill="${c1}"/>`;
  },

  waves(r, W, H, [c1, c2], id) {
    let waves = '';
    for (let i = 0; i < 6; i++) {
      const y = H * (0.3 + i * 0.12);
      const a = H * (0.03 + r() * 0.05);
      const ph = r() * W;
      let d = `M0 ${f(y)}`;
      for (let x = 0; x <= W; x += W / 4) {
        d += ` Q ${f(x + W / 8)} ${f(y + Math.sin((x + ph) / 40) * a * 2)} ${f(x + W / 4)} ${f(y + Math.cos((x + ph) / 50) * a)}`;
      }
      d += ` L ${W} ${H} L 0 ${H} Z`;
      waves += `<path d="${d}" fill="${i % 2 ? c1 : '#fff'}" opacity="${f(i % 2 ? 0.25 + i * 0.08 : 0.06)}"/>`;
    }
    return `
      <defs><linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="#04040c"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#${id}b)"/>
      ${stars(r, W, H, 20, H * 0.3)}
      <circle cx="${f(W * (0.2 + r() * 0.6))}" cy="${f(H * 0.18)}" r="${f(W * 0.09)}" fill="${c1}" opacity=".85"/>
      ${waves}`;
  },

  mountains(r, W, H, [c1, c2], id) {
    return `
      <defs><linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#${id}s)"/>
      <rect width="${W}" height="${H}" fill="#000" opacity=".2"/>
      <circle cx="${f(W * (0.25 + r() * 0.5))}" cy="${f(H * (0.2 + r() * 0.12))}" r="${f(W * 0.1)}" fill="#fff" opacity=".85"/>
      <polygon points="${ridge(r, W, H, H * 0.55, H * 0.25, 3)}" fill="#000" opacity=".3"/>
      <polygon points="${ridge(r, W, H, H * 0.68, H * 0.2, 4)}" fill="#000" opacity=".5"/>
      <polygon points="${ridge(r, W, H, H * 0.82, H * 0.16, 5)}" fill="#000" opacity=".75"/>`;
  },

  moon(r, W, H, [c1, c2], id) {
    const cx = W * (0.5 + r() * 0.15);
    const cy = H * (0.32 + r() * 0.08);
    const mr = W * 0.26;
    let craters = '';
    for (let i = 0; i < 6; i++) {
      craters += `<circle cx="${f(cx - mr * 0.6 + r() * mr * 0.9)}" cy="${f(cy - mr * 0.5 + r() * mr)}" r="${f(mr * (0.05 + r() * 0.1))}" fill="#000" opacity=".12"/>`;
    }
    let clouds = '';
    for (let i = 0; i < 4; i++) {
      clouds += `<rect x="${f(r() * W - W * 0.2)}" y="${f(H * (0.5 + r() * 0.4))}" width="${f(W * (0.4 + r() * 0.4))}" height="${f(H * 0.05)}" rx="${f(H * 0.025)}" fill="#fff" opacity="${f(0.05 + r() * 0.08)}"/>`;
    }
    return `
      <defs>
        <radialGradient id="${id}b" cx=".5" cy=".3" r=".9"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="#020208"/></radialGradient>
        <mask id="${id}m"><rect width="${W}" height="${H}" fill="#fff"/><circle cx="${f(cx + mr * 0.45)}" cy="${f(cy - mr * 0.2)}" r="${f(mr * 0.9)}" fill="#000"/></mask>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#${id}b)"/>
      ${stars(r, W, H, 50)}
      <circle cx="${f(cx)}" cy="${f(cy)}" r="${f(mr * 1.5)}" fill="${c1}" opacity=".08"/>
      <g mask="url(#${id}m)"><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(mr)}" fill="${c1}"/>${craters}</g>
      ${clouds}`;
  },
};

/** SVG cover art for a catalog item. Aspect: "poster" (2:3), "square" or "wide" (16:9). */
export function art(item, aspect = 'poster') {
  const [W, H] = { poster: [300, 450], square: [400, 400], wide: [480, 270] }[aspect];
  const style = STYLES[item.art] || STYLES.orbit;
  const palette = item.palette || ['#a78bfa', '#1e1b4b'];
  const id = `a${uid++}`;
  return `<svg class="art" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${style(rng(item.id + aspect), W, H, palette, id)}</svg>`;
}

/** Cover element: real poster image when available, procedural art behind it as fallback. */
export function cover(item, aspect = 'poster') {
  let img = '';
  if (item.poster && item.poster_fit === 'contain') {
    // Box art keeps its own shape: shown whole over a blurred copy of itself.
    img = `<img class="poster-bg" src="${item.poster}" alt="" loading="lazy" onerror="this.remove()">
      <img class="poster-fg" src="${item.poster}" alt="" loading="lazy" onerror="this.remove()">`;
  } else if (item.poster) {
    img = `<img src="${item.poster}" alt="" loading="lazy" onerror="this.remove()">`;
  }
  return `<div class="cover cover-${aspect}">${art(item, aspect)}${img}</div>`;
}

/** Symmetric 8×8 pixel sprite on a gradient disc, seeded by the profile id. */
export function avatar(profile, size = 120) {
  const r = rng(`avatar:${profile.id}`);
  const hue = profile.hue ?? 260;
  const cells = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      let on = r() < 0.55;
      if (x === 3 && y >= 2 && y <= 5) on = true;
      if (y === 3 && x >= 1) on = true;
      if (y === 0 || (y === 7 && x === 3)) on = on && r() < 0.5;
      if (on) cells.push([x, y], [7 - x, y]);
    }
  }
  const px = 7;
  const off = (100 - px * 8) / 2;
  const id = `av${uid++}`;
  const rects = cells.map(([x, y]) => `<rect x="${off + x * px}" y="${off + y * px + 2}" width="${px + 0.3}" height="${px + 0.3}"/>`).join('');
  return `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 85% 64%)"/><stop offset="1" stop-color="hsl(${hue + 50} 75% 34%)"/></linearGradient></defs>
    <circle cx="50" cy="50" r="50" fill="url(#${id})"/>
    <g fill="#fff" opacity=".95">${rects}</g>
    <rect x="${off + px}" y="${off + 3 * px + 2}" width="${px}" height="${px}" fill="hsl(${hue} 60% 18%)"/>
    <rect x="${off + 6 * px}" y="${off + 3 * px + 2}" width="${px}" height="${px}" fill="hsl(${hue} 60% 18%)"/>
  </svg>`;
}
