'use strict';
const { execFileSync } = require('child_process');
const root = 'C:/Users/dell/Desktop/狼人杀在线版 1.0.0';
const msg = [
  'feat: v1.7.1 - injectable clock + virtual-time acceleration',
  '',
  '- server/clock.js: real/virtual dual-mode clock singleton (default real, zero behavior change); timers queued by fire-time, tickNext() executes synchronously',
  '- game.js: all Date.now/setTimeout/clearTimeout swapped to clock.* (phase/night/hunter/thief timers, bot scheduling, chat rate-limit, event/msg timestamps, snapshot resume); bot-brain blindspot audit clean (sync decisions, all-random via rng(), no wall-clock deps)',
  '- debugRoom: test-only board-setup constructor (skip room creation/deal, auto-fill prior night steps, seed-deterministic, ms-level rule tests)',
  '- lab platform: virtual-time driver runOneLabGame (same-seed double-run strictly deterministic; drive = push clock only, game self-advances) - 50 games wall-clock 0.52s vs 2-4s/game real mode; scenarios migrated, lab.js enters virtual mode',
  '- guard test check-lab-virtual (wall <3s + same-seed event-stream hash identical); 43/43 full regression green',
].join('\n');
execFileSync('git', ['add', '-A'], { cwd: root });
execFileSync('git', ['commit', '-m', msg], { cwd: root, encoding: 'utf8' });
console.log('commit:', execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
// tag v1.7.1
try { execFileSync('git', ['tag', '-a', 'v1.7.1', '-m', 'v1.7.1 - injectable clock + virtual-time acceleration'], { cwd: root, encoding: 'utf8' }); console.log('tag: v1.7.1'); } catch (e) { console.log('tag 已存在或失败:', e.message.split('\n')[0]); }
// push（重试几次）
for (let i = 0; i < 4; i++) {
  try {
    const out = execFileSync('git', ['push', 'origin', 'main', '--tags'], { cwd: root, encoding: 'utf8', timeout: 180000 });
    console.log('push OK:', out.trim().split('\n').slice(-2).join(' | '));
    break;
  } catch (e) {
    const m = (e.message || '').split('\n')[0];
    console.log('push 尝试' + (i + 1) + ' 失败:', m.slice(0, 80));
    if (i === 3) throw e;
  }
}
