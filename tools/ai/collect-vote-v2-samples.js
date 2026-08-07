'use strict';
/* =========================================================================
 * collect-vote-v2-samples.js —— vote-v2 训练样本采集（1.7.16）
 *  - LAB_AUDIT_VOTE=1 埋点（bot-brain 已实现）→ 记录每投票决策 {v, f, mp, s, tIsWolf}
 *  - 本脚本逐局跑（虚拟时钟）→ 落盘 {gameId, f(13维), tIsWolf} 按局分组
 *    （group-wise 评估需要局 id；训练/验证/测试按局划分，杜绝同局样本跨集）
 *  - 用法: node tools/ai/collect-vote-v2-samples.js [--presets=7,8,...] [--games=1500] [--out=data/vote-v2]
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
process.env.LAB_AUDIT_VOTE = '1';
process.env.WOLF_CLAIM_GOD = '0';
require(path.join(root, 'server/clock.js')).setMode('virtual');
const { runOneLabGame } = require(path.join(root, 'test/lab/core/room-runner.js'));
const { PRESETS } = require(path.join(root, 'test/lab/presets.js'));

const args = process.argv.slice(2);
const get = (k, d) => { const eq = args.find(a => a.startsWith(k + '=')); if (eq) return eq.slice(k.length + 1); const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const presetsArg = (get('--presets', '7') || '7').split(',').map(Number);
const games = parseInt(get('--games', '1500'), 10);
const outDir = path.resolve(root, get('--out', 'data/vote-v2'));
fs.mkdirSync(outDir, { recursive: true });

const TAGS = { 0: '4p', 1: '6p', 2: '8p', 3: '9a', 6: '9d', 7: '12a', 8: '12b', 10: '12d', 15: '15p' };

(async () => {
  for (const pi of presetsArg) {
    const p = PRESETS[pi];
    const tag = TAGS[pi] || ('p' + pi);
    const file = path.join(outDir, tag + '.jsonl');
    const lines = [];
    const t0 = Date.now();
    console.log(`[collect] ${tag}（cap=${p.cap}）: ${games} 局开始...`);
    for (let i = 0; i < games; i++) {
      const prev = global._voteAudit ? global._voteAudit.length : 0;
      await runOneLabGame({ cap: p.cap, counts: p.counts, winMode: p.winMode,
        botLine: Array(Math.max(1, p.cap - 1)).fill('smart'), name: p.name,
        seed: `vv2-${tag}-${i}`, gameId: `${tag}-${i}` });
      const audit = global._voteAudit || [];
      for (let k = prev; k < audit.length; k++) {
        const a = audit[k];
        if (a.useModel && a.mp != null) lines.push(JSON.stringify({ gameId: `${tag}-${i}`, f: a.f, tIsWolf: a.tIsWolf ? 1 : 0 }));
      }
    }
    fs.writeFileSync(file, lines.join('\n'));
    console.log(`[collect] ${tag}: ${games} 局 / ${lines.length} 决策点 -> ${file}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  }
  console.log('[collect] 全部完成');
})().catch(e => { console.error(e.message); process.exit(1); });
