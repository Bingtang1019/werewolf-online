'use strict';
/**
 * V3 hierarchical TD value model.
 *   V_c(s) = α_c·V_local_c(s) + (1−α_c)·V_global(s)
 *   payoff(s', s, config) = [V_c(s') − V_c(s)] × payoffScale[config]
 * Trained via LSTD (least-squares temporal difference) — Bellman consistency,
 * so the training objective is structurally identical to how rollout consumes it.
 * buildFeatures / classifyRole are SHARED with fit-value-v3.js — never fork them.
 */
const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'value-vote-v3.json');
/** A-2 已知配置 key：9 配置精确标签 + cap 级聚合（rollout 路由键全集，v1.7.12） */
const KNOWN_CONFIGS = ['4p', '6p', '8p', '9a', '9d', '12a', '12b', '12d', '15p', '9p', '12p'];
const FEATURES = ['bias', 'r_wolfFrac', 's_godFrac', 'T_alive', 'deadFrac', 'cap',
                  'r*s', 'wolfAlive', 'godAlive', 'villAlive', 'wolf0', 'god0', 'vill0'];

let _model = null;
function loadV3() {
  if (_model) return _model;
  try {
    _model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  } catch (e) { _model = null; return _model; } // 文件缺失/损坏 → fail-open（显式，调用方回退 payoffFor）
  // A-2 启动断言：已知配置 key 必须命中（训练/推理不匹配是 bug，禁止静默 fallback）
  for (const k of KNOWN_CONFIGS) if (!_model.local[k]) throw new Error(`[v3] A-2: 模型缺配置 key "${k}"（训练/推理不匹配）`);
  return _model;
}
function isLoaded() { return _model !== null; }
/** 回退：模型缺失时恒 0.5（fail-open，与 v1/v2 时代一致） */
function resetModel() { _model = null; }

/** A-2 启动断言：已知配置 key 必须命中模型，禁止静默 fallback（v1 死因温床，v1.7.12） */
function assertConfigs(known) {
  const m = loadV3();
  if (!m) return; // 模型缺失：调用方已显式 fail-open（payoffFor）
  const keys = new Set([...Object.keys(m.local), ...Object.keys(m.payoffScale)]);
  for (const k of known) if (!keys.has(k)) throw new Error(`[v3] unknown config key "${k}" — train/infer mismatch (A-2)`);
}

/* ---------------- role classification (defensive, keyed on roleKey) ---------------- */
const WOLF_KEYS = new Set(['wolf', 'werewolf', 'wolfking', 'wolf_god', 'wolfguard']);
const GOD_KEYS = new Set(['seer', 'witch', 'hunter', 'guard', 'guardian', 'knight', 'sheriff', 'idiot', 'savior', 'fox', 'dreamer']);

function classifyRole(roleKey) {
  const k = String(roleKey || '').toLowerCase().trim();
  if (WOLF_KEYS.has(k) || k.includes('wolf')) return 'wolf';
  if (GOD_KEYS.has(k) || GOD_KEYS.has(k.split('_')[0])) return 'god';
  if (k.includes('cupid') || k.includes('lover')) return 'third';
  if (k.includes('villag')) return 'vill';
  return 'third';
}

/* ---------------- shared feature builder ---------------- */
/** state snapshot: {R,S,M,N,cap,wolf0,god0,vill0} -> 13-dim feature vector */
function buildFeatures(s) {
  const T = (s.R + s.S + s.M) || 1;
  const r = s.R / T;
  const sg = s.S / T;
  return [1, r, sg, T, s.N / (s.cap || T), s.cap || T,
          r * sg, s.R, s.S, s.M, s.wolf0, s.god0, s.vill0];
}

function dot(w, x) { let acc = 0; for (let i = 0; i < x.length; i++) acc += w[i] * x[i]; return acc; }

/** blended value: α·local + (1−α)·global (expected-reward scale, no sigmoid) */
function value(state, config) {
  const m = loadV3();
  if (!m) return 0.5;
  const x = buildFeatures(state);
  const vg = dot(m.global.weights, x);
  const local = m.local[config];
  const vl = local ? dot(local.weights, x) : vg;
  const a = (m.alpha && m.alpha[config]) || 0;
  return a * vl + (1 - a) * vg;
}

/** payoff aligned with rollout semantics: one-step Bellman improvement, per-config scaled */
function payoff(prevState, nextState, config) {
  const m = loadV3();
  const d = value(nextState, config) - value(prevState, config);
  const scale = m.payoffScale && m.payoffScale[config];
  if (!scale) throw new Error(`[v3] A-2: payoffScale 缺配置 key "${config}"（训练/推理不匹配，禁止静默 fallback）`);
  return d * scale;
}

/* ---------------- P1-B: uncertainty-aware rollout (experimental, default off) ---------------- */
/** σ(s) = √(φ'A⁻¹φ)：训练分布覆盖度代理（工程近似，非严格后验）。model.uncertainty.invA 由训练侧写入 */
function sigma(state, config) {
  const m = loadV3();
  if (!m || !m.uncertainty || !m.uncertainty.invA) return 0;
  const A = m.uncertainty.invA;
  const x = buildFeatures(state);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    let t = 0;
    for (let j = 0; j < x.length; j++) t += A[i][j] * x[j];
    acc += x[i] * t;
  }
  return Math.sqrt(Math.max(acc, 1e-9));
}
/** v3.1 实验档（默认关闭）：低置信状态收缩 payoff——k≈2 */
function payoffUncertain(prevState, nextState, config, k) {
  const d = payoff(prevState, nextState, config);
  const s = sigma(nextState, config);
  return s > 0 ? d * (1 / (1 + (k || 2) * s)) : d;
}

module.exports = { loadV3, isLoaded, resetModel, buildFeatures, classifyRole, value, payoff, sigma, payoffUncertain, assertConfigs, FEATURES, MODEL_PATH, KNOWN_CONFIGS };

/** A-2 启动断言：configKey 必须命中模型，禁止静默 fallback（v1 死因温床）——已知 key 不在模型则抛错 */
function assertConfigs(known) {
  const m = loadV3();
  if (!m) throw new Error('[v3] model not loaded — assertConfigs called before loadV3');
  const keys = new Set([...Object.keys(m.local), ...Object.keys(m.payoffScale)]);
  for (const k of known) if (!keys.has(k)) throw new Error('[v3] unknown config key "' + k + '" — train/infer mismatch (A-2)');
  return true;
}
