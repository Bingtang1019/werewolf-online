'use strict';
/**
 * value-model-v4.js — HiCVN V4 inference (value-hicvn@1).
 * Interface-compatible with value-model.js (value/payoff/sigma) — rollout switches via
 * VALUE_MODEL=v4 with zero consumer changes.
 *   V(s) = mean(ensemble members) ∈ [0,1]   (good-win probability — semantic fixed)
 *   payoff(prev, next, config) = (V(next) − V(prev)) × payoffScale[config]
 *   σ(s)  = ensemble member std (true uncertainty, replaces φ'A⁻¹φ engineering approx)
 * A-2 纪律：payoffScale 已知配置 key 必须命中，禁止静默 fallback。
 */
const fs = require('fs');
const path = require('path');
const { GBDT } = require('./gbdt');
const { MLP } = require('./mlp');

const MODEL_PATH = process.env.MODEL_VALUE_VOTE_V4 || path.join(__dirname, '..', '..', 'models', 'value-hicvn-v42.json'); // v1.7.16：V4.2 替换后默认（MODEL_VALUE_VOTE_V4 可覆盖——A/B 对照/回退评估）
/* 1.7.17（V_wolf）：狼侧价值模型——P(狼胜|s)，与 V_good 同 schema 同特征（训练同源重标 --wolf-view）；
 * MODEL_VALUE_VOTE_V4_WOLF 可覆盖（A/B）；缺失 → fail-open null（狼侧回退解析版 payoff） */
const WOLF_MODEL_PATH = process.env.MODEL_VALUE_VOTE_V4_WOLF || path.join(__dirname, '..', '..', 'models', 'value-hicvn-v42-wolf.json');
const KNOWN_CONFIGS = ['4p', '6p', '8p', '9a', '9b', '9c', '9d', '12a', '12b', '12c', '12d', '12e', '12f', '12g', '12h', '15p', '9p', '12p'];

let _model = null;
let _wolfModel = null;
function _load(pathOrEnv, cacheKey) {
  const p = cacheKey === 'wolf' ? WOLF_MODEL_PATH : MODEL_PATH;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m.schema !== 'value-hicvn@1') return null; // schema 不匹配 → fail-open（不 throw：生产可用性优先）
    for (const k of KNOWN_CONFIGS) if (!m.payoffScale[k]) return null; // A-2 失配 → fail-open（lab 由 assertConfigs 显式抛）
    m._members = m.members.map(j => m.backbone === 'gbdt' ? GBDT.fromJSON(j) : MLP.fromJSON(j));
    return m;
  } catch (e) { return null; } // 文件缺失/损坏 → fail-open
}
function loadV4() {
  if (_model) return _model;
  _model = _load(MODEL_PATH, 'good');
  return _model;
}
function loadV4Wolf() {
  if (_wolfModel) return _wolfModel;
  _wolfModel = _load(WOLF_MODEL_PATH, 'wolf');
  return _wolfModel;
}
function isLoaded() { return _model !== null; }
function resetModel() { _model = null; _wolfModel = null; }

/** 特征构建（与 fit-value-v4 的 buildX 完全一致——以模型文件 featureSet/cfgKeys 为准，禁止分叉）
 *  featureSet: v4 | v4-frac | v4-info | v4-frac-info（-info 追加信息特征）；cfgKeys 追加配置 one-hot（V4.1 部署缺口修复） */
function buildX(s, m, config) {
  const T = (s.R + s.S + s.M) || 1;
  const r = s.R / T, sg = s.S / T;
  const frac = m.featureSet.startsWith('v4-frac');
  let x;
  if (frac) {
    const wd = s.wolf0 > 0 ? (s.wolf0 - s.R) / s.wolf0 : 0;
    const gd = s.god0 > 0 ? (s.god0 - s.S) / s.god0 : 0;
    const vd = s.vill0 > 0 ? (s.vill0 - s.M) / s.vill0 : 0;
    x = [r, sg, T, wd, gd, vd, s.cap || T, r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
  } else {
    x = [r, sg, T, s.cap || T, r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
  }
  if (m.cfgKeys && config != null) {
    const v = new Array(m.cfgKeys.length).fill(0);
    const i = m.cfgKeys.indexOf(config);
    if (i >= 0) v[i] = 1;
    for (let j = 0; j < v.length; j++) x.push(v[j]);
  }
  if (m.featureSet.endsWith('-info')) { // V4.2 信息特征（next 不变量；旧模型无 → 0）
    const inf = s.info || {};
    x.push(inf.checkedWolves || 0, inf.checkedCount || 0, inf.seerAlive || 0, inf.lastExileWasWolf || 0);
  }
  if (m.featureSet.endsWith('-intent')) { // V5 A3：意图状态特征（新模型可选；旧模型无此后缀 → 不消费）
    const it = s.intent || {};
    x.push(it.attackDensity || 0, it.claimSeerDensity || 0, it.defendDensity || 0, it.votePressure || 0, it.smalltalkRatio || 0);
  }
  return x;
}

/** V(s) ∈ [0,1] — 胜率概率语义（V_good = P(好人胜)） */
function value(state, config) {
  const m = loadV4();
  if (!m) return 0.5; // fail-open（与 value-model.js 一致）
  return _value(m, state, config);
}

/** V_wolf(s) ∈ [0,1] — P(狼胜)（1.7.17：狼侧 rollout 消费——与 V_good 对称，消除"狼预判好人"不对称） */
function valueWolf(state, config) {
  const m = loadV4Wolf();
  if (!m) return 0.5; // fail-open（模型缺失 → 狼侧回退解析版）
  return _value(m, state, config);
}
function _value(m, state, config) {
  const x = buildX(state, m, config);
  let s = 0;
  for (const mem of m._members) s += mem.predict(x);
  const v = s / m._members.length;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** payoff = ΔV × payoffScale[config]（rollout 消费语义：一步 Bellman 改进） */
function payoff(prevState, nextState, config) {
  const m = loadV4();
  if (!m) return 0;
  return _payoff(m, prevState, nextState, config);
}

/** 狼侧 payoff（1.7.17）：ΔV_wolf × payoffScale——rollout 狼分支专用 */
function payoffWolf(prevState, nextState, config) {
  const m = loadV4Wolf();
  if (!m) return 0;
  return _payoff(m, prevState, nextState, config);
}
function _payoff(m, prevState, nextState, config) {
  const d = _value(m, nextState, config) - _value(m, prevState, config);
  const scale = m.payoffScale && m.payoffScale[config];
  if (!scale) return 0; // fail-open（生产未训 cap 降级，lab 由 A-2 显式抛）
  return d * scale;
}

/** σ(s) = 集成成员 std × 校准 scale（0 表示模型未加载；旧模型无 meta.sigmaScale 时返回 raw std——兼容） */
function sigma(state, config) {
  const m = loadV4();
  if (!m) return 0;
  const x = buildX(state, m, config);
  const vs = [];
  for (const mem of m._members) vs.push(mem.predict(x));
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const raw = Math.sqrt(vs.reduce((a, b) => a + (b - mean) ** 2, 0) / vs.length);
  const scale = m.meta && m.meta.sigmaScale ? m.meta.sigmaScale : 1;
  return raw * scale;
}

/** A-2 启动断言：已知配置 key 必须命中 payoffScale（lab 启动时调用） */
function assertConfigs(known) {
  const m = loadV4();
  if (!m) return;
  const keys = new Set(Object.keys(m.payoffScale));
  for (const k of known) if (!keys.has(k)) throw new Error(`[v4] unknown config key "${k}" — train/infer mismatch (A-2)`);
  return true;
}

module.exports = { loadV4, loadV4Wolf, isLoaded, resetModel, buildX, value, valueWolf, payoff, payoffWolf, sigma, assertConfigs, MODEL_PATH, WOLF_MODEL_PATH, KNOWN_CONFIGS };
