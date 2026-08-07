'use strict';
/**
 * fit-value-v4.js — HiCVN V4.0 backbone experiment (GBDT vs MLP) + built-in audit.
 * 用法：
 *   node server/ai/fit-value-v4.js --out models/value-hicvn-v1.json
 *   [--records data/records-v4] [--pool data/records-pool] [--random-ratio 0.10]
 *   [--model gbdt|mlp] [--with-frac] [--members 4]
 *   [--trees 200] [--depth 3] [--hidden 128] [--epochs 20] [--seed 42] [--holdout 0.2]
 *   [--only-configs 4p] [--quick]
 *
 * 纪律（教训固化）：
 *   - records-v4 的 holdout 划分与 V3.1/v31-audit 同序同 LCG（seed=42 按局 rnd<holdout）
 *     → 同测试集归因公平（v31-audit 可复现同一 test 集）
 *   - pool 数据（多生态）接在同一 LCG 流后——生态分层自然满足（每池约 20% 进 test）
 *   - random 池按 --random-ratio 独立 LCG 抽局（V3.1 矩阵：全 random 有害，小比例做正则）
 *   - 评估 pre-only（排除终局 post 平凡特征，v1.7.12 红旗口径）；训练用全部节点
 *   - 输出 = 模型 + 内建验收报告（同文件 meta + 独立 audit JSON）
 */
const fs = require('fs');
const path = require('path');
const { rebuildEventStates, eventsToDays, auc, calibration } = require('./fit-value-v3');
const vm = require('./value-model'); // V3.1 推理（同测试集归因）
const { GBDT } = require('./gbdt');
const { MLP } = require('./mlp');

const root = path.join(__dirname, '..', '..');

/* ---------------- V4 特征（低层语义，bias 由模型自带；3frac 默认不手工给——模型自学习组合） ---------------- */
const FEAT_V4 = ['r_wolfFrac', 's_godFrac', 'T_alive', 'cap', 'r*s', 'wolfAlive', 'godAlive', 'villAlive', 'wolf0', 'god0', 'vill0'];
const FEAT_V4_FRAC = ['r_wolfFrac', 's_godFrac', 'T_alive', 'wolfDeadFrac', 'godDeadFrac', 'villDeadFrac', 'cap', 'r*s', 'wolfAlive', 'godAlive', 'villAlive', 'wolf0', 'god0', 'vill0'];
function buildX(s, withFrac, cfgVec, infoFeats) {
  const T = (s.R + s.S + s.M) || 1;
  const r = s.R / T, sg = s.S / T;
  let x;
  if (withFrac) {
    const wd = s.wolf0 > 0 ? (s.wolf0 - s.R) / s.wolf0 : 0;
    const gd = s.god0 > 0 ? (s.god0 - s.S) / s.god0 : 0;
    const vd = s.vill0 > 0 ? (s.vill0 - s.M) / s.vill0 : 0;
    x = [r, sg, T, wd, gd, vd, s.cap || T, r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
  } else {
    x = [r, sg, T, s.cap || T, r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
  }
  if (cfgVec) for (let i = 0; i < cfgVec.length; i++) x.push(cfgVec[i]);
  if (infoFeats && s.info) {
    x.push(s.info.checkedWolves, s.info.checkedCount, s.info.seerAlive, s.info.lastExileWasWolf);
  }
  return x;
}

/* ---------------- V4.2 信息特征（records-v5 含 seerHistory；信息状态按 day 对齐） ---------------- */
/** 训练侧信息特征：pre 时刻 = 第 di 天投票前的真实信息（查验 night ≤ di 已发生、上一轮放逐、预言家存活）。
 *  speech 未启用：推理端 speechToday 是实时累加器、训练端只有前日结算事件——语义不同源（A-2 降级）。 */
const INFO_FEATS = ['checkedWolves', 'checkedCount', 'seerAlive', 'lastExileWasWolf'];
function rebuildEventStatesV5(rec) {
  const { days, players } = eventsToDays(rec);
  const cap = players.length;
  const roles = players.map(p => vm.classifyRole(p.roleKey || p.role || p.roleName));
  let wolf0 = 0, god0 = 0, vill0 = 0;
  for (const r of roles) { if (r === 'wolf') wolf0++; else if (r === 'god') god0++; else if (r === 'vill') vill0++; }
  const idx = new Map(players.map((p, i) => [p.id, i]));
  const alive = players.map(() => true);
  const kill = id => { const i = idx.get(id); if (i != null) alive[i] = false; };
  const count = () => {
    let R = 0, S = 0, M = 0;
    for (let i = 0; i < players.length; i++) {
      if (!alive[i]) continue;
      const r = roles[i];
      if (r === 'wolf') R++; else if (r === 'god') S++; else if (r === 'vill') M++;
    }
    return { R, S, M, N: cap - R - S - M, cap, wolf0, god0, vill0 };
  };
  const seerHist = rec.seerHistory || []; // [{target, result:'good'|'wolf', night}]——records-v5；旧数据无 → []
  const seerIdxOf = (() => { const q = players.find(p => String(p.roleKey || '').toLowerCase().includes('seer')); return q ? idx.get(q.id) : null; })();
  let lastExileWasWolf = 0;
  const nodes = [];
  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    if (Array.isArray(day.nightDeaths)) for (const id of day.nightDeaths) kill(id);
    if (day.lynched != null) {
      let cw = 0, cc = 0;
      for (const h of seerHist) if (h.night <= di) { cc++; if (h.result === 'wolf') cw++; }
      const seerAlive = seerIdxOf != null && alive[seerIdxOf] ? 1 : 0;
      const preInfo = { checkedWolves: cw, checkedCount: cc, seerAlive, lastExileWasWolf };
      nodes.push({ ...count(), phase: 'pre', info: preInfo });
      const larr = Array.isArray(day.lynched) ? day.lynched : [day.lynched];
      for (const id of larr) kill(id);
      const thisExileWolf = larr.some(id => { const i = idx.get(id); return i != null && roles[i] === 'wolf'; }) ? 1 : 0;
      nodes.push({ ...count(), phase: 'post', info: { ...preInfo, lastExileWasWolf: thisExileWolf } });
      lastExileWasWolf = thisExileWolf;
    }
  }
  return nodes;
}

/* ---------------- io ---------------- */
function loadDir(dir, eco) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  const files = st.isDirectory()
    ? fs.readdirSync(dir).filter(f => /\.jsonl$/.test(f)).map(f => path.join(dir, f))
    : [dir];
  for (const f of files) {
    const tag = path.basename(f).replace(/\.jsonl$/, '');
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec.events && rec.result && rec.result.winner) out.push({ rec, tag, eco });
      } catch (e) {}
    }
  }
  return out;
}
function configKeyOf(rec, tag) {
  // 教训：records-v4 的 jsonl 用 presetKey（如 "12a"），fit-value-v3 靠 loadRecords 强制注入 preset；
  // 本脚本直读原始 JSON——presetKey 必须显式兜底，否则 12a-12h/9a-9d 全部合并为 cap 级（12p），preset 级评估静默失效
  if (rec.config && rec.config.preset) return rec.config.preset;
  if (rec.config && rec.config.presetKey) return rec.config.presetKey;
  const cap = rec.config && rec.config.cap ? rec.config.cap : (rec.players || []).length;
  if (cap) return cap + 'p';
  return tag;
}
function capKeyOf(cfg) { return ((cfg.match(/\d+/) || [''])[0]) + 'p'; }
function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); if (i >= 0) return a[i + 1]; const p = a.find(x => x.startsWith(k + '=')); return p ? p.slice(k.length + 1) : d; };
  return {
    records: get('--records', path.join(root, 'data', 'records-v4')),
    pool: get('--pool', path.join(root, 'data', 'records-pool')),
    randomRatio: parseFloat(get('--random-ratio', '0.10')),
    infoFeats: a.includes('--info-feats'), // V4.2：信息特征（checkedWolves/checkedCount/seerAlive/lastExileWasWolf）
    out: get('--out', path.join(root, 'models', 'value-hicvn-v1.json')),
    auditOut: get('--audit-out', path.join(root, 'models', 'value-hicvn-v1-audit.json')),
    model: get('--model', 'gbdt'),
    withFrac: a.includes('--with-frac'),
    members: parseInt(get('--members', '4'), 10),
    trees: parseInt(get('--trees', '200'), 10),
    depth: parseInt(get('--depth', '3'), 10),
    hidden: parseInt(get('--hidden', '128'), 10),
    epochs: parseInt(get('--epochs', '20'), 10),
    seed: parseInt(get('--seed', '42'), 10),
    holdout: parseFloat(get('--holdout', '0.2')),
    onlyCfg: get('--only-configs', ''),
    quick: a.includes('--quick'),
    // V4.1 配置条件化：--stratify 配置等权采样（根治大配置主导）；--config-cond 配置 one-hot 特征（12d 等特殊配置显式编码）
    stratify: a.includes('--stratify'),
    configCond: a.includes('--config-cond'),
    stratifyK: parseInt(get('--stratify-k', '2000'), 10),
  };
}

/* ---------------- 集成预测 ---------------- */
function predictEnsemble(members, x) {
  let s = 0;
  for (const m of members) s += m.predict(x);
  return s / members.length;
}
function sigmaEnsemble(members, x) {
  const vs = members.map(m => m.predict(x));
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  return Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
}

/* ---------------- 局级 bootstrap CI（确定性 LCG，预分组加速） ---------------- */
function bootCI(items, nBoot = 200) {
  const byGame = new Map();
  for (const it of items) {
    let arr = byGame.get(it.gameId);
    if (!arr) byGame.set(it.gameId, arr = []);
    arr.push(it);
  }
  const gids = [...byGame.keys()];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const aucs = [];
  for (let b = 0; b < nBoot; b++) {
    const ys = [], vs = [];
    for (let i = 0; i < gids.length; i++) {
      const g = gids[Math.floor(rnd() * gids.length)];
      for (const it of byGame.get(g)) { ys.push(it.y); vs.push(it.v); }
    }
    if (ys.length >= 4) aucs.push(auc(ys, vs));
  }
  aucs.sort((a, b) => a - b);
  const lo = aucs[Math.floor(0.025 * aucs.length)], hi = aucs[Math.floor(0.975 * aucs.length)];
  return [lo, hi];
}

/* ---------------- main ---------------- */
function main() {
  const opt = parseArgs();
  console.log(`[v4] model=${opt.model} featureSet=${opt.withFrac ? 'v4-frac' : 'v4'} members=${opt.members} quick=${opt.quick}`);

  /* ---- 数据加载：records-v4（v2 生态）+ pool（v1iso/v1raw/random） ---- */
  let v4 = loadDir(opt.records, 'v2');
  let pool = loadDir(opt.pool, null);
  // random 池按比例抽局（独立 LCG，确定性）——注意：此刻 eco 尚未赋值（行下），必须用 tag 判定
  let rs = 7;
  const rrnd = () => (rs = (rs * 1103515245 + 12345) % 2147483648) / 2147483648;
  pool = pool.filter(r => r.tag !== 'random' || rrnd() < opt.randomRatio);
  for (const r of pool) r.eco = r.tag; // v1iso / v1raw / random
  if (opt.onlyCfg) {
    const set = new Set(String(opt.onlyCfg).split(',').map(s => s.trim()));
    v4 = v4.filter(r => set.has(configKeyOf(r.rec, r.tag)));
    pool = pool.filter(r => set.has(configKeyOf(r.rec, r.tag))); // 冒烟时 pool 同样过滤，防污染
  }
  const all = v4.concat(pool);
  console.log(`[v4] records-v4=${v4.length} pool=${pool.length}（eco: ${[...new Set(pool.map(r => r.eco))].join('/')}）`);

  /* ---- 划分：records-v4 同序同 LCG（与 v31-audit 一致），pool 接同一流 ---- */
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const r of v4) r.split = rnd() < opt.holdout ? 'test' : 'train';
  for (const r of pool) r.split = rnd() < opt.holdout ? 'test' : 'train';

  /* ---- 样本构建：全部节点（训练），pre-only（评估） ---- */
  const rows = [];
  for (const r of all) {
    const states = opt.infoFeats ? rebuildEventStatesV5(r.rec) : rebuildEventStates(r.rec);
    if (!states.length) continue;
    const y = String(r.rec.result.winner).toLowerCase().includes('good') ? 1 : 0;
    rows.push({
      states, y, cfg: configKeyOf(r.rec, r.tag), eco: r.eco, split: r.split,
      gameId: r.rec.gameId || r.rec.id || `${r.tag}-${rows.length}`,
    });
  }
  const trainRows = rows.filter(r => r.split === 'train');
  const testRows = rows.filter(r => r.split === 'test');
  console.log(`[v4] games=${rows.length} train=${trainRows.length} test=${testRows.length}`);
  const ecoSplit = {};
  for (const eco of [...new Set(rows.map(r => r.eco))]) {
    const rs_ = rows.filter(r => r.eco === eco);
    ecoSplit[eco] = { train: rs_.filter(r => r.split === 'train').length, test: rs_.filter(r => r.split === 'test').length };
  }
  console.log('[v4] eco split:', JSON.stringify(ecoSplit));

  /* ---- V4.1 配置条件化：one-hot 字典（train 集）+ 配置等权分组 ---- */
  const cfgIdx = new Map();
  if (opt.configCond || opt.stratify) for (const r of trainRows) if (!cfgIdx.has(r.cfg)) cfgIdx.set(r.cfg, cfgIdx.size);
  const nCfg = cfgIdx.size;
  const cfgVecOf = (cfg) => { const v = new Array(nCfg).fill(0); const i = cfgIdx.get(cfg); if (i != null) v[i] = 1; return v; };
  let stratifyGroups = null;
  if (opt.stratify && nCfg > 1) {
    stratifyGroups = Array.from({ length: nCfg }, () => []);
    trainRows.forEach((r, i) => { const g = cfgIdx.get(r.cfg); if (g != null) stratifyGroups[g].push(i); });
    stratifyGroups = stratifyGroups.filter(g => g.length > 0);
    console.log(`[v4] V4.1: stratify groups=${stratifyGroups.length}（per-epoch per-group k=${Math.min(opt.stratifyK, ...stratifyGroups.map(g => g.length))}）`);
  }
  console.log(`[v4] V4.1: configCond=${opt.configCond} nCfg=${nCfg} stratify=${!!stratifyGroups}`);

  /* ---- 训练样本矩阵（cfgOfSample：每样本所属配置——σ bootstrap 重建分层组的依据） ---- */
  const trainX = [], trainY = [], cfgOfSample = [];
  for (const r of trainRows) { const cv = opt.configCond ? cfgVecOf(r.cfg) : null; for (const s of r.states) { trainX.push(buildX(s, opt.withFrac, cv, opt.infoFeats)); trainY.push(r.y); cfgOfSample.push(r.cfg); } }
  // val（MLP 早停）：train 内按局抽 5%（独立 LCG seed=43）
  let vs = 43;
  const vrnd = () => (vs = (vs * 1103515245 + 12345) % 2147483648) / 2147483648;
  const valX = [], valY = [];
  for (const r of trainRows) {
    if (vrnd() < 0.05) { const cv = opt.configCond ? cfgVecOf(r.cfg) : null; for (const s of r.states) { valX.push(buildX(s, opt.withFrac, cv, opt.infoFeats)); valY.push(r.y); } }
  }
  console.log(`[v4] train samples=${trainX.length} val samples=${valX.length}`);

  /* ---- 骨干训练（多成员深度集成） ---- */
  const members = [];
  const t0 = Date.now();
  /* per-member bootstrap：全量有放回重采样（每成员独立 LCG seed）→ bootX/bootY + 按 cfgOfSample 重建分层组
     ——根治成员同质（std=0）→ σ 有区分度；bootstrap 与 stratify 正交（组内等量采样仍由 mlp/gbdt 内部做） */
  const bootSample = (k) => {
    let bs = opt.seed + k * 1000 + 7;
    const brnd = () => (bs = (bs * 1103515245 + 12345) % 2147483648) / 2147483648;
    const nT = trainX.length;
    const bootX = new Array(nT), bootY = new Array(nT);
    const bGroups = stratifyGroups ? Array.from({ length: stratifyGroups.length }, () => []) : null;
    for (let i = 0; i < nT; i++) {
      const j = Math.floor(brnd() * nT);
      bootX[i] = trainX[j]; bootY[i] = trainY[j];
      if (bGroups) { const g = cfgIdx.get(cfgOfSample[j]); if (g != null) bGroups[g].push(i); }
    }
    return { bootX, bootY, bGroups: bGroups ? bGroups.filter(g => g.length > 0) : stratifyGroups };
  };
  if (opt.model === 'gbdt') {
    for (let k = 0; k < opt.members; k++) {
      const { bootX, bootY, bGroups } = bootSample(k);
      const g = new GBDT({
        trees: opt.quick ? 60 : opt.trees, depth: opt.depth, lr: 0.1, minLeaf: opt.quick ? 20 : 50,
        subsample: 0.9, // V4.1: 成员多样性（修正成员 std=0——subsample=1 时 4 成员完全相同，σ 校准失效）
        seed: opt.seed + k * 100,
      });
      g.fit(bootX, bootY, bGroups);
      members.push(g);
      console.log(`[v4] gbdt member ${k + 1}/${opt.members} done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  } else {
    for (let k = 0; k < opt.members; k++) {
      const { bootX, bootY, bGroups } = bootSample(k);
      const m = new MLP({
        hidden: opt.hidden, epochs: opt.quick ? 5 : opt.epochs, lr: 1e-3, batch: 256, l2: 1e-4,
        seed: opt.seed + k * 100,
      });
      m.fit(bootX, bootY, valX, valY, bGroups);
      members.push(m);
      console.log(`[v4] mlp member ${k + 1}/${opt.members} done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }
  console.log(`[v4] training done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* ---- test 评估（pre-only）：V4 vs V3.1 同集归因 + σ ---- */
  const byCfg = new Map();
  for (const r of testRows) {
    for (const s of r.states) {
      if (s.phase !== 'pre') continue;
      const x = buildX(s, opt.withFrac, opt.configCond ? cfgVecOf(r.cfg) : null, opt.infoFeats);
      const s15 = { R: s.R, S: s.S, M: s.M, N: s.N, cap: s.cap, wolf0: s.wolf0, god0: s.god0, vill0: s.vill0 };
      const v = predictEnsemble(members, x);
      const v31 = vm.value(s15, r.cfg);
      const sg = sigmaEnsemble(members, x);
      if (!byCfg.has(r.cfg)) byCfg.set(r.cfg, []);
      byCfg.get(r.cfg).push({ v, v31, y: r.y, gameId: r.gameId, sigma: sg, eco: r.eco });
    }
  }

  const cfgs = [...byCfg.keys()].sort();
  const eqAucV4 = [], eqAucV31 = [];
  const perConfig = {};
  console.log('\n配置    n(样本)  n(局)   V4 AUC    局级CI95       V3.1同集AUC   校准max偏差');
  for (const cfg of cfgs) {
    const items = byCfg.get(cfg);
    const n = items.length, games = new Set(items.map(i => i.gameId)).size;
    const a4 = auc(items.map(i => i.y), items.map(i => i.v));
    const a31 = auc(items.map(i => i.y), items.map(i => i.v31));
    eqAucV4.push(a4); eqAucV31.push(a31);
    const [lo, hi] = bootCI(items);
    const cal = calibration(items.map(i => i.y), items.map(i => i.v), 5);
    const maxDev = Math.max(...cal.map(c => Math.abs(c.meanV - c.actual)));
    perConfig[cfg] = {
      auc: +a4.toFixed(4), aucCI: [+lo.toFixed(4), +hi.toFixed(4)], n, games,
      v31Auc: +a31.toFixed(4), maxCalibDev: +maxDev.toFixed(4),
      calibration: cal, vStats: { min: +Math.min(...items.map(i => i.v)).toFixed(4), max: +Math.max(...items.map(i => i.v)).toFixed(4) },
    };
    console.log(`${cfg.padEnd(5)} ${String(n).padEnd(9)} ${String(games).padEnd(7)} ${a4.toFixed(4).padStart(7)}   [${lo.toFixed(3)},${hi.toFixed(3)}]   ${a31.toFixed(4).padStart(9)}   ${maxDev.toFixed(4).padStart(8)}`);
  }
  const eqV4 = eqAucV4.reduce((a, b) => a + b, 0) / Math.max(1, eqAucV4.length);
  const eqV31 = eqAucV31.reduce((a, b) => a + b, 0) / Math.max(1, eqAucV31.length);
  const gain = eqV4 - eqV31;
  console.log(`\n配置等权: V4=${eqV4.toFixed(4)}  V3.1同集=${eqV31.toFixed(4)}  → 提升=${gain.toFixed(4)}`);

  /* ---- 生态分解 ---- */
  const byEco = new Map();
  for (const cfg of cfgs) for (const it of byCfg.get(cfg)) {
    if (!byEco.has(it.eco)) byEco.set(it.eco, []);
    byEco.get(it.eco).push(it);
  }
  const ecoAuc = {};
  for (const [eco, items] of byEco) {
    ecoAuc[eco] = { auc: +auc(items.map(i => i.y), items.map(i => i.v)).toFixed(4), n: items.length };
    console.log(`[v4] eco ${eco}: AUC ${ecoAuc[eco].auc} (n=${items.length})`);
  }

  /* ---- 分层报告：局内 |meanV − 0.5|（V4 概率语义，0.5 为中心；教训：不同配置的 gameId 可能重复——key 必须带 cfg 前缀） ---- */
  const byGame = new Map();
  for (const cfg of cfgs) for (const it of byCfg.get(cfg)) {
    const gk = cfg + ':' + it.gameId;
    if (!byGame.has(gk)) byGame.set(gk, []);
    byGame.get(gk).push(it);
  }
  const layers = { balanced: [], mid: [], extreme: [] };
  for (const [gid, items] of byGame) {
    const meanV = items.reduce((a, b) => a + b.v, 0) / items.length;
    const dev = Math.abs(meanV - 0.5);
    const key = dev < 0.1 ? 'balanced' : dev < 0.25 ? 'mid' : 'extreme';
    layers[key].push(...items);
  }
  const layered = {};
  for (const [k, items] of Object.entries(layers)) {
    layered[k] = { auc: +auc(items.map(i => i.y), items.map(i => i.v)).toFixed(4), n: items.length };
    console.log(`[v4] layer ${k.padEnd(8)}: AUC ${layered[k].auc} (n=${items.length})`);
  }

  /* ---- σ 校准层：val 批拟合 scale（coverage80→0.8）→ test 批分桶单调验收 ---- */
  // val 批独立于 test；早停已用 val AUC，scale 同用 val——双重使用可接受（标注）
  const valSigma = [], valMean = [];
  for (let i = 0; i < valX.length; i++) {
    const mvs = members.map(mem => mem.predict(valX[i]));
    const mu = mvs.reduce((a, b) => a + b, 0) / mvs.length;
    const sd = Math.sqrt(mvs.reduce((a, b) => a + (b - mu) ** 2, 0) / mvs.length);
    valSigma.push(sd); valMean.push(mu);
  }
  const coverageAt = (s) => { let hit = 0; for (let i = 0; i < valX.length; i++) if (Math.abs(valMean[i] - valY[i]) <= 1.28 * s * valSigma[i]) hit++; return hit / Math.max(1, valX.length); };
  let slo = 0, shi = 200;
  for (let it = 0; it < 60; it++) { const mid = (slo + shi) / 2; if (coverageAt(mid) > 0.8) shi = mid; else slo = mid; }
  const sigmaScale = +(((slo + shi) / 2).toFixed(4)) || 1;
  console.log(`[v4] sigma scale fitted: ${sigmaScale}（val coverage80=${coverageAt(sigmaScale).toFixed(3)}）`);

  /* ---- σ 校准：按 scale 后 std 分 5 桶 → 80% CI 覆盖率（单调验收：coverage 须随 σ 递增） ---- */
  const allItems = [];
  for (const cfg of cfgs) allItems.push(...byCfg.get(cfg));
  const sorted = [...allItems].sort((a, b) => a.sigma - b.sigma);
  const per = Math.ceil(sorted.length / 5);
  const sigmaCal = [];
  for (let b = 0; b < 5; b++) {
    const slice = sorted.slice(b * per, Math.min(sorted.length, (b + 1) * per));
    if (!slice.length) continue;
    let cov = 0, meanS = 0;
    for (const it of slice) { meanS += it.sigma; if (Math.abs(it.v - it.y) <= 1.28 * sigmaScale * it.sigma) cov++; }
    sigmaCal.push({ bucket: b + 1, n: slice.length, meanSigma: +(meanS / slice.length).toFixed(4), coverage80: +(cov / slice.length).toFixed(3) });
  }
  const sigmaMonotonic = sigmaCal.every((c, i) => i === 0 || c.coverage80 >= sigmaCal[i - 1].coverage80 - 0.05);
  console.log('[v4] sigma calibration (after scale, ideal ~0.80, monotonic):', JSON.stringify(sigmaCal), 'monotonic=', sigmaMonotonic);

  /* ---- payoffScale（train 集 ΔV std，preset 级 + cap 级；sigmoid 语义下 Δ 幅度小 → scale 反放大） ---- */
  const dByCfg = new Map(), dByCap = new Map();
  for (const r of trainRows) {
    for (let i = 1; i < r.states.length; i++) {
      const x1 = buildX(r.states[i - 1], opt.withFrac, opt.configCond ? cfgVecOf(r.cfg) : null, opt.infoFeats);
      const x2 = buildX(r.states[i], opt.withFrac, opt.configCond ? cfgVecOf(r.cfg) : null, opt.infoFeats);
      const d = predictEnsemble(members, x2) - predictEnsemble(members, x1);
      if (!dByCfg.has(r.cfg)) dByCfg.set(r.cfg, []);
      dByCfg.get(r.cfg).push(d);
      const ck = capKeyOf(r.cfg);
      if (!dByCap.has(ck)) dByCap.set(ck, []);
      dByCap.get(ck).push(d);
    }
  }
  const payoffScale = {};
  for (const [cfg, ds] of dByCfg) {
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
    payoffScale[cfg] = +(1 / (sd || 1)).toFixed(3);
  }
  for (const [ck, ds] of dByCap) {
    if (payoffScale[ck]) continue;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
    payoffScale[ck] = +(1 / (sd || 1)).toFixed(3);
  }
  console.log('[v4] payoffScale:', JSON.stringify(payoffScale));

  /* ---- 决策门：同集归因（主判据）vs V3.1 + 绝对参考 0.7843（独立批，报告项） ---- */
  const gate = {
    vsV31SameSet: +gain.toFixed(4),
    passVsV31: gain >= 0.02,
    absEqAuc: +eqV4.toFixed(4),
    ref7843: 0.7843,
    passVs7843: eqV4 >= 0.8043,
    note: '主判据 = 同测试集 V4 − V3.1 ≥ +0.02；0.7843 为 V3.1 独立校准批等权 AUC（分布不同，仅报告）',
  };
  console.log('[v4] decision gate:', JSON.stringify(gate));

  /* ---- 模型 + 验收报告输出 ---- */
  const model = {
    schema: 'value-hicvn@1',
    architecture: 'hicvn-v4.2',
    backbone: opt.model,
    featureSet: (opt.withFrac ? 'v4-frac' : 'v4') + (opt.infoFeats ? '-info' : ''),
    cfgKeys: opt.configCond ? [...cfgIdx.keys()] : null, // V4.1 部署缺口修复：推理端 one-hot 构造依据
    features: (opt.withFrac ? FEAT_V4_FRAC : FEAT_V4)
      .concat(opt.configCond ? [...cfgIdx.keys()] : [])
      .concat(opt.infoFeats ? INFO_FEATS : []),
    members: members.map(m => m.toJSON()),
    payoffScale,
    perConfig,
    meta: {
      trainedAt: new Date().toISOString(),
      trainGames: trainRows.length, testGames: testRows.length,
      trainStates: trainRows.reduce((s, r) => s + r.states.length, 0),
      configEqualAUC: +eqV4.toFixed(4),
      v31SameSetAUC: +eqV31.toFixed(4),
      gate,
      ecoSplit,
      sigmaScale,
      sigmaMonotonic,
      evalScope: 'pre-only (excludes terminal post nodes, v1.7.12 红旗口径)',
      replaces: 'value-vote-v31.json (V3.1，原名 value-vote-v4.json)',
      note: 'V(s) = P(终局好人胜 | s) ∈ [0,1] — sigmoid/clip 语义；payoff = ΔV × payoffScale[config]；σ = 集成成员 std',
      note2: '3frac 默认不手工给（模型自学习组合）；--with-frac 消融对比；random 池按 random-ratio 抽局',
      infoFeats: opt.infoFeats, // V4.2：信息特征启用（checkedWolves/checkedCount/seerAlive/lastExileWasWolf）
    },
  };
  fs.writeFileSync(opt.out, JSON.stringify(model, null, 2));
  console.log(`[v4] saved model to ${opt.out}`);

  const audit = { gate, perConfig, ecoAuc, layered, sigmaCal, payoffScale, meta: model.meta };
  fs.writeFileSync(opt.auditOut, JSON.stringify(audit, null, 2));
  console.log(`[v4] saved audit to ${opt.auditOut}`);
  return model;
}

if (require.main === module) main();
module.exports = { buildX, FEAT_V4, FEAT_V4_FRAC, main };
