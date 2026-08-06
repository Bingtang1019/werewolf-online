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
module.exports = { summarize, createStreamStats };

/* 流式胜率统计（v1.7.6 第二部分）：O(1) 内存——万局级 records 全量收集 ~1GB，流式边收边算。
 * 按 config.cap 自动分组（byCap，矩阵场景）；result() 结构兼容 summarize（多一个 byCap）。
 * 用法：const st = createStreamStats(); st.add(rec); const s = st.result(); */
function createStreamStats() {
  const mkInner = () => ({ total: 0, valid: 0, timeout: 0, durSum: 0, camps: {}, firstKill: {} });
  const all = mkInner();
  const byCap = {};
  const addTo = (b, r) => {
    b.total++;
    const err = r.result && r.result.error;
    if (err) { /* errors 仅全局记 */ }
    else if (r.result && r.result.timeout) b.timeout++;
    else { b.valid++; b.durSum += r.durMs || 0; }
    if (r.result && r.result.winner) b.camps[r.result.winner] = (b.camps[r.result.winner] || 0) + 1;
    if (r.firstKill && r.firstKill.camp) b.firstKill[r.firstKill.camp] = (b.firstKill[r.firstKill.camp] || 0) + 1;
  };
  const errors = {};
  return {
    add(r) {
      addTo(all, r);
      const cap = r.config && r.config.cap != null ? r.config.cap : null;
      if (cap != null) { if (!byCap[cap]) byCap[cap] = mkInner(); addTo(byCap[cap], r); }
      if (r.result && r.result.error) { const k = r.result.error.kind || 'unknown'; errors[k] = (errors[k] || 0) + 1; }
    },
    result() {
      const fin = b => {
        const campReport = {};
        for (const [c, k] of Object.entries(b.camps)) campReport[c] = { wins: k, n: b.valid, pct: b.valid ? k / b.valid : 0, ci: wilsonCI(k, b.valid) };
        return { total: b.total, valid: b.valid, timeouts: b.timeout, camps: campReport, firstKill: b.firstKill, avgDurMs: b.valid ? b.durSum / b.valid : 0 };
      };
      const capOut = {};
      for (const [c, b] of Object.entries(byCap)) capOut[c] = fin(b);
      return Object.assign(fin(all), { errors, byCap: capOut });
    },
  };
}
