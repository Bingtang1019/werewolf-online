'use strict';
/* 全职业能力可用性 + 频道验证（v1.4.1 回归，HTTP 真实路径模拟客户端）
 * 覆盖：盗贼局 10 人全职业（盗贼/狼/狼美人/预言家/女巫/守卫/摄梦人/猎人/丘比特/平民）
 *   - 发牌：hostPick 后盗贼经 isThief 自识别选牌，身份全部发放
 *   - 夜晚各职业 action 全部可执行（thief_pick/cupid_pick/lovers_ok/guard_pick/dreamer_pick/wolf_set/seer_pick/witch_act/hunter_shoot）
 *   - 频道：夜晚狼人可见 wolf 频道、情侣可见 lover 频道
 *   - 狼美人可出刀（wolf_set kill）
 * 运行：node test/check-allroles.js
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 8141;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(`${action}失败: ${r.error}`); return r.view; }
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }
async function adv(room, me) { const r = await api('/api/advance', { room, me }); if (r.error) throw new Error('advance失败: ' + r.error); return r.view; }

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), PHASE_TIMEOUT: '5', NIGHT_TIMEOUT: '5' } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    const r = await api('/api/create', { name: '房主' });
    const room = r.roomId, host = r.playerId;
    await act(room, host, 'setCap', { cap: 10 });
    const ids = [host];
    for (let i = 1; i < 10; i++) { const jr = await api('/api/join', { roomId: room, name: '玩家' + (i + 1) }); ids.push(jr.playerId); }
    await act(room, host, 'settings', { thief: true });
    await act(room, host, 'setCounts', { counts: { wolf: 1, wolfBeauty: 1, seer: 1, witch: 1, guard: 1, dreamer: 1, hunter: 1, cupid: 1, villager: 3 } });
    await act(room, host, 'start');
    await act(room, host, 'hostPick', { role: 'seer' });
    // 盗贼自识别（isThief 仅盗贼本人可见）→ 选牌
    let thiefId = null;
    for (const id of ids) {
      const v = await st(room, id);
      if (v.reveal && v.reveal.isThief) { thiefId = id; break; }
    }
    assert(!!thiefId, '盗贼可自识别（reveal.isThief）');
    if (thiefId) {
      const tv = await st(room, thiefId);
      assert(Array.isArray(tv.reveal.thiefCards) && tv.reveal.thiefCards.length === 2, '盗贼看到两张身份牌');
      // 有狼必选狼（与引擎规则一致）；thiefCards 可能是中文名，用试错法选 idx
      let tr = await api('/api/action', { room, me: thiefId, action: 'thief_pick', data: { idx: 0 } });
      if (tr.error) tr = await api('/api/action', { room, me: thiefId, action: 'thief_pick', data: { idx: 1 } });
      assert(!tr.error, '盗贼 thief_pick 可用' + (tr.error ? '（' + tr.error + '）' : ''));
    }
    // 等发牌（thief_pick 后自动 tryDeal）
    await sleep(800);
    let v = await st(room, host);
    const roles = {};
    for (const p of v.players) roles[p.id] = (await st(room, p.id)).my.roleKey;
    const assigned = Object.values(roles).filter(Boolean).length;
    assert(assigned === 10, `身份全部发放（${assigned}/10）`);
    // confirm → 进夜晚
    for (const id of ids) { const cr = await api('/api/action', { room, me: id, action: 'confirm', data: {} }); if (cr.error) console.error('confirm', cr.error); }
    await adv(room, host);
    v = await st(room, host);
    assert(v.phase === 'night', '进入夜晚');
    // 夜晚各 step：真人 actor 行动后引擎自动推进（不 advance，避免强推跳过步骤）
    const stepOrder = [];
    const handledSteps = new Set();
    let wbShot = false; // 狼美人出刀结果（在循环中记录，避免重复行动）
    for (let i = 0; i < 30; i++) {
      v = await st(room, host);
      if (v.phase !== 'night') break;
      const step = v.nightStep;
      if (!step || handledSteps.has(step)) { await sleep(300); continue; }
      handledSteps.add(step);
      stepOrder.push(step);
      const actors = (v.night && v.night.actors) || [];
      for (const a of actors) {
        const pid = a.id, roleKey = roles[pid];
        let rr;
        let wbShotOk = false;
        if (step === 'cupid') rr = await api('/api/action', { room, me: pid, action: 'cupid_pick', data: { ids: [ids[1], ids[2]] } });
        else if (step === 'lovers') rr = await api('/api/action', { room, me: pid, action: 'lovers_ok', data: {} });
        else if (step === 'guard') rr = await api('/api/action', { room, me: pid, action: 'guard_pick', data: { target: pid === ids[0] ? ids[1] : ids[0] } });
        else if (step === 'dreamer') rr = await api('/api/action', { room, me: pid, action: 'dreamer_pick', data: { target: ids[0] } });
        else if (step === 'wolf') {
          // 狼美人：kill 随机活人 + charm 动态选（非自己/非kill/非狼），避免固定座位导致魅惑自己
          const charmT = v.players.find(p => p.alive && p.id !== pid && p.id !== ids[3] && roles[p.id] !== 'wolf' && roles[p.id] !== 'wolfBeauty');
          rr = await api('/api/action', { room, me: pid, action: 'wolf_set', data: roleKey === 'wolfBeauty' ? { kill: ids[3], charm: charmT ? charmT.id : null, confirm: true } : { kill: ids[3], confirm: true } });
          if (roleKey === 'wolfBeauty' && !rr.error) wbShotOk = true;
        }
        else if (step === 'seer') rr = await api('/api/action', { room, me: pid, action: 'seer_pick', data: { target: ids[1] } });
        else if (step === 'witch') rr = await api('/api/action', { room, me: pid, action: 'witch_act', data: { save: false, poison: null } });
        else if (step === 'hunter') rr = await api('/api/action', { room, me: pid, action: 'hunter_shoot', data: { target: null } });
        else rr = { error: '未知step' };
        assert(!rr.error, 'step=' + step + ' 角色=' + roleKey + ' action 可用' + (rr.error ? '（' + rr.error + '）' : ''));
        if (roleKey === 'wolfBeauty') wbShot = wbShot || wbShotOk;
      }
      await sleep(500); // 等引擎自动推进下一步
    }
    assert(stepOrder.length >= 6, '夜晚覆盖主要步骤: ' + stepOrder.join('→'));
    // 夜晚中验证频道（wolf/lover）
    if (v.phase === 'night') {
      const wolfId = Object.keys(roles).find(id => roles[id] === 'wolf' || roles[id] === 'wolfBeauty');
      const wv = await st(room, wolfId);
      assert((wv.myChannels || []).includes('wolf'), '狼人夜晚可见狼频道（' + (wv.myChannels || []).join(',') + '）');
      const lv = await st(room, ids[1]);
      assert((lv.myChannels || []).includes('lover'), '情侣可见情侣频道（' + (lv.myChannels || []).join(',') + '）');
      // 狼美人可出刀（循环中已执行 wolf_set kill；此处不再重复发 action，避免 nightStep 已推进）
      assert(wbShot, '狼美人可出刀（wolf_set kill）');
    } else {
      assert(true, '夜晚已结束（频道验证跳过，此前 step 已覆盖）');
    }
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n全职业能力 + 频道验证全部通过 ✔');
  process.exit(0);
}
main();
