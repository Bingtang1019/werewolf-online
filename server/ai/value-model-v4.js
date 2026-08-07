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
const KNOWN_CONFIGS = ['4p', '6p', '8p', '9a', '9b', '9c', '9d', '12a', '12b', '12c', '12d', '12e', '12f', '12g', '12h', '15p', '9p', '12p'];

let _model = null;
function loadV4() {
  if (_model) return _model;
  try {
    _model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  } catch (e) { _model = null; return _model; } // 文件缺失 → fail-open（调用方回退）
  if (_model.schema !== 'value-hicvn@1') throw new Error(`[v4] 模型 schema 不匹配: ${_model.schema}`);
  // A-2 启动断言：已知配置 key 必须命中 payoffScale（训练/推理不匹配是 bug）
  for (const k of KNOWN_CONFIGS) if (!_model.payoffScale[k]) throw new Error(`[v4] A-2: 模型缺配置 key "${k}"（训练/推理不匹配）`);
  _model._members = _model.members.map(j => _model.backbone === 'gbdt' ? GBDT.fromJSON(j) : MLP.fromJSON(j));
  return _model;
}
function isLoaded() { return _model !== null; }
function resetModel() { _model = null; }

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
  return x;
}

/** V(s) ∈ [0,1] — 胜率概率语义 */
function value(state, config) {
  const m = loadV4();
  if (!m) return 0.5; // fail-open（与 value-model.js 一致）
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
  const d = value(nextState, config) - value(prevState, config);
  const scale = m.payoffScale && m.payoffScale[config];
  if (!scale) throw new Error(`[v4] A-2: payoffScale 缺配置 key "${config}"（训练/推理不匹配，禁止静默 fallback）`);
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

module.exports = { loadV4, isLoaded, resetModel, buildX, value, payoff, sigma, assertConfigs, MODEL_PATH, KNOWN_CONFIGS };
