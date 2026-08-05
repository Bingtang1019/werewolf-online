'use strict';
/* 房主投票明细（v1.3.0）：
 * V1 房主在 vote 阶段 view.vote.votedBy 含已投玩家名单（含投给谁）
 * V2 非房主 view.vote.votedBy === undefined（不泄露）
 * V3 弃票者以 vote:null 出现在房主明细中
 * V4 警长竞选投票 sheriff_vote 同样只有房主可见 votedBy
 * 运行：node test/check-votedby.js
 */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8388;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const assert = (c, m) => { if (c) console.log(' ✓ ' + m); else { failures++; console.error(' ✗ FAIL: ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function act(room, me, action, data) { const r = await api('/api/action', { room, me, action, data: data || {} }); if (r.error) throw new Error(action + '失败: ' + r.error); return r.view; }
async function st(room, me) { return (await fetch(`${BASE}/api/state?room=${room}&me=${me}`)).json(); }

/* 开局：cap=4，狼/女巫/预言家/平民，房主指定狼人；preSettings 可关警长 */
async function setup(preSettings) {
  const r = await api('/api/create', { name: '房主' });
  const room = r.roomId, host = r.playerId;
  const ids = [host];
  for (let i = 1; i < 4; i++) { const j = await api('/api/join', { roomId: room, name: '玩家' + (i + 1) }); ids.push(j.playerId); }
  if (preSettings) await act(room, host, 'settings', preSettings);
  await act(room, host, 'setCounts', { counts: { wolf: 1, seer: 1, witch: 1, hunter: 0, dreamer: 0, guard: 0, wolfBeauty: 0, cupid: 0, villager: 1 } });
  await act(room, host, 'setCap', { cap: 4 });
  await act(room, host, 'start');
  await act(room, host, 'hostPick', { role: 'wolf' });
  for (const id of ids) await act(room, id, 'confirm');
  return { room, host, ids };
}
/* 房主强制推进直到目标阶段（夜晚各步骤会被依次跳过，全员视为行动） */
async function ff(room, host, target) {
  let v = null;
  for (let i = 0; i < 15; i++) {
    const r = await api('/api/advance', { room, me: host });
    if (r.error) throw new Error('advance失败: ' + r.error);
    v = r.view;
    if (v.phase === target) return v;
  }
  throw new Error('无法推进到 ' + target);
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) } });
  let ready = false;
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`${BASE}/healthz`); if (r.status === 200) { ready = true; break; } } catch (e) {} await sleep(200); }
  if (!ready) { console.error('服务器未就绪'); srv.kill(); process.exit(1); }
  try {
    /* ---- 第一局：放逐投票（关闭警长） ---- */
    let s = await setup({ sheriff: false, thief: false, tieRule: 'none' });
    await ff(s.room, s.host, 'vote');
    // 玩家2 投票给 玩家3；玩家4 暂不投
    await act(s.room, s.ids[1], 'vote', { target: s.ids[2] });
    let vh = await st(s.room, s.host);   // 房主
    let v4 = await st(s.room, s.ids[3]); // 非房主
    assert(Array.isArray(vh.vote && vh.vote.votedBy), 'V1 房主 view.vote.votedBy 是数组');
    assert(vh.vote.votedBy.length === 1, 'V1 房主明细含 1 名已投玩家');
    const p2 = vh.vote.votedBy.find(x => x.id === s.ids[1]);
    assert(p2 && p2.vote === s.ids[2], 'V1 明细记录玩家2 投给了玩家3');
    assert(v4.vote.votedBy === undefined, 'V2 非房主 view.vote.votedBy 为 undefined（不泄露）');
    // 玩家4 弃票 → 房主明细应出现 vote:null
    await act(s.room, s.ids[3], 'vote', { target: null });
    vh = await st(s.room, s.host);
    const p4 = vh.vote.votedBy.find(x => x.id === s.ids[3]);
    assert(p4 && p4.vote === null, 'V3 弃票者以 vote:null 出现在房主明细');
    assert(vh.vote.votedBy.length === 2, 'V3 明细随投票实时更新（2 人）');

    /* ---- 第二局：警长竞选投票（开启警长） ---- */
    s = await setup({ sheriff: true, thief: false, tieRule: 'none' });
    await ff(s.room, s.host, 'sheriff_campaign');
    // 真人参选（run:true 才会进入候选人名单）；房主 advance 强制其余人表态 → beginSheriffVote
    await act(s.room, s.ids[1], 'campaign', { run: true });
    await act(s.room, s.ids[2], 'campaign', { run: true });
    await api('/api/advance', { room: s.room, me: s.host }); // 强制玩家4表态 → 全员决定 → beginSheriffVote
    let vc = await st(s.room, s.host);
    assert(vc.phase === 'sheriff_vote', 'V4 参选后进入 sheriff_vote 阶段');
    await act(s.room, s.ids[1], 'vote', { target: s.ids[2] });
    vh = await st(s.room, s.host);
    v4 = await st(s.room, s.ids[3]);
    assert(Array.isArray(vh.sheriffVote && vh.sheriffVote.votedBy), 'V4 房主 view.sheriffVote.votedBy 是数组');
    assert(vh.sheriffVote.votedBy.length === 1 && vh.sheriffVote.votedBy[0].vote === s.ids[2], 'V4 警长投票明细含玩家2 的选择');
    assert(v4.sheriffVote.votedBy === undefined, 'V4 非房主 view.sheriffVote.votedBy 为 undefined');
  } catch (e) { failures++; console.error('!!异常: ' + ((e && e.stack) || e)); }
  finally { srv.kill(); }
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n房主投票明细专项测试全部通过 ✔');
  process.exit(0);
}
main();
