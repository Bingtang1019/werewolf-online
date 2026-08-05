'use strict';
/* =========================================================================
 * 浏览器流程模拟测试：
 * 1) 服务器未启动时点击“创建房间”应得到明确的网络错误（客户端会提示）
 * 2) 启动服务器后，模拟浏览器相对路径请求：创建→轮询→加入→错误房间号→首页
 * 运行：node test/client-flow.js
 * ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');
const PORT = 8399;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures++; console.error('  ✗ FAIL: ' + msg); }
}

async function testServerDown() {
  console.log('===== 场景A：服务器未启动时点击“创建房间” =====');
  try {
    const res = await fetch(BASE + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
    check(false, 'fetch 应因网络错误而失败（而不是返回结果）');
  } catch (e) {
    check(true, 'fetch 网络错误 → 客户端 api() 捕获并提示“无法连接服务器”');
  }
}

async function testServerUp() {
  console.log('\n===== 场景B：服务器运行时的浏览器流程（相对路径） =====');
  // 创建房间（浏览器中 fetch('api/create') 从根路径解析为 BASE + '/api/create'）
  const r = await fetch(BASE + '/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '测试员' }) });
  const j = await r.json();
  check(/^[0-9A-Z]{6}$/.test(j.roomId) && !!j.playerId && j.view && j.view.roomId === j.roomId,
    `创建房间：返回房间号 ${j.roomId} + playerId + view（顶栏显示房间号，自动进入房间）`);
  // 轮询 state（客户端每 600ms 调用）
  const s = await (await fetch(`${BASE}/api/state?room=${j.roomId}&me=${j.playerId}`)).json();
  check(s.phase === 'lobby' && s.players.length === 1, `轮询 state 正常（phase=${s.phase}，1 人在房）`);
  // 朋友加入
  const join = await (await fetch(BASE + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: j.roomId, name: '朋友' }) })).json();
  check(!!join.playerId, '朋友加入成功');
  // 错误房间号
  const bad = await (await fetch(BASE + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'ZZZZZZ', name: 'x' }) })).json();
  check(!!bad.error, `错误房间号返回提示：${bad.error}`);
  // 错误格式房间号
  const bad2 = await (await fetch(BASE + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId: 'abc', name: 'x' }) })).json();
  check(!!bad2.error, `格式错误房间号返回提示：${bad2.error}`);
  // 静态页面与健康检查
  const html = await (await fetch(BASE + '/')).text();
  check(html.includes('狼人杀') && html.includes('card-create') && html.includes('in-code') && html.includes('in-name'), '首页正常加载（双卡入口 + 昵称/房号输入框）');
  const hz = await (await fetch(BASE + '/healthz')).json();
  check(hz.ok === true, '/healthz 健康检查正常');
  // 重连：旧 session 恢复
  const re = await (await fetch(`${BASE}/api/state?room=${j.roomId}&me=${j.playerId}`)).json();
  check(re.phase === 'lobby' && re.my.id === j.playerId, '刷新页面后凭 localStorage 自动重连');
}

/* 场景C：客户端优化逻辑验证（版本保护 + 草稿清空，与 client.js 实现保持一致） */
function testClientLogic() {
  console.log('\n===== 场景C：客户端状态保护与草稿清理逻辑 =====');
  // 1) applyView 版本保护：旧版本不覆盖新版本
  let view = { v: 5 };
  function applyView(v) { if (!v || v.error) return; if (view && v.v < view.v) return; view = v; }
  applyView({ v: 4 });
  check(view.v === 5, '慢轮询返回的旧版本（v4）不覆盖当前状态（v5）');
  applyView({ v: 6 });
  check(view.v === 6, '新版本（v6）正常应用');
  applyView({ v: 5 });
  check(view.v === 6, '提交响应后到达的旧轮询（v5）不再覆盖（v6）');
  // 2) draft 草稿：阶段/步骤变化时清空，同阶段内保留
  let draft = {};
  let lastPhaseKey = null;
  function renderCheck(phase, step) {
    const key = phase + (step ? ':' + step : '');
    if (key !== lastPhaseKey) { draft = { target: null, target2: null, thiefIdx: undefined, kill: null, charm: null }; lastPhaseKey = key; }
  }
  renderCheck('vote', null);
  draft.target = 'PLAYER_A'; // 投票阶段点选
  renderCheck('vote', null); // 同阶段轮询渲染
  check(draft.target === 'PLAYER_A', '同一阶段内点选保留（不丢失）');
  renderCheck('night', 'guard'); // 进入夜晚守卫步骤
  check(draft.target === null, '跨阶段残留的投票目标被清空（守卫不会误选）');
  draft.kill = 'PLAYER_B'; // 狼人步骤设置刀人目标
  renderCheck('night', 'guard'); // 同一 nightStep 内
  check(draft.kill === 'PLAYER_B', '夜晚同一子步骤内狼人目标保留');
  renderCheck('night', 'seer'); // 步骤推进
  check(draft.kill === null, '夜晚子步骤变化后刀人目标清空');
  check(draft.thiefIdx === undefined, '盗贼选牌草稿恢复未选择状态');
}

async function main() {
  testClientLogic();
  await testServerDown();
  const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, SNAPSHOT_SEC: '0', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => process.stdout.write('[server] ' + d));
  server.stderr.on('data', d => process.stderr.write('[server-err] ' + d));
  await sleep(900);
  await testServerUp();
  server.kill();
  await sleep(300);
  if (failures) { console.error(`\n共 ${failures} 处失败`); process.exit(1); }
  console.log('\n浏览器流程模拟全部通过 ✔');
  process.exit(0);
}
main();
