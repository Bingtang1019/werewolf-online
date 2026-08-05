'use strict';
/* 报告（纯函数）：records → 可 JSON 序列化的报告对象（console/对比/落盘共用） */
const { wilsonCI } = require('./wilson');

function summarize(records) {
  const valid = records.filter(r => !r.result.timeout && !r.result.error);
  const n = valid.length;
  const errors = {};
  records.forEach(r => { if (r.result.error) { const k = r.result.error.kind || 'unknown'; errors[k] = (errors[k] || 0) + 1; } });
  const camps = {};
  records.forEach(r => { if (r.result.winner) camps[r.result.winner] = (camps[r.result.winner] || 0) + 1; });
  const campReport = {};
  for (const [c, k] of Object.entries(camps)) campReport[c] = { wins: k, n, pct: k / n, ci: wilsonCI(k, n) };
  const firstKill = {};
  records.forEach(r => { if (r.firstKill && r.firstKill.camp) firstKill[r.firstKill.camp] = (firstKill[r.firstKill.camp] || 0) + 1; });
  const durs = valid.map(r => r.durMs);
  return {
    total: records.length, valid: n,
    errors, // {kind: count} —— config/engine/stall 分开计，一跑就知道该查谁
    timeouts: records.filter(r => r.result.timeout && !r.result.error).length,
    camps: campReport, firstKill,
    avgDurMs: durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : 0,
  };
}
module.exports = { summarize };
