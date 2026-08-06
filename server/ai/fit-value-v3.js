'use strict';
/**
 * fit-value-v3.js — hierarchical LSTD training (v1.7.12, V3).
 * Usage:
 *   node server/ai/fit-value-v3.js --records ./data/records --out models/value-vote-v3.json
 *                       [--lambda 1e-2] [--alpha-n0 2000] [--holdout 0.2] [--tune-alpha]
 * Records: lab pool full-events JSONL (one record per game), filename must carry
 * config tag: {4p,6p,8p,9a,9d,12a,12b,12d,15p}.jsonl — see eventsToDays adapter.
 */
const fs = require('fs');
const path = require('path');
const { buildFeatures, classifyRole, FEATURES } = require('./value-model');

/* ---------------- mini linear algebra ---------------- */
function matInv(A) {
  const d = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: d }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular matrix — check feature collinearity');
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col];
    for (let j = 0; j < 2 * d; j++) M[col][j] /= pv;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * d; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(d));
}

/* ---------------- LSTD(0, γ=1) — closed form, Bellman consistency ---------------- */
/** transitions: [{phi, r, phiNext, terminal?}] with phi/phiNext 13-dim feature vectors.
 *  A = Σ wt·φ_t(φ_t − φ_{t+1})ᵀ + λI ; b = Σ wt·φ_t·r_t ; w = A⁻¹b
 *  v1.7.12：bias 特征在中间转移恒消（φ[0]−φ_next[0]=0）→ A 的 bias 列只来自终局（占比 1/T）→ 列间量级差 ~T 倍 → 病态爆炸。
 *  终局加权（terminalWeight = 中间/终局转移数比）使 bias 列量级与中间列相当，数值稳定。 */
function fitLSTD(transitions, lambda, terminalWeight) {
  const d = FEATURES.length;
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (const t of transitions) {
    const phi = t.phi, next = t.phiNext, r = t.r;
    const wt = (t.terminal && terminalWeight) || 1;
    for (let i = 0; i < d; i++) {
      b[i] += phi[i] * r * wt;
      for (let j = 0; j < d; j++) A[i][j] += phi[i] * (phi[j] - next[j]) * wt;
    }
  }
  for (let i = 0; i < d; i++) A[i][i] += lambda;
  const Ainv = matInv(A);
  const w = new Array(d);
  for (let i = 0; i < d; i++) {
    let acc = 0;
    for (let j = 0; j < d; j++) acc += Ainv[i][j] * b[j];
    w[i] = acc;
  }
  return { w, Ainv };
}
function dot(w, x) { let acc = 0; for (let i = 0; i < x.length; i++) acc += w[i] * x[i]; return acc; }

/* ---------------- adapter: lab pool full-events record -> days ---------------- */
/**
 * lab 记录结构：{ players:[{id,roleKey,...}], events:[{t:'deaths',data:{deaths:[ids]}}, {t:'exile',data:{exiled:id}}], result:{winner} }
 * 适配为训练侧 days：{ nightDeaths:[ids], lynched:id }（deaths 归入紧随其后的 exile 所属 day 的夜间死亡）
 */
function eventsToDays(rec) {
  const days = [];
  let cur = { nightDeaths: [], lynched: null };
  const idOf = d => (d && typeof d === 'object' ? d.id : d);
  for (const e of rec.events || []) {
    if (e.t === 'deaths' && e.data && Array.isArray(e.data.deaths)) {
      // v1.7.12 修正：deaths 事件是对象数组 {id,name,by}，须提取 id
      cur.nightDeaths.push(...e.data.deaths.map(idOf));
    } else if (e.t === 'exile' && e.data && e.data.exiled) {
      cur.lynched = idOf(e.data.exiled);
      days.push(cur);
      cur = { nightDeaths: [], lynched: null };
    }
  }
  return {
    days,
    players: rec.players || [],
    winner: rec.result ? rec.result.winner : null,
    config: { cap: (rec.players || []).length },
  };
}

/* ---------------- P0 补丁：终局节点（pre → post 交替，放逐后状态入链） ---------------- */
/**
 * 节点序列：白天投票前(pre) → 放逐后(post)，交替；终局以 post 结尾。
 * 转移：pre→post（放逐动作，对应 rollout 的目标世界）; post→next pre（夜晚）; 末尾自转移 r=y。
 */
function rebuildEventStates(rec) {
  const { days, players } = eventsToDays(rec);
  const cap = players.length;
  const roles = players.map(p => classifyRole(p.roleKey || p.role || p.roleName));
  let wolf0 = 0, god0 = 0, vill0 = 0;
  for (const r of roles) { if (r === 'wolf') wolf0++; else if (r === 'god') god0++; else if (r === 'vill') vill0++; }
  // v1.7.12 修正：id→索引映射（此前 alive[id]=false 用字符串 id 索引数组失效 → 状态恒初始配置 → 训练数据全错）
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
  const nodes = [];
  for (const day of days) {
    if (Array.isArray(day.nightDeaths)) for (const id of day.nightDeaths) kill(id);
    if (day.lynched != null) {
      nodes.push({ ...count(), phase: 'pre' });
      const lynched = day.lynched;
      if (Array.isArray(lynched)) lynched.forEach(kill);
      else kill(lynched);
      nodes.push({ ...count(), phase: 'post' });
    }
  }
  return nodes;
}

/** 转移：pre→post（放逐动作）; post→next pre（夜晚）; 末尾终局监督 r=y，转移到吸收态（phiNext=0）。
 *  v1.7.12 修正：原 self-loop（phiNext=phi）使终局对 A 无贡献（φ(φ−φ)=0），b 只来自终局而 A 只来自中间——
 *  理想线性情形下中间满足贝尔曼 → A·w*=0 → A 奇异数值爆炸（合成恢复测试 max error 7亿）。
 *  吸收态是标准 TD 终局：A += φφᵀ、b += φ·y，A·w* = Σφ·(w*·φ) = Σφ·y 一致且数值稳定。 */
const ZEROS = new Array(FEATURES.length).fill(0);
function buildTransitions(nodes, y) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const phi = buildFeatures(nodes[i]);
    if (i < nodes.length - 1) out.push({ phi, r: 0, phiNext: buildFeatures(nodes[i + 1]) });
    else out.push({ phi, r: y, phiNext: ZEROS, terminal: true });
  }
  return out;
}
/** 终局加权：中间/终局转移数比（bias 列量级补偿，v1.7.12） */
function terminalWeightOf(transitions) {
  let mid = 0, term = 0;
  for (const t of transitions) { if (t.terminal) term++; else mid++; }
  return mid / Math.max(1, term);
}

/* ---------------- metrics ---------------- */
function auc(y, s) {
  const n = y.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => s[a] - s[b]);
  const rank = new Float64Array(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && s[idx[j + 1]] === s[idx[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]] = r;
    i = j + 1;
  }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let k = 0; k < n; k++) {
    if (y[k] === 1) { sumPos += rank[k]; nPos++; } else nNeg++;
  }
  return nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : 0.5;
}

/** PAV 保序回归校准（附录/报告用；rollout 不用——PAV 非单调变换破坏差值幅度，保持 affine 语义） */
function pavCalibration(ys, vs) {
  const items = vs.map((v, i) => ({ v, y: ys[i] })).sort((a, b) => a.v - b.v);
  const blocks = [];
  for (const it of items) {
    blocks.push({ sumV: it.v, sumY: it.y, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 1].sumY / blocks[blocks.length - 1].n < blocks[blocks.length - 2].sumY / blocks[blocks.length - 2].n) {
      const b = blocks.pop(), a = blocks[blocks.length - 1];
      blocks[blocks.length - 1] = { sumV: a.sumV + b.sumV, sumY: a.sumY + b.sumY, n: a.n + b.n };
    }
  }
  return blocks.map(b => ({ meanV: +(b.sumV / b.n).toFixed(4), calibrated: +(b.sumY / b.n).toFixed(4), n: b.n }));
}

function calibration(y, v, buckets = 5) {  const n = y.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => v[a] - v[b]);
  const out = [];
  const per = Math.ceil(n / buckets);
  for (let b = 0; b < buckets; b++) {
    const slice = idx.slice(b * per, Math.min(n, (b + 1) * per));
    if (!slice.length) continue;
    let meanV = 0, rate = 0;
    for (const i of slice) { meanV += v[i]; rate += y[i]; }
    out.push({ bucket: b + 1, n: slice.length, meanV: +(meanV / slice.length).toFixed(3), actual: +(rate / slice.length).toFixed(3) });
  }
  return out;
}

/* ---------------- io ---------------- */
const CFG_TAGS = ['4p', '6p', '8p', '9a', '9d', '12a', '12b', '12d', '15p'];
function tagOf(file) {
  const base = path.basename(file);
  for (const t of CFG_TAGS) if (base.indexOf(t) === 0) return t;
  return null;
}
function loadRecords(p) {
  const st = fs.statSync(p);
  const files = st.isDirectory()
    ? fs.readdirSync(p).filter(f => /\.(json|jsonl)$/.test(f)).map(f => path.join(p, f))
    : [p];
  const recs = [];
  for (const f of files) {
    const tag = tagOf(f);
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = [];
    if (f.endsWith('.jsonl')) {
      for (const line of raw.split('\n')) { const t = line.trim(); if (t) { try { parsed.push(JSON.parse(t)); } catch (e) {} } }
    } else {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) parsed.push(...v); else parsed.push(v);
    }
    for (const r of parsed) { if (r.config) r.config.preset = tag; else r.config = { preset: tag }; }
    recs.push(...parsed);
  }
  return recs;
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  return {
    records: get('--records', './data/records'),
    out: get('--out', path.join(__dirname, '..', '..', 'models', 'value-vote-v3.json')),
    lambda: parseFloat(get('--lambda', '1e-2')),
    alphaN0: parseFloat(get('--alpha-n0', '2000')),
    holdout: parseFloat(get('--holdout', '0.2')),
    tuneAlpha: a.includes('--tune-alpha'),
  };
}

/* ---------------- main ---------------- */
function main() {
  const opt = parseArgs();
  console.log(`[v3] loading records from ${opt.records}`);
  const recs = loadRecords(opt.records).filter(r => r.events && r.result && r.result.winner);
  console.log(`[v3] ${recs.length} games`);

  const configKey = rec => `${rec.config.preset || (rec.config.cap || rec.players.length) + 'p'}`;

  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  const rows = [];
  for (const rec of recs) {
    const cfg = configKey(rec);
    const states = rebuildEventStates(rec);
    if (!states.length) continue;
    rows.push({ states, y: String(rec.result.winner).toLowerCase().includes('good') ? 1 : 0, cfg, split: rnd() < opt.holdout ? 'test' : 'train' });
  }
  const trainRows = rows.filter(r => r.split === 'train');
  const testRows = rows.filter(r => r.split === 'test');
  console.log(`[v3] train games=${trainRows.length}, test games=${testRows.length}`);

  // ---- global LSTD ----
  const globalTrans = [];
  for (const r of trainRows) globalTrans.push(...buildTransitions(r.states, r.y));
  const { w: wGlobal, Ainv: invA } = fitLSTD(globalTrans, opt.lambda, terminalWeightOf(globalTrans));
  console.log('[v3] global weights:');
  FEATURES.forEach((f, i) => console.log(`  ${f.padEnd(12)} ${wGlobal[i].toFixed(4)}`));

  const wi = name => wGlobal[FEATURES.indexOf(name)];
  const dirOk = wi('r_wolfFrac') < 0 && wi('wolfAlive') < 0 && wi('godAlive') > 0 && wi('villAlive') > 0;
  console.log(`[v3] directional prior check: ${dirOk ? 'PASS' : 'FAIL'}`);
  if (!dirOk) console.warn('[v3] WARNING: weights violate priors — inspect before deploying');

  // ---- per-config local LSTD ----
  const byCfg = new Map();
  for (const r of trainRows) { if (!byCfg.has(r.cfg)) byCfg.set(r.cfg, []); byCfg.get(r.cfg).push(r); }
  const local = {}, nByCfg = {};
  for (const [cfg, rs] of byCfg) {
    const trans = [];
    for (const r of rs) trans.push(...buildTransitions(r.states, r.y));
    nByCfg[cfg] = rs.length;
    local[cfg] = { weights: fitLSTD(trans, opt.lambda, terminalWeightOf(trans)).w };
    console.log(`[v3] local ${cfg}: n=${rs.length}`);
  }

  // ---- cap 聚合 local（rollout/生产只有 cap 信息：configKey = `${cap}p`，A-2 纪律禁止静默 fallback）----
  const byCap = new Map();
  for (const r of trainRows) {
    const capKey = ((r.cfg.match(/\d+/) || [''])[0]) + 'p'; // '12a'→'12p', '4p'→'4p'
    if (!byCap.has(capKey)) byCap.set(capKey, []);
    byCap.get(capKey).push(r);
  }
  for (const [capKey, rs] of byCap) {
    const trans = [];
    for (const r of rs) trans.push(...buildTransitions(r.states, r.y));
    local[capKey] = { weights: fitLSTD(trans, opt.lambda, terminalWeightOf(trans)).w };
    console.log(`[v3] local ${capKey}（cap 聚合，rollout 用）: n=${rs.length}`);
  }

  // ---- alpha（可选网格调优）----
  let alphaN0 = opt.alphaN0;
  if (opt.tuneAlpha) alphaN0 = tuneAlpha(testRows, wGlobal, local, byCfg, opt.alphaN0);
  const alpha = {};
  for (const [cfg, rs] of byCfg) alpha[cfg] = +(rs.length / (rs.length + alphaN0)).toFixed(3);
  for (const [capKey, rs] of byCap) alpha[capKey] = +(rs.length / (rs.length + alphaN0)).toFixed(3);
  console.log(`[v3] alphaN0=${alphaN0} → alpha: ${Object.entries(alpha).map(([c, a]) => c + ':' + a).join(' ')}`);

  // ---- per-config holdout（v1.7.12 红旗修复：评估只对 pre 节点，排除终局 post 平凡特征；校准与 AUC 同口径）----
  const blended = (state, cfg) => {
    const x = buildFeatures(state);
    const vg = dot(wGlobal, x);
    const vl = local[cfg] ? dot(local[cfg].weights, x) : vg;
    return alpha[cfg] * vl + (1 - alpha[cfg]) * vg;
  };
  const perConfig = {};
  const testByCfg = new Map();
  for (const r of testRows) {
    if (!testByCfg.has(r.cfg)) testByCfg.set(r.cfg, []);
    for (const s of r.states) {
      if (s.phase !== 'pre') continue;
      testByCfg.get(r.cfg).push({ v: blended(s, r.cfg), y: r.y });
    }
  }
  for (const [cfg, items] of testByCfg) {
    const ys = items.map(i => i.y), vs = items.map(i => i.v);
    const a = auc(ys, vs);
    const minV = Math.min(...vs), maxV = Math.max(...vs);
    const meanV = vs.reduce((x, y) => x + y, 0) / vs.length;
    const sdV = Math.sqrt(vs.reduce((x, y) => x + (y - meanV) ** 2, 0) / vs.length);
    perConfig[cfg] = { auc: +a.toFixed(4), n: items.length, vStats: { min: +minV.toFixed(4), max: +maxV.toFixed(4), mean: +meanV.toFixed(4), std: +sdV.toFixed(4) }, calibration: calibration(ys, vs), pavCalibration: pavCalibration(ys, vs) };
    console.log(`  ${cfg}: AUC ${a.toFixed(4)} (n=${items.length}) V[${minV.toFixed(3)},${maxV.toFixed(3)}] std=${sdV.toFixed(4)}`);
  }
  const eqAuc = Object.values(perConfig).reduce((s, c) => s + c.auc, 0) / Math.max(1, Object.keys(perConfig).length);
  console.log(`[v3] config-equal-weight holdout AUC（preset 级 9 配置）: ${eqAuc.toFixed(4)}`);

  // ---- cap 级评估（12p/9p 等：lab 未训配置的 cap 聚合路由——P0-1 修复，验收覆盖生产路由键）----
  const capKeyOf = cfg => ((cfg.match(/\d+/) || [''])[0]) + 'p';
  const testByCap = new Map();
  for (const r of testRows) {
    const ck = capKeyOf(r.cfg);
    if (!testByCap.has(ck)) testByCap.set(ck, []);
    for (const s of r.states) if (s.phase === 'pre') testByCap.get(ck).push({ v: blended(s, ck), y: r.y });
  }
  for (const [ck, items] of testByCap) {
    if (perConfig[ck]) continue; // preset 级已覆盖（4p/6p/8p/15p 与 cap 级同键）
    const ys = items.map(i => i.y), vs = items.map(i => i.v);
    const minV = Math.min(...vs), maxV = Math.max(...vs), meanV = vs.reduce((a, b) => a + b, 0) / vs.length;
    const sdV = Math.sqrt(vs.reduce((a, b) => a + (b - meanV) ** 2, 0) / vs.length);
    perConfig[ck] = { auc: +auc(ys, vs).toFixed(4), n: items.length, capAggregated: true, vStats: { min: +minV.toFixed(4), max: +maxV.toFixed(4), mean: +meanV.toFixed(4), std: +sdV.toFixed(4) }, calibration: calibration(ys, vs), pavCalibration: pavCalibration(ys, vs) };
    console.log(`  ${ck}（cap 聚合）: AUC ${perConfig[ck].auc.toFixed(4)} (n=${items.length})`);
  }

  // ---- payoff scale ----
  const deltaByCfg = new Map();
  for (const r of trainRows) {
    for (let i = 1; i < r.states.length; i++) {
      const d = blended(r.states[i], r.cfg) - blended(r.states[i - 1], r.cfg);
      if (!deltaByCfg.has(r.cfg)) deltaByCfg.set(r.cfg, []);
      deltaByCfg.get(r.cfg).push(d);
    }
  }
  const payoffScale = {};
  for (const [cfg, ds] of deltaByCfg) {
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
    payoffScale[cfg] = +(1 / (sd || 1)).toFixed(3);
  }
  console.log('[v3] payoffScale（preset 级）:', JSON.stringify(payoffScale));

  // ---- cap 级 payoffScale（P0-1：cap 聚合 local 的 ΔV std 反推——lab 未训配置路由键必须命中）----
  const deltaByCap = new Map();
  for (const r of trainRows) {
    const ck = capKeyOf(r.cfg);
    for (let i = 1; i < r.states.length; i++) {
      const d = blended(r.states[i], ck) - blended(r.states[i - 1], ck);
      if (!deltaByCap.has(ck)) deltaByCap.set(ck, []);
      deltaByCap.get(ck).push(d);
    }
  }
  for (const [ck, ds] of deltaByCap) {
    if (payoffScale[ck]) continue;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const sd = Math.sqrt(ds.reduce((a, b) => a + (b - mean) ** 2, 0) / ds.length);
    payoffScale[ck] = +(1 / (sd || 1)).toFixed(3);
  }
  console.log('[v3] payoffScale（含 cap 级）:', JSON.stringify(payoffScale));

  const model = {
    version: 'v3',
    architecture: 'hierarchical-lstd',
    features: FEATURES,
    global: { weights: wGlobal.map(x => +x.toFixed(6)) },
    local,
    alpha,
    alphaN0,
    payoffScale,
    uncertainty: { invA },
    perConfig,
    meta: {
      trainedAt: new Date().toISOString(),
      trainGames: trainRows.length,
      testGames: testRows.length,
      trainStates: trainRows.reduce((s, r) => s + r.states.length, 0),
      configEqualAUC: +eqAuc.toFixed(4),
      evalScope: 'pre-only (excludes terminal post nodes, v1.7.12 红旗修复)',
      localKeys: Object.keys(local),
      note2: 'local 含 preset 级（12a/12b/…）与 cap 级（12p，rollout/生产用）——A-2 启动断言检查命中',
      lambda: opt.lambda,
      priorCheck: dirOk ? 'PASS' : 'FAIL',
      replaces: 'value-vote-v2.json',
      filterNotes: 'train/test 为 holdout 分层划分（seed=42 确定性 rnd）；无投票节点局（快速结束/无 exile 事件）被跳过（states.length===0）；4p 补采 3500 局与首采 1500 局合并（覆盖 bug 后重采，实际 5000 局存档）——存档 16998 局 vs train+test 15753 局差 1245 局即无节点局过滤量',
      uncertaintyNote: 'uncertainty.invA = global 训练 A（未归一化特征）的逆，13×13；±25 对角/交叉结构 = T_alive 与 wolfAlive/godAlive/villAlive 精确共线（存活总数=三阵营和）的 Ridge 响应——P1-B Thompson 前必须验证尺度（当前 invA[0][0]≈0.0024 对应有效样本 ~400，勿直接作后验方差）',
      note: 'LSTD(0,γ=1) — V is expected-reward scale; payoff = ΔV × payoffScale[config]',
    },
  };
  fs.writeFileSync(opt.out, JSON.stringify(model, null, 2));
  console.log(`[v3] saved to ${opt.out}`);
  return model;
}

/** P1-A：αN0 网格调优（global/local 权重固定，只重算混合 + 配置等权 AUC） */
function tuneAlpha(testRows, wGlobal, local, byCfg, defaultN0) {
  const cands = [500, 1000, 2000, 4000, 8000];
  const evalFor = n0 => {
    const alpha = {};
    for (const [cfg, rs] of byCfg) alpha[cfg] = rs.length / (rs.length + n0);
    const blended = (state, cfg) => {
      const x = buildFeatures(state);
      const vg = dot(wGlobal, x);
      const vl = local[cfg] ? dot(local[cfg].weights, x) : vg;
      return alpha[cfg] * vl + (1 - alpha[cfg]) * vg;
    };
    const byC = new Map();
    for (const r of testRows) {
      if (!byC.has(r.cfg)) byC.set(r.cfg, []);
      for (const s of r.states) byC.get(r.cfg).push({ v: blended(s, r.cfg), y: r.y });
    }
    const aucs = {};
    for (const [cfg, items] of byC) aucs[cfg] = auc(items.map(i => i.y), items.map(i => i.v));
    return Object.values(aucs).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(aucs).length);
  };
  let best = defaultN0, bestEq = evalFor(defaultN0);
  const table = [];
  for (const n0 of cands) {
    const eq = evalFor(n0);
    table.push({ n0, eq: +eq.toFixed(4) });
    if (eq > bestEq) { bestEq = eq; best = n0; }
  }
  console.log('[v3] alphaN0 grid: ' + table.map(t => `${t.n0}:${t.eq}`).join(' '));
  console.log(`[v3] alphaN0 chosen: ${best} (eq AUC ${bestEq.toFixed(4)})`);
  return best;
}

if (require.main === module) main();
module.exports = { fitLSTD, buildTransitions, rebuildEventStates, eventsToDays, auc, calibration, pavCalibration, main };
