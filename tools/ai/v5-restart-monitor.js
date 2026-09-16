'use strict';
/* tools/ai/v5-restart-monitor.js —— V5 B 系列重启信号监控
 * 检查 A1/A2/A3/A5 的关键产物是否存在并打印信号状态。
 * 用法：node tools/ai/v5-restart-monitor.js */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

function exists(p) { return fs.existsSync(path.join(root, p)); }
function readMeta(p) {
  try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch (e) { return null; }
}
/* 读取模型主评估口径：A2/A5 新产物写 meta.groupTestAUC；旧产物回退 testAUC */
function aucOf(p) {
  const m = readMeta(p);
  if (!m) return null;
  const cands = [m.meta && m.meta.groupTestAUC, m.global && m.global.testAUC, m.groupTestAUC, m.testAUC];
  for (const v of cands) if (typeof v === 'number') return v;
  return null;
}
function groupsOf(p) {
  const m = readMeta(p);
  return (m && m.meta && m.meta.gameGroups) || (m && m.gameGroups) || null;
}

const A2 = 'models/adaboost-vote-v3-v5.json';
const A5 = 'models/v5-pi-lab.json';
const checks = [
  { id: 'A1', name: '意图分类器生产模型', file: 'models/nlu-intent-nb.json', ok: exists('models/nlu-intent-nb.json'), note: '已替换生产（5 折 macro AUC 0.7506）' },
  { id: 'A2', name: 'v3v3 投票模型（intent21）', file: A2, ok: exists(A2), note: () => `${groupsOf(A2) || '?'} 局 lab；按对局分组 AUC ${aucOf(A2)}（base13 消融 0.7050）` },
  { id: 'A3', name: '意图价值模型（合成通路）', file: 'models/value-hicvn-v4-intent.json', ok: exists('models/value-hicvn-v4-intent.json'), note: '38 维通路验证，非质量证据' },
  { id: 'A3r', name: '意图价值模型（lab 真实状态）', file: 'models/value-hicvn-v4-intent-real.json', ok: exists('models/value-hicvn-v4-intent-real.json'), note: () => { const m = readMeta('models/value-hicvn-v4-intent-real.json'); const g = m && m.meta && m.meta.groupTestAUC; return g ? `1500 局真实状态：base33 ${g.base33} / intent38 ${g.intent38}（值层无稳定增益，默认关）` : '真实状态对照'; } },
  { id: 'A5', name: 'π 意图版模型（intent21）', file: A5, ok: exists(A5), note: () => `${groupsOf(A5) || '?'} 局 lab；按对局分组 AUC ${aucOf(A5)}（base13 消融 0.7618）` },
];

let missing = 0, ready = 0;
console.log('V5 重启信号监控');
console.log('================');
for (const c of checks) {
  const note = typeof c.note === 'function' ? c.note() : c.note;
  const mark = c.ok ? '✅' : '❌';
  console.log(`${mark} ${c.id} ${c.name}: ${c.file}${c.ok ? ' 存在' : ' 缺失'}（${note}）`);
  if (!c.ok) missing++; else if (c.id === 'A2' || c.id === 'A5') ready++;
}
console.log('----------------');
console.log('B2 多样化池重启条件：意图特征已带来 A2/A5 同口径 +0.10 级增益 → lab 级达标；真人局策略分化待线上采集');
console.log('B3 新信息源后重启：A1/A2/A5 产物就绪，A3 值层意图增益未证实 → 不因 A3 单独重启 PPO');
console.log(`缺失项：${missing}；可重启信号：${ready > 0 ? '部分出现（lab 级；真人局数据缺口未消）' : '未出现'}`);
