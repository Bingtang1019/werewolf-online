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

const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'value-vote-v31.json'); // V3.1（v1.7.16 后改名，原 value-vote-v4.json）
/** A-2 已知配置 key：9 配置精确标签 + cap 级聚合（rollout 路由键全集，v1.7.12） */
const KNOWN_CONFIGS = ['4p', '6p', '8p', '9a', '9b', '9c', '9d', '12a', '12b', '12c', '12d', '12e', '12f', '12g', '12h', '15p', '9p', '12p'];
/* v1.7.16（V4）：deadFrac → 三阵营死亡比例（Step4 验证：比例特征对线性 LSTD 是非线性增量——跨配置归一化减员进度） */
const FEATURES = ['bias', 'r_wolfFrac', 's_godFrac', 'T_alive', 'wolfDeadFrac', 'godDeadFrac', 'villDeadFrac', 'cap',
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
  const wolfDead = s.wolf0 > 0 ? (s.wolf0 - s.R) / s.wolf0 : 0; // v1.7.16（V4）：三阵营死亡比例（跨配置归一化）
  const godDead = s.god0 > 0 ? (s.god0 - s.S) / s.god0 : 0;
  const villDead = s.vill0 > 0 ? (s.vill0 - s.M) / s.vill0 : 0;
  return [1, r, sg, T, wolfDead, godDead, villDead, s.cap || T,
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

/* ---------------- P1-B: uncertainty-aware rollout（实验档，未接线——v1.7.16 自检确认无消费方，函数已移除；如需恢复见 git 历史） ---------------- */
module.exports = { loadV3, isLoaded, resetModel, buildFeatures, classifyRole, value, payoff, assertConfigs, FEATURES, MODEL_PATH, KNOWN_CONFIGS };
