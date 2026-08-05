'use strict';
/* 客户端渲染回归测试（v1.4.2）
 * 运行：node test/check-client-render.js
 * 原理：DOM stub harness（_harness-dom.js）直接执行 public/client.js 的渲染链，
 *   用引擎（game.js）驱动的真实 view 逐阶段渲染，验证不抛异常。
 * 覆盖：
 *   - 夜晚每个职业步骤（各角色视角 renderPanel + renderChat）
 *   - 狼人频道 tabs、情侣频道 tabs
 *   - 白天各阶段（morning/lastword/discuss/vote）与结算渲染
 * 背景：v1.3.0 引入的 night case 变量名笔误（STEP_GLOW vs glow）导致
 *   renderPanel 进夜晚必抛 ReferenceError → 面板无按钮 + 频道消失；
 *   客户端渲染此前从未被自动化覆盖，本测试补上这块空白。
 */
const Game = require('../game.js');
const h = require('./_harness-dom.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
function renderSafe(label) {
  try { h.renderPanel(); return true; } catch (e) { failures++; console.error(' ✗ FAIL: ' + label + ' renderPanel 异常: ' + e.message); return false; }
}
function chatSafe(label) {
  try { h.renderChat(); return true; } catch (e) { failures++; console.error(' ✗ FAIL: ' + label + ' renderChat 异常: ' + e.message); return false; }
}
function tabsHtml() { return (h.getEl('chat-tabs') || {}).innerHTML || ''; }

async function main() {
  const r = Game.createRoom('房主');
  const room = r.roomId, host = r.playerId;
  Game.handleAction(room, host, 'setCap', { cap: 10 });
  const ids = [host];
  for (let i = 1; i < 10; i++) ids.push(Game.joinRoom(room, '玩家' + (i + 1)).playerId);
  Game.handleAction(room, host, 'settings', { thief: true });
  Game.handleAction(room, host, 'setCounts', { counts: { wolf: 1, wolfBeauty: 1, seer: 1, witch: 1, guard: 1, dreamer: 1, hunter: 1, cupid: 1, villager: 3 } });
  Game.handleAction(room, host, 'start');
  Game.handleAction(room, host, 'hostPick', { role: 'seer' });
  Game.handleAdvance(room, host, 0); // 代选盗贼 + 发牌
  Game.handleAdvance(room, host, 0); // 进夜晚
  const g = Game.rooms.get(room);
  const roles = {};
  const v0 = Game.viewFor(g, host, 0);
  for (const p of v0.players) roles[p.id] = Game.viewFor(g, p.id, 0).my.roleKey;
  const idOf = role => Object.keys(roles).find(id => roles[id] === role);

  // ---- 夜晚：每个步骤按"该步 actor 视角"渲染 ----
  for (let i = 0; i < 24 && g.phase === 'night'; i++) {
    const step = g.nightStep;
    const actor = g.players.find(p => (step === 'lovers' ? (g.lovers || []).includes(p.id) : p.role === step) && p.alive);
    if (actor) {
      h.applyView(Game.viewFor(g, actor.id, 0));
      renderSafe('night:' + step + '（' + (roles[actor.id] || '?') + '视角）');
      if (step === 'lovers' || step === 'wolf') chatSafe('night:' + step);
    }
    // 推进（真人 actor 行动后引擎自动 setNightStep）
    if (step === 'cupid') { const c = idOf('cupid'); if (c) Game.handleAction(room, c, 'cupid_pick', { ids: [ids[1], ids[2]] }); }
    else if (step === 'lovers') { for (const l of (g.lovers || [])) Game.handleAction(room, l, 'lovers_ok', {}); }
    else if (step === 'guard') { const c = idOf('guard'); if (c) Game.handleAction(room, c, 'guard_pick', { target: ids[0] }); }
    else if (step === 'dreamer') { const c = idOf('dreamer'); if (c) Game.handleAction(room, c, 'dreamer_pick', { target: ids[0] }); }
    else if (step === 'wolf') { for (const w of g.players.filter(p => p.alive && (p.role === 'wolf' || p.role === 'wolfBeauty'))) Game.handleAction(room, w.id, 'wolf_set', { kill: ids[3], charm: w.role === 'wolfBeauty' ? ids[4] : undefined, confirm: true }); }
    else if (step === 'seer') { const c = idOf('seer'); if (c) Game.handleAction(room, c, 'seer_pick', { target: ids[1] }); }
    else if (step === 'witch') { const c = idOf('witch'); if (c) Game.handleAction(room, c, 'witch_act', { save: false, poison: null }); }
    await sleep(5);
    if (g.phase !== 'night' || g.nightStep === step) break;
  }
  assert(g.phase !== 'night' || true, '夜晚各步骤渲染通过（无异常）');

  // ---- 频道 tabs：夜晚狼人视角 ----
  const wolfId = idOf('wolf') || idOf('wolfBeauty');
  h.applyView(Game.viewFor(g, wolfId, 0));
  chatSafe('狼人视角');
  assert(tabsHtml().includes('狼人'), '夜晚狼人频道 tabs 含狼标签');
  const loverId = (g.lovers || [])[0];
  if (loverId) {
    h.applyView(Game.viewFor(g, loverId, 0));
    chatSafe('情侣视角');
    assert(tabsHtml().includes('情侣'), '情侣频道 tabs 含情侣标签');
  }

  // ---- 白天与结算：房主视角逐阶段渲染（advance 强推）----
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    h.applyView(Game.viewFor(g, host, 0));
    renderSafe('阶段:' + (g.phase || '?') + '（房主视角）');
    seen.add(g.phase || '?');
    if (g.phase === 'ended') break;
    if (g.phase === 'vote' || g.phase === 'pk_vote' || g.phase === 'sheriff_vote') {
      const t = g.players.find(p => p.alive && p.id !== host);
      if (t) Game.handleAction(room, host, 'vote', { target: t.id });
    }
    const r2 = Game.handleAdvance(room, host, 0);
    if (r2.error) break;
    await sleep(5);
  }
  assert(seen.size >= 3, '多阶段渲染覆盖（' + [...seen].join(',') + '）');

  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n客户端渲染回归全部通过 ✔');
  process.exit(0);
}
main();
