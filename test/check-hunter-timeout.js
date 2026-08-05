'use strict';
/* N1：白天被放逐的猎人 30 秒（测试用 NIGHT_TIMEOUT=2）超时自动弃枪，流程继续
 * N3：进入夜晚时 dayDeaths 清空（前一天的放逐公告不残留）
 * N6：view.moods 由服务端下发（表情白名单前后端一致）
 * 运行：node test/check-hunter-timeout.js */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8146;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
}
async function act(room, me, action, data) {
  const r = await api('/api/action', { room, me, action, data: data || {} });
  if (r.error) throw new Error(`action ${action}失败: ${r.error}`);
  return r.view;
}
async function st(room, me) { const res = await fetch(`${BASE}/api/state?room=${room}&me=${me}`); return res.json(); }

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT), PHASE_TIMEOUT: '1', NIGHT_TIMEOUT: '2' },
  });
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/healthz')).status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
    if (!ready) throw new Error('服务器未就绪');

    const r = await api('/api/create', { name: '房主A' });
    const room = r.roomId, me = r.playerId;
    const ids = [me];
    for (let i = 0; i < 4; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 2) }); ids.push(j.playerId); }
    // 狼/猎人/预言家/双平民：放逐猎人后仍有预言家在（否则神职全灭直接屠边）
    await act(room, me, 'setCounts', { counts: { wolf: 1, hunter: 1, seer: 1, villager: 1, witch: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0 } });
    await act(room, me, 'setCap', { cap: 5 });
    await act(room, me, 'start');
    await act(room, me, 'hostPick', { role: 'wolf' }); // 房主当狼
    for (const id of ids) await act(room, id, 'confirm');
    await sleep(200);
    // 找猎人
    let hunter = null, roles = {};
    for (const id of ids) { const v = await st(room, id); roles[id] = v.my.roleKey; if (v.my.roleKey === 'hunter') hunter = id; }
    assert(!!hunter, '存在猎人');
    const villagers = ids.filter(x => roles[x] === 'villager');
    // 夜1：狼刀平民
    await act(room, me, 'wolf_set', { kill: villagers[0], confirm: true });
    // 天亮后：跳过遗言 → 竞选（房主参选→警长）→ 投票放逐猎人 → hunter_shot
    for (let i = 0; i < 10; i++) {
      let v = await st(room, me);
      if (v.phase === 'night') { await api('/api/advance', { room, me }); } // 跳过夜1剩余步骤（预言家等）
      else if (v.phase === 'lastword') { await api('/api/advance', { room, me }); } // 房主跳过遗言
      else if (v.phase === 'sheriff_campaign') { for (const id of ids) { const sv = await st(room, id); if (sv.campaign && !sv.campaign.myDecided) await act(room, id, 'campaign', { run: id === me }); } }
      else if (v.phase === 'sheriff_vote') { for (const id of ids) { const sv = await st(room, id); if (!sv.my.alive) continue; if (!(sv.sheriffVote && sv.sheriffVote.myVoted)) await act(room, id, 'vote', { target: id === me ? null : me }); } }
      else if (v.phase === 'vote') { for (const id of ids) { const sv = await st(room, id); if (!sv.my.alive) continue; if (sv.vote && !sv.vote.myVoted) await act(room, id, 'vote', { target: hunter }); } }
      else if (v.phase === 'morning' || v.phase === 'discuss') { await api('/api/advance', { room, me }); }
      else if (v.phase === 'hunter_shot') break;
      await sleep(250);
    }
    let v = await st(room, me);
    assert(v.phase === 'hunter_shot', '猎人被放逐 → 进入 hunter_shot 等待开枪（实际 ' + v.phase + '）');
    assert(!!v.hunterDeadline, 'hunterDeadline 已下发（N1 白天猎人也有 30 秒倒计时）');
    // 猎人挂机：等待超时自动弃枪（NIGHT_TIMEOUT=2）
    await sleep(2600);
    v = await st(room, me);
    assert(v.phase === 'night', '猎人超时自动弃枪 → 流程继续进入夜晚（N1，实际 ' + v.phase + '）');
    // N3：放逐公告保留过夜（供回看），次日天亮才清空——入夜后应仍能看到猎人被放逐
    assert(v.dayDeaths.some(d => d.id === hunter && d.deadBy === 'exile'), '放逐公告保留过夜（N3，实际 ' + JSON.stringify(v.dayDeaths) + '）');
    assert(Array.isArray(v.moods) && v.moods.length === 12, 'view.moods 由服务端下发 12 种表情（N6）');
  } catch (e) { failures++; console.error('!!异常: ' + (e && e.stack || e)); }
  finally { server.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n猎人超时/公告清理/表情白名单专项测试全部通过 ✔');
  process.exit(0);
}
main();
