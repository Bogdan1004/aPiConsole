// π Snake — the built-in arcade game, so the console can play something with zero setup.
import { api } from './api.js';
import { focus } from './focus.js';
import { glyph, icon } from './icons.js';
import { sfx } from './sfx.js';
import { store } from './store.js';
import { celebrate, closeOverlay, esc, openOverlay } from './ui.js';

const COLS = 24;
const ROWS = 16;
const CELL = 46;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BEST_KEY = (pid) => `apistation.snake.best.${pid}`;

export function openSnake(item) {
  openOverlay({
    className: 'full-panel snake-overlay',
    render(body, layer) {
      const pid = store.profile.id;
      let best = 0;
      try { best = Number(localStorage.getItem(BEST_KEY(pid)) || 0); } catch { /* storage blocked */ }
      body.innerHTML = `
        <div class="snake">
          <div class="snake-head">
            <div><div class="kicker">aPiStation Arcade</div><h1 class="title-lg">${esc(item.title)}</h1></div>
            <div class="snake-scores"><div><span class="dim">Score</span><b class="num s-score">0</b></div><div><span class="dim">Best</span><b class="num s-best">${best}</b></div></div>
          </div>
          <canvas width="${COLS * CELL}" height="${ROWS * CELL}"></canvas>
          <div class="snake-over is-hidden">
            <div class="panel snake-over-panel">
              <div class="kicker">Game over</div>
              <div class="display num s-final">0</div>
              <p class="muted s-msg"></p>
              <div class="btn-row" data-group="over">
                <button class="btn primary" data-focus data-act="again">${icon('refresh', 24)} Play again</button>
                <button class="btn" data-focus data-act="exit">${icon('back', 24)} Exit</button>
              </div>
            </div>
          </div>
          <div class="hints"><span class="hint">${icon('gamepad', 28)} D-pad / arrows to steer</span><span class="hint">${glyph('b')} Exit</span></div>
        </div>`;
      const canvas = body.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const scoreEl = body.querySelector('.s-score');
      const over = body.querySelector('.snake-over');
      const style = getComputedStyle(document.getElementById('stage'));
      const c1 = style.getPropertyValue('--accent').trim() || '#a78bfa';
      const c2 = style.getPropertyValue('--accent-2').trim() || '#22d3ee';

      let snake;
      let dir;
      let queue;
      let food;
      let score;
      let speed;
      let alive;
      let timer = null;
      let pulse = 0;

      const placeFood = () => {
        do {
          food = [Math.floor(Math.random() * COLS), Math.floor(Math.random() * ROWS)];
        } while (snake.some(([x, y]) => x === food[0] && y === food[1]));
      };

      const reset = () => {
        snake = [[8, 8], [7, 8], [6, 8]];
        dir = 'right';
        queue = [];
        score = 0;
        speed = 140;
        alive = true;
        scoreEl.textContent = '0';
        placeFood();
        over.classList.add('is-hidden');
        clearTimeout(timer);
        step();
      };

      const draw = () => {
        pulse += 0.2;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= COLS; x++) { ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ROWS * CELL); ctx.stroke(); }
        for (let y = 0; y <= ROWS; y++) { ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(COLS * CELL, y * CELL); ctx.stroke(); }
        // food
        const glow = 16 + Math.sin(pulse) * 6;
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = glow;
        ctx.fillStyle = '#fde68a';
        ctx.font = `700 ${CELL * 0.9}px Outfit, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('π', food[0] * CELL + CELL / 2, food[1] * CELL + CELL / 2 + 2);
        // snake
        snake.forEach(([x, y], i) => {
          const t = i / Math.max(snake.length - 1, 1);
          ctx.shadowColor = c1;
          ctx.shadowBlur = i === 0 ? 24 : 10;
          ctx.fillStyle = i === 0 ? '#fff' : t < 0.5 ? c1 : c2;
          ctx.globalAlpha = 1 - t * 0.45;
          const pad = i === 0 ? 3 : 5;
          ctx.beginPath();
          ctx.roundRect(x * CELL + pad, y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 12);
          ctx.fill();
        });
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        const [hx, hy] = snake[0];
        const [dx, dy] = DIRS[dir];
        ctx.fillStyle = '#0a0b16';
        [[-1, 1], [1, 1]].forEach(([s]) => {
          const ex = hx * CELL + CELL / 2 + dx * 8 + (dy ? s * 9 : 0);
          const ey = hy * CELL + CELL / 2 + dy * 8 + (dx ? s * 9 : 0);
          ctx.beginPath();
          ctx.arc(ex, ey, 4, 0, Math.PI * 2);
          ctx.fill();
        });
      };

      const gameOver = async () => {
        alive = false;
        sfx.error();
        body.querySelector('.s-final').textContent = score;
        const msg = body.querySelector('.s-msg');
        msg.textContent = score > best ? 'New personal best!' : `Best: ${best}`;
        if (score > best) {
          best = score;
          body.querySelector('.s-best').textContent = best;
          try { localStorage.setItem(BEST_KEY(pid), String(best)); } catch { /* storage blocked */ }
        }
        over.classList.remove('is-hidden');
        focus(layer.body.querySelector('[data-act="again"]'), { silent: true });
        if (score > 0) {
          try {
            const res = await api.score(pid, item.id, score);
            celebrate(res.event, `π Snake · ${score} points`);
          } catch { /* offline: keep playing */ }
        }
      };

      const step = () => {
        if (!alive) return;
        if (queue.length) dir = queue.shift();
        const [dx, dy] = DIRS[dir];
        const head = [snake[0][0] + dx, snake[0][1] + dy];
        const hit = head[0] < 0 || head[1] < 0 || head[0] >= COLS || head[1] >= ROWS
          || snake.some(([x, y], i) => i < snake.length - 1 && x === head[0] && y === head[1]);
        if (hit) {
          draw();
          gameOver();
          return;
        }
        snake.unshift(head);
        if (head[0] === food[0] && head[1] === food[1]) {
          score++;
          scoreEl.textContent = score;
          speed = Math.max(62, speed - 4);
          sfx.xp();
          placeFood();
        } else {
          snake.pop();
        }
        draw();
        timer = setTimeout(step, speed);
      };

      body.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'again') reset();
        if (act === 'exit') closeOverlay(layer);
      });

      layer.onButton = (action) => {
        if (!alive) return false;
        if (DIRS[action]) {
          const last = queue[queue.length - 1] || dir;
          const [lx, ly] = DIRS[last];
          const [nx, ny] = DIRS[action];
          if (lx + nx !== 0 || ly + ny !== 0) queue.push(action);
          if (queue.length > 3) queue.shift();
          return true;
        }
        return action === 'a';
      };
      layer.onClose = () => {
        alive = false;
        clearTimeout(timer);
      };
      reset();
    },
  });
}
