'use strict';
/* =========================================================================
 * taskd.js —— 任务守护进程（1.7.17 架构创新：长任务与工具窗口解耦）
 *
 * 背景（archive/v5-投票判定实验/README.md 十七节）：
 *   训练/采集任务 20-40 分钟 vs 执行窗口 120s——手动 spawn/轮询/日志反复
 *   出现超时杀进程、竞态、死锁（本轮 9 次事故 ≈ 2 小时）。taskd 把长任务
 *   移入常驻守护进程，工具调用只做"提交 + 查询"（秒回）。
 *
 * 机制：
 *   - 任务文件：data/tasks/{id}.json（{type, cmd, args, cwd, env, budgetMs}）
 *   - 守护进程：顺序执行队列，每任务写 {id}.log + {id}.done（含 exit code）
 *   - checkpoint：任务自身支持断点（run-batch done / 训练 merge）——崩溃重启续跑
 *   - 并发预算：--max-procs 控制（防 OOM）
 *
 * 用法：
 *   node tools/taskd.js submit --id=collect16 --cmd=node --args=... --cwd=... [--env=K=V,...] [--budget=600000]
 *   node tools/taskd.js submit-file --tasks=path.json      # 批量（队列顺序执行）
 *   node tools/taskd.js status <id>                        # running/done/failed + 行数
 *   node tools/taskd.js wait <id> --timeout=100            # 窗口内等待后返回状态
 *   node tools/taskd.js daemon [--max-procs=2]             # 启动守护（spawn detached）
 *   node tools/taskd.js list                               # 全部任务状态
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const TASK_DIR = path.join(root, 'data', 'tasks');

const args = process.argv.slice(2);
const get = (k, d) => { const eq = args.find(a => a.startsWith(k + '=')); if (eq) return eq.slice(k.length + 1); const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const cmd = args[0];

function ensureDir() { fs.mkdirSync(TASK_DIR, { recursive: true }); }
function taskPath(id) { return path.join(TASK_DIR, id + '.json'); }
function logPath(id) { return path.join(TASK_DIR, id + '.log'); }
function donePath(id) { return path.join(TASK_DIR, id + '.done'); }

// ---------- 提交 ----------
function submit(task) {
  ensureDir();
  if (!task.id) { console.error('task.id 必填'); process.exit(1); }
  const p = taskPath(task.id);
  if (fs.existsSync(donePath(task.id))) {
    console.log('ALREADY_DONE ' + task.id);
    return;
  }
  task.createdAt = new Date().toISOString();
  task.status = 'queued';
  fs.writeFileSync(p, JSON.stringify(task));
  console.log('SUBMITTED ' + task.id);
}
function submitFile(f) {
  const tasks = JSON.parse(fs.readFileSync(path.resolve(root, f), 'utf8'));
  for (const t of tasks) submit(t);
}

// ---------- 守护进程 ----------
function runTask(task) {
  task.status = 'running';
  task.startedAt = new Date().toISOString();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task));
  const out = fs.openSync(logPath(task.id), 'a');
  const args0 = (task.args || []).map(a => String(a));
  const p = spawn(task.cmd, args0, { cwd: task.cwd || root, env: { ...process.env, ...(task.env || {}) }, stdio: ['ignore', out, out], windowsHide: true });
  const budget = task.budgetMs || 0;
  let killed = false;
  const timer = budget ? setTimeout(() => { killed = true; p.kill(); }, budget) : null;
  p.on('close', code => {
    if (timer) clearTimeout(timer);
    const d = { id: task.id, exit: code, killed, finishedAt: new Date().toISOString(), logBytes: fs.statSync(logPath(task.id)).size };
    fs.writeFileSync(donePath(task.id), JSON.stringify(d));
    task.status = killed ? 'killed' : (code === 0 ? 'done' : 'failed');
    fs.writeFileSync(taskPath(task.id), JSON.stringify(task));
    console.log('TASK_DONE ' + task.id + ' exit=' + code + (killed ? ' (budget-killed)' : ''));
  });
}
function daemon(maxProcs) {
  ensureDir();
  console.log('taskd daemon 启动（max-procs=' + maxProcs + '）');
  const loop = () => {
    const tasks = fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'));
    const running = tasks.filter(f => {
      try { const t = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8')); return t.status === 'running'; } catch (e) { return false; }
    }).length;
    if (running >= maxProcs) { setTimeout(loop, 3000); return; }
    // 找 queued
    let queued = null;
    for (const f of tasks) {
      try { const t = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8')); if (t.status === 'queued') { queued = t; break; } } catch (e) {}
    }
    if (!queued) { setTimeout(loop, 3000); return; }
    runTask(queued);
    setTimeout(loop, 500);
  };
  loop();
}

// ---------- 查询 ----------
function status(id) {
  const dp = donePath(id);
  if (fs.existsSync(dp)) {
    const d = JSON.parse(fs.readFileSync(dp, 'utf8'));
    const log = fs.existsSync(logPath(id)) ? fs.readFileSync(logPath(id), 'utf8') : '';
    console.log('STATUS ' + id + ' ' + (d.killed ? 'killed' : d.exit === 0 ? 'done' : 'failed') + ' exit=' + d.exit + ' logLines=' + log.split('\n').length);
    return;
  }
  const tp = taskPath(id);
  if (!fs.existsSync(tp)) { console.log('STATUS ' + id + ' not_found'); return; }
  const t = JSON.parse(fs.readFileSync(tp, 'utf8'));
  const log = fs.existsSync(logPath(id)) ? fs.readFileSync(logPath(id), 'utf8') : '';
  console.log('STATUS ' + id + ' ' + (t.status || 'queued') + ' logLines=' + log.split('\n').length);
}
function listAll() {
  ensureDir();
  const ids = fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  if (!ids.length) { console.log('（无任务）'); return; }
  for (const id of ids) status(id);
}
function wait(id, timeoutS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const dp = donePath(id);
    if (fs.existsSync(dp)) { status(id); return; }
    execFileSync('powershell', ['-Command', 'Start-Sleep -Milliseconds 5000'], { stdio: 'ignore' });
  }
  status(id);
}

// ---------- 分发 ----------
ensureDir();
switch (cmd) {
  case 'submit': {
    const t = {
      id: get('--id'),
      type: get('--type', 'shell'),
      cmd: get('--cmd', 'node'),
      args: (get('--args', '') || '').split('|').filter(Boolean),
      cwd: get('--cwd', root),
      env: Object.fromEntries((get('--env', '') || '').split(',').filter(Boolean).map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; })),
      budgetMs: parseInt(get('--budget', '0'), 10) || 0,
    };
    submit(t);
    break;
  }
  case 'submit-file': submitFile(get('--tasks')); break;
  case 'daemon': daemon(parseInt(get('--max-procs', '2'), 10)); break;
  case 'status': status(get('--id') || args[1]); break;
  case 'list': listAll(); break;
  case 'wait': wait(get('--id') || args[1], parseFloat(get('--timeout', '60'))); break;
  default:
    console.log('用法: submit | submit-file | daemon | status <id> | wait <id> | list');
    process.exit(1);
}
