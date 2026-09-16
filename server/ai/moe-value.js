'use strict';
/* =========================================================================
 * server/ai/moe-value.js —— V3.1 / V4.2 / V5-intent 价值层 MoE（A + F）
 * 模式：MOE_MODE=off（默认）| shadow（只记录不生效）| on（生效）
 * 门控：V4.2 σ 高 → 偏向 V3.1；意图强度高 → 偏向 V5；否则以 V4.2 为主。
 * fail-open：任一专家缺失时自动回退 V4.2 / V3.1，绝不抛错影响生产。
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const v3 = require('./value-model.js');
const v4 = require('./value-model-v4.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SHADOW_FILE = path.join(ROOT, 'data', 'moe-shadow.jsonl');
let _v5Model = null, _v5Tried = false;
let _gate = null, _gateTried = false;
let _shadowCount = 0;

function mode() {
  const m = String(process.env.MOE_MODE || 'off').toLowerCase();
  return (m === 'on' || m === 'shadow') ? m : 'off';
}

function intentStrength(state) {
  const it = (state && state.intent) || {};
  const vals = [it.attackDensity, it.claimSeerDensity, it.defendDensity, it.votePressure, it.smalltalkRatio];
  return vals.reduce((a, b) => a + (Number(b) || 0), 0) / vals.length;
}

/** V5 A3 价值模型（可选专家）；路径优先级 MOE_V5_MODEL > 学习型门控自带的 v5Model > 合成默认；维度不匹配时安全跳过 */
function loadV5() {
  if (_v5Tried) return _v5Model;
  _v5Tried = true;
  const g = loadGate();
  const p = process.env.MOE_V5_MODEL || (g && g.v5Model) || path.join(ROOT, 'models', 'value-hicvn-v4-intent.json');
  try {
    const m = JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8'));
    if (m.schema !== 'value-hicvn@1' || !Array.isArray(m.members) || !m.members.length) return null;
    const d = m.members[0].norm && Array.isArray(m.members[0].norm.mean) ? m.members[0].norm.mean.length : 0;
    if (!d) return null;
    _v5Model = { model: m, dim: d };
  } catch (e) { _v5Model = null; }
  return _v5Model;
}

function v5Value(state, config) {
  const v5 = loadV5();
  if (!v5) return null;
  try {
    // 直接按模型自身的 featureSet 构造输入：基础 11 + cfg one-hot + info 4 + intent 5
    const m = v5.model;
    const T = (state.R + state.S + state.M) || 1;
    const r = state.R / T, sg = state.S / T;
    const x = [r, sg, T, state.cap || T, r * sg, state.R, state.S, state.M, state.wolf0 || 0, state.god0 || 0, state.vill0 || 0];
    const cfgKeys = m.cfgKeys || [];
    const one = new Array(cfgKeys.length).fill(0);
    const ci = cfgKeys.indexOf(config);
    if (ci >= 0) one[ci] = 1;
    for (const v of one) x.push(v);
    const inf = state.info || {};
    x.push(inf.checkedWolves || 0, inf.checkedCount || 0, inf.seerAlive || 0, inf.lastExileWasWolf || 0);
    const it = state.intent || {};
    x.push(it.attackDensity || 0, it.claimSeerDensity || 0, it.defendDensity || 0, it.votePressure || 0, it.smalltalkRatio || 0);
    if (x.length !== v5.dim) return null; // 模型自身不一致 → 跳过（当前合成 A3 已知存在该问题）
    let sum = 0;
    for (const member of m.members) {
      const mean = member.norm.mean, std = member.norm.std, p = member.params;
      let acc2 = p.b2, h = member.hidden, d = mean.length;
      for (let j = 0; j < h; j++) {
        let acc = p.b1[j];
        for (let k = 0; k < d; k++) acc += ((x[k] - mean[k]) / (std[k] || 1)) * p.W1T[j * d + k];
        acc2 += (acc > 0 ? acc : 0) * p.W2T[j];
      }
      sum += 1 / (1 + Math.exp(-acc2));
    }
    return sum / m.members.length;
  } catch (e) { return null; }
}

function v4Scale(config) {
  const m = v4.loadV4();
  const s = m && m.payoffScale && m.payoffScale[config];
  return s || 0;
}

function gate(state, values, sigmaV) {
  const intent = intentStrength(state);
  let w4 = 0.62, w3 = 0.28, w5 = values.v5 != null ? 0.10 : 0;
  if (sigmaV > 0.06) { const s = Math.min(0.30, (sigmaV - 0.06) * 2.5); w4 -= s; w3 += s; }
  if (intent > 0.18 && values.v5 != null) { const s = Math.min(0.25, (intent - 0.18) * 1.5); w4 -= s; w5 += s; }
  w3 += 0.02; // V3.1 趋势基线保底
  const sum = w3 + w4 + w5;
  return { w3: w3 / sum, w4: w4 / sum, w5: w5 / sum };
}

/** MoE D：学习型门控（models/moe-gate-v1.json，MOE_GATE_MODEL 可覆盖）。
 * 存在时优先于启发式门控；模型缺失/维度不符 → 自动回退，不影响可用性。 */
function loadGate() {
  if (_gateTried) return _gate;
  _gateTried = true;
  const p = process.env.MOE_GATE_MODEL || path.join(ROOT, 'models', 'moe-gate-v1.json');
  try {
    const g = JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8'));
    if (g.schema !== 'moe-gate@1' || !Array.isArray(g.weights) || !Array.isArray(g.featureNames) || g.weights.length !== g.featureNames.length) return null;
    _gate = g;
  } catch (e) { _gate = null; }
  return _gate;
}
function gatePredict(vals, sigmaV, intent, cfg) {
  const g = loadGate();
  if (!g) return null;
  const lg = p => { const q = Math.max(1e-4, Math.min(1 - 1e-4, p)); return Math.log(q / (1 - q)); };
  const has5 = vals.v5 == null ? 0 : 1;
  const named = { logit_v3: lg(vals.v3), logit_v4: lg(vals.v4), logit_v5: has5 ? lg(vals.v5) : 0, sigma: sigmaV, intent, hasV5: has5 };
  let z = 0;
  for (let i = 0; i < g.featureNames.length; i++) {
    const n = g.featureNames[i];
    const x = n.startsWith('cfg_') ? ((cfg && n === 'cfg_' + cfg) ? 1 : 0) : (named[n] != null ? named[n] : (n === 'bias' ? 1 : 0));
    z += g.weights[i] * x;
  }
  return 1 / (1 + Math.exp(-z));
}

function explain(state, config) {
  const val3 = v3.value(state, config);
  const val4 = v4.value(state, config);
  const val5 = v5Value(state, config);
  const sg = v4.sigma(state, config);
  const intent = intentStrength(state);
  const learned = gatePredict({ v3: val3, v4: val4, v5: val5 }, sg, intent, config);
  const weights = gate(state, { v3: val3, v4: val4, v5: val5 }, sg);
  const fused = learned != null ? learned : (weights.w3 * val3 + weights.w4 * val4 + (val5 != null ? weights.w5 * val5 : 0));
  return { val3, val4, val5, sigma: sg, intent, weights, gate: learned != null ? 'learned' : 'heuristic', fused };
}

function value(state, config) {
  const m = mode();
  if (m === 'off') return v4.value(state, config);
  let e;
  try { e = explain(state, config); } catch (err) { return v4.value(state, config); }
  if (m === 'shadow') {
    try {
      if (_shadowCount++ < 2000) {
        fs.mkdirSync(path.dirname(SHADOW_FILE), { recursive: true });
        fs.appendFileSync(SHADOW_FILE, JSON.stringify({ ts: Date.now(), config, state: { R: state.R, S: state.S, M: state.M, cap: state.cap }, intent: e.intent, sigma: e.sigma, val3: e.val3, val4: e.val4, val5: e.val5, weights: e.weights, gate: e.gate, fused: e.fused }) + '\n');
      }
    } catch (err) { /* shadow 失败不影响生产 */ }
    return e.val4;
  }
  return e.fused < 0 ? 0 : e.fused > 1 ? 1 : e.fused;
}

function payoff(prevState, nextState, config) {
  const m = mode();
  if (m === 'off') return v4.payoff(prevState, nextState, config);
  const d = value(nextState, config) - value(prevState, config);
  const scale = v4Scale(config);
  return d * scale;
}

function reset() { _v5Model = null; _v5Tried = false; _gate = null; _gateTried = false; _shadowCount = 0; }

module.exports = { mode, value, payoff, explain, sigma: v4.sigma, reset, intentStrength, _internal: { loadV5, v5Value, gate, loadGate, gatePredict } };
