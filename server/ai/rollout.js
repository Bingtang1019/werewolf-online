'use strict';
/* =========================================================================
 * 1.7.0（B1-5）：rollout 规划层——投票决策的轻量前瞻
 * 深度分层：只模拟到"本轮投票结束"（放逐结果），不展开后续夜晚（预算可控）
 * 信念采样：按各候选 P(wolf)（world.scores）伯努利采样隐藏身份，多次采样取期望
 * 快策略：模拟其他玩家投票——好人投"模型分最高"候选，狼投"模型分最低非队友"
 * 关键修正（B1-5 二期）：逐候选评估"假设我投 X"的后果（me 的票参与结算），
 *   否则排除 me 后投 X 无法影响结果，得分无区分度
 * 纪律：纯函数（绝不 mutate 真实 room）；派生 RNG 保证确定性；预算不足自动降 worlds
 * 已知近视边界（P2-4，1.7.3 标注）：只模拟到"放逐"本身，不展开放逐连锁——
 *   放逐猎人的开枪、放逐狼美人的魅惑带走（若带走预言家是 -3 量级的损失）未进 payoff。
 *   符合 B1-5"深度分层"规格，但 C 系列前重训/调参时记住：投狼美人的风险被系统性低估。
 * 1.7.4（Q1/Q2/动态化）：见 payoffFor 与 rolloutVote 内注释。
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* 1.7.4（Q1）：动态 payoff——阵营分流 + R/S/M 双线加权（全部公开量）。
 * 公开量（死后全翻牌）：wolfAlive/godAlive/villAlive = roleCounts − 已翻牌死亡。
 * payoffP/payoffQ 曲率（0 时精确退化为静态 3/1.5；默认 1）：
 *   好人侧：放逐狼 A=3×(R0/R)^p（1/R 进度——狼越少越敢投，一票定胜负值得赌）；
 *           误放逐 B 按神/民线余量加权（神快崩则保守，宁跟票不赌）
 *   狼侧：放逐好人 A 按神/民线加权（屠边进度）；误投队友 B=1.5×(R0/R)^p（狼越少越贵）
 * 语义推演（p=q=1）：开局 P*=0.333=现状；残局狼少（R=1）P*≈0.294 更敢投；神快崩（S=1）P*≈0.455 更保守 */
function payoffFor(world, xIsWolf) {
  const { faction, wolfAlive, godAlive, villAlive, wolfInit, godInit, villInit, payoffP, payoffQ } = world;
  const p = payoffP == null ? 1 : payoffP;
  const q = payoffQ == null ? 1 : payoffQ;
  const R = Math.max(1, wolfAlive), S = Math.max(1, godAlive), M = Math.max(1, villAlive);
  const R0 = Math.max(1, wolfInit), S0 = Math.max(1, godInit), M0 = Math.max(1, villInit);
  const pGod = S / (S + M), pVill = M / (S + M);
  if (faction === 'third') {
    // v1.7.6：第三方价值函数（V 模型学不了——第三方胜局=0 无样本；A-3 纪律：等胜率>0 攒样本再 fit）
    //   thirdValue = 10×thirdAlive − 3×godAlive − 2×max(goodAlive, wolfAlive)；payoff = thirdValue(放逐后) − 现在
    //   语义：神职是好人引擎（重罚）、强阵营是威胁（削优势方有益=维持好狼互耗）
    const T = Math.max(1, world.thirdAlive || 1);
    const tv = (r, s, m, t) => 10 * t - 3 * s - 2 * Math.max(r, s + m);
    const cur = tv(R, S, M, T);
    if (!xIsWolf) return (S / (S + M)) * (tv(R, S - 1, M, T) - cur) + (M / (S + M)) * (tv(R, S, M - 1, T) - cur); // 放逐好人（神/民加权）
    return tv(R - 1, S, M, T) - cur; // 放逐狼
  }
  if (faction === 'wolf') {
    if (!xIsWolf) return pVill * 3 * Math.pow(M0 / M, q) + pGod * 3 * Math.pow(S0 / S, q);
    return -1.5 * Math.pow(R0 / R, p);
  }
  if (xIsWolf) return 3 * Math.pow(R0 / R, p);
  return -(pVill * 1.5 * Math.pow(M0 / M, q) + pGod * 1.5 * Math.pow(S0 / S, q));
}

/* 数据驱动 V 差分 payoff（1.7.4 二期）：从 models/value-vote-v1.json 加载逻辑回归 V(R,S,M,N)，
 * payoff = V(s')−V(s)（s' = 放逐 X 后的状态，按 X 身份 R/S/M −1）——曲率由数据定，不猜 p。
 * 拟合：1500 局 4717 个投票时刻样本，AUC=0.7789（修复 roleKey 重建后）。
 * 尺度：K 放大到与解析版（3/1.5）可比——保相对权重、调绝对尺度；margin 相对化不受影响。
 * 启用：PAYOFF_MODE=value；fail-open：模型缺失回退解析版 payoffFor。 */
let _valueModel = null, _valueTried = false;
// v1.7.10：v2 替换启用（生产默认改 value-vote-v2.json；MODEL_VALUE_VOTE 可覆盖——评估用）
// v1 AUC=0.3157 反向过时（当前代码数据），v2 AUC=0.7620 重拟合；生产 smart 档 rollout 不参与，替换零影响；simulate 档替换偏狼 +1.93pp（见 archive/lover-v2/README）
const VALUE_PATH = process.env.MODEL_VALUE_VOTE || path.join(__dirname, '..', '..', 'models', 'value-vote-v2.json');
function getValueModel() {
  if (_valueTried) return _valueModel;
  _valueTried = true;
  try { _valueModel = JSON.parse(fs.readFileSync(VALUE_PATH, 'utf8')); } catch (e) { _valueModel = null; }
  return _valueModel;
}

/* v1.7.12（v3）：分层 LSTD 价值模型 payoff——V_c(s) = α·local + (1−α)·global，payoff = ΔV × payoffScale[config]
 * 启用：PAYOFF_MODE=value；v3 回滚：VALUE_MODEL=v3；v2 对照/回滚：VALUE_MODEL=v2（旧 sigmoid+K 路径）
 * v3 训练：16 配置分层采集（records-v5/v2 生态），pre-only holdout AUC 0.838（v1 0.262 → v2 0.775 → v3 0.838，修复后口径）
 * 纪律：configKey 未知 → 纯 global（local 缺失自动回退，见 value-model.value）；A-2 断言在 lab 启动时校验已知 key */
const valueModel = require('./value-model');
const valueModelV4 = require('./value-model-v4'); // V4 HiCVN（value-hicvn@1）
function valuePayoff(world, xIsWolf) {
  // v1.7.16（V4.2 替换）：默认 v4（MLP 集成，AUC 0.8055 vs V3.1 0.7819，配对终裁 16/16 无劣化）；
  // v3/v2 保留回滚（VALUE_MODEL=v3 | v2）；σ 分桶单调 FAIL 已列入 V4.3/块 1 多样性增强（观察期补，不影响 ΔV 排序/幅度消费）
  try {
    if (process.env.VALUE_MODEL === 'v3') return valuePayoffV3(world, xIsWolf);
    if (process.env.VALUE_MODEL === 'v2') return valuePayoffV2(world, xIsWolf);
    return valuePayoffV4(world, xIsWolf);
  } catch (e) {
    // 1.7.17（生产 fail-open）：A-2/schema 断言 throw（lab 启动即暴露 bug）不允许穿透到生产投票——
    // 回退解析版 payoff（可用性优先）；lab 的 A-2 语义保留在加载层（loadV3/loadV4 启动时仍 throw）
    return payoffFor(world, xIsWolf);
  }
}
/* v2（旧 sigmoid+K 路径，VALUE_MODEL=v2 显式启用——默认已替换为 v4） */
function valuePayoffV2(world, xIsWolf) {
  const m = getValueModel();
  if (!m) return payoffFor(world, xIsWolf);
  if (world.faction === 'third') return payoffFor(world, xIsWolf); // v1.7.6：V 模型是好人视角，第三方用 thirdValue 启发式
  const sig = x => 1 / (1 + Math.exp(-x));
  const V = (R, S, M, N) => sig(m.w[0] + m.w[1] * R + m.w[2] * S + m.w[3] * M + m.w[4] * N + m.w[5] * R * S + m.w[6] * R * M + m.w[7] * S * M);
  const R = Math.max(1, world.wolfAlive), S = Math.max(1, world.godAlive), M = Math.max(1, world.villAlive);
  const N = world.wolfAlive + world.godAlive + world.villAlive;
  const dG = V(Math.max(0, R - 1), S, M, Math.max(0, N - 1)) - V(R, S, M, N);
  const dV = V(R, Math.max(0, S - 1), M, Math.max(0, N - 1)) - V(R, S, M, N);
  const dM = V(R, S, Math.max(0, M - 1), Math.max(0, N - 1)) - V(R, S, M, N);
  const pGod = S / (S + M), pVill = M / (S + M);
  const K = m.K || 1;
  if (world.faction === 'wolf') {
    // 1.7.17（V_wolf）：狼侧统一走 V_wolf（VALUE_MODEL=v2 回滚档同——消除不对称）
    return valuePayoffV4Wolf(world, xIsWolf, { R, S, M, cap: R + S + M, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit, info: world.info || null, cfg: world.configKey });
  }
  if (xIsWolf) return K * dG;
  return -K * (pGod * dV + pVill * dM);
}

/* v3 payoff：分层 LSTD 值函数（无 sigmoid，期望回报标度；第三方仍走 thirdValue 启发式——V 无第三方样本） */
function valuePayoffV3(world, xIsWolf) {
  const m = valueModel.loadV3();
  if (!m) return payoffFor(world, xIsWolf);
  if (world.faction === 'third') return payoffFor(world, xIsWolf);
  const cfg = world.configKey;
  if (!cfg) return payoffFor(world, xIsWolf); // 防御：房间无 cap/preset → 解析版
  if (!m.local[cfg]) {
    if (world.hasPreset) throw new Error(`[v3] unknown configKey "${cfg}" — lab 训练/推理不匹配（A-2）`);
    return payoffFor(world, xIsWolf); // 生产未训 cap（如 '10p'）→ 显式降级解析版（可用性优先，非静默）
  }
  const R = Math.max(0, world.wolfAlive), S = Math.max(0, world.godAlive), M = Math.max(0, world.villAlive);
  const cap = world.wolfInit + world.godInit + world.villInit;
  const N = Math.max(0, cap - R - S - M);
  const base = { R, S, M, N, cap, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit };
  const next = (dR, dS, dM) => ({ R: Math.max(0, R - dR), S: Math.max(0, S - dS), M: Math.max(0, M - dM), N: N + 1, cap, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit });
  const dG = valueModel.payoff(base, next(1, 0, 0), cfg); // 放逐狼 → 好人胜率升 → V 升 → 正
  const dV = valueModel.payoff(base, next(0, 1, 0), cfg);
  const dM = valueModel.payoff(base, next(0, 0, 1), cfg);
  const pGod = S / (S + M || 1), pVill = M / (S + M || 1);
  if (world.faction === 'wolf') {
    // 1.7.17（V_wolf）：狼侧统一走 V_wolf（P(狼胜)）——V3.1 无狼视角版，跨架构复用 V4 的 V_wolf；
    // 消除"狼用好人视角 V 预判好人"不对称（V3 狼侧原为 -dV/-dM 好人视角取反）
    return valuePayoffV4Wolf(world, xIsWolf, { R, S, M, cap, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit, info: world.info || null, cfg });
  }
  if (xIsWolf) return dG;
  return -(pGod * dV + pVill * dM);
}

/* V4 payoff（HiCVN）：V ∈ [0,1] 胜率概率语义；ΔV × payoffScale（sigmoid 压缩后 Δ 幅度小 → scale 反放大）
 * 启用：PAYOFF_MODE=value + VALUE_MODEL=v4；第三方/未知 cap → 解析版（与 V3 分支同纪律） */
function valuePayoffV4(world, xIsWolf) {
  const m = valueModelV4.loadV4();
  if (!m) return payoffFor(world, xIsWolf);
  if (world.faction === 'third') return payoffFor(world, xIsWolf); // V 无第三方样本，启发式
  const cfg = world.configKey;
  if (!cfg) return payoffFor(world, xIsWolf);
  if (!m.payoffScale[cfg]) {
    if (world.hasPreset) throw new Error(`[v4] unknown configKey "${cfg}" — lab 训练/推理不匹配（A-2）`);
    return payoffFor(world, xIsWolf); // 生产未训 cap → 显式降级解析版（可用性优先，非静默）
  }
  const R = Math.max(0, world.wolfAlive), S = Math.max(0, world.godAlive), M = Math.max(0, world.villAlive);
  const cap = world.wolfInit + world.godInit + world.villInit;
  const N = Math.max(0, cap - R - S - M);
  // V4.2 信息特征（world.info 与训练侧 rebuildEventStatesV5 同源；next 不变量——放逐身份的信息影响不模拟，
  // 差分二阶可接受，模型卡记录限制；非 info 模型 buildX 自动忽略该字段）
  const info = world.info || null;
  const base = { R, S, M, N, cap, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit, info };
  const next = (dR, dS, dM) => ({ R: Math.max(0, R - dR), S: Math.max(0, S - dS), M: Math.max(0, M - dM), N: N + 1, cap, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit, info });
  // 性能优化：V(base) 每调用只算 1 次（原 3×payoff 各算一次 V(prev)——MLP 4 成员前向贵，
  // 重复计算被放大；行为完全等价：payoff(prev,next) ≡ (V(next)−V(base))×scale（scale 已在 135 行断言）
  const vBase = valueModelV4.value(base, cfg);
  const sc = m.payoffScale[cfg];
  const dG = (valueModelV4.value(next(1, 0, 0), cfg) - vBase) * sc;
  const dV = (valueModelV4.value(next(0, 1, 0), cfg) - vBase) * sc;
  const dM = (valueModelV4.value(next(0, 0, 1), cfg) - vBase) * sc;
  const pGod = S / (S + M || 1), pVill = M / (S + M || 1);
  if (world.faction === 'wolf') {
    // 1.7.17（V_wolf）：狼侧用狼视角价值模型（P(狼胜)）——消除"狼用好人视角 V 预判好人"的不对称增强；
    // V_wolf 缺失 → 回退解析版（fail-open，见 valuePayoffV4Wolf）
    return valuePayoffV4Wolf(world, xIsWolf, { R, S, M, cap, wolf0: world.wolfInit, god0: world.godInit, vill0: world.villInit, info, cfg });
  }
  if (xIsWolf) return dG;
  return -(pGod * dV + pVill * dM);
}

/* 1.7.17（V_wolf）：狼侧 payoff——V_wolf = P(狼胜|s)，与 V_good 对称：
 *   x 为好人（放逐好人）→ pGod·dV + pVill·dM：V_wolf 视角放逐好人 → 狼胜率升（dV/dM 正）→ 狼收益正
 *   x 为狼（误投队友）→ dG：V_wolf 视角放逐狼 → 狼胜率降（dG 负）→ 负收益
 * 语义：V_wolf 是"狼自己的胜率评估"，狼据此前瞻——不再用好人视角模型预判好人行动。
 * fail-open：模型缺失/未训 cap → 解析版 payoffFor（生产可用性优先） */
function valuePayoffV4Wolf(world, xIsWolf, base) {
  const m = valueModelV4.loadV4Wolf();
  if (!m) return payoffFor(world, xIsWolf);
  if (world.faction === 'third') return payoffFor(world, xIsWolf);
  const cfg = base.cfg;
  const vBase = valueModelV4.valueWolf(base, cfg);
  const sc = m.payoffScale && m.payoffScale[cfg];
  if (!sc) return payoffFor(world, xIsWolf); // 未训 cap → 解析版
  const dG = (valueModelV4.valueWolf({ ...base, R: Math.max(0, base.R - 1), N: base.N + 1 }, cfg) - vBase) * sc;
  const dV = (valueModelV4.valueWolf({ ...base, S: Math.max(0, base.S - 1), N: base.N + 1 }, cfg) - vBase) * sc;
  const dM = (valueModelV4.valueWolf({ ...base, M: Math.max(0, base.M - 1), N: base.N + 1 }, cfg) - vBase) * sc;
  const pGod = base.S / (base.S + base.M || 1), pVill = base.M / (base.S + base.M || 1);
  if (!xIsWolf) return pGod * dV + pVill * dM; // 放逐好人 → V_wolf 视角：狼胜率升（dV/dM 正）→ 狼收益正（放逐好人对狼有利）
  return dG; // 放逐狼（队友）→ V_wolf 视角：狼胜率降（dG 负）→ 负收益；x 为狼即狼被放逐 → 误投队友损失
}

/**
 * world: { faction, teammates, scores:{id:Pwolf}, votes:{voter:target}, allVoters:[id], me,
 *         wolfAlive, godAlive, villAlive, wolfInit, godInit, villInit, payoffP, payoffQ, sellTarget }
 * state: 候选 id 数组
 * 返回：{ target, margin }（margin 为相对量：top1-top2 除以 W×单世界得分幅度；调用方用 0.05 相对阈值）
 */
function rolloutVote(world, state, rng, { worlds = 64, useValue } = {}) { // 1.8.0（人机三档）：useValue 按档位路由价值前瞻（undefined → 沿用 PAYOFF_MODE env）
  if (!state || state.length < 2) return null;
  // 1.7.3（P1-2）：rng 必须由调用方注入——兜底 Date.now 是原生墙钟，虚拟时钟实验室里会悄悄破掉确定性（B1-7 P0②）。
  if (!rng) throw new Error('rolloutVote requires injected rng（确定性纪律 B1-7 P0②）');
  const r = rng;
  // 1.7.4（Q2）：卖狼优先——pool 排除队友后 rv.target 永远不可能是卖狼目标，margin≥阈值时卖狼被静默架空；
  // 与 decideVote 的优先语义对齐（入口特判，pool 过滤前返回；margin=Infinity 保证调用方不回退）
  if (world.sellTarget && state.includes(world.sellTarget)) return { target: world.sellTarget, margin: Infinity };
  const isWolf = world.faction === 'wolf';
  const teammates = world.teammates || [];
  const pool = state.filter(id => !(isWolf && teammates.includes(id)));
  if (!pool.length) return null;
  const allVoters = (world.allVoters || []).filter(id => id !== world.me);
  if (allVoters.length < 2) return null;
  const sc = world.scores || {};
  // 1.7.17（视角多样性判定实验）：LAB_ROLLOUT_NOISE=σ → 模拟其他玩家投票时对 sc 注入高斯噪声（模拟"视角差异"）
  // 检验：rollout 的"自信错误"是否因单视角模拟（所有人用 bot 自己的 scores）——加噪后模拟更接近现实多 agent 异质
  const noiseSig = parseFloat(process.env.LAB_ROLLOUT_NOISE || '0');
  const noiseBuf = new Float64Array(allVoters.length * pool.length);
  let ni = 0;
  if (noiseSig > 0) {
    // Box-Muller 高斯（派生自 r，保持确定性）
    for (let i = 0; i < noiseBuf.length; i += 2) {
      const u1 = Math.max(1e-12, r.next()), u2 = r.next();
      noiseBuf[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * noiseSig;
      if (i + 1 < noiseBuf.length) noiseBuf[i + 1] = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2) * noiseSig;
    }
  }
  const scN = (cid) => { const s = sc[cid] == null ? 0.5 : sc[cid]; return noiseSig > 0 ? Math.max(0.001, Math.min(0.999, s + noiseBuf[ni++ % noiseBuf.length])) : s; };

  const W = pool.length > 10 ? Math.max(4, worlds >> 1) : worlds; // 预算感知
  const score = {};
  for (const x of pool) score[x] = 0;
  let scale = 0; // 得分幅度累积（margin 相对化用）

  for (let w = 0; w < W; w++) {
    // 1) 采样隐藏身份（伯努利，按 P(wolf)）
    const wolfSet = new Set();
    for (const x of pool) {
      const p = clamp(sc[x] == null ? 0.3 : sc[x], 0.05, 0.95);
      if (r.next() < p) wolfSet.add(x);
    }
    // 1.7.4（狼侧世界构造修复）：狼 bot 的信念采样会把队友标成好人（P(wolf)≈0.23，77% 概率），
    // 队友被当好人投票且"投队友"被记成收益（放逐好人）→ 狼 bot 反而倾向投队友。
    // 狼知道队友（规则内知识，B1-7 纪律允许）——采样后强制并入真实队友。
    if (world.faction === 'wolf') for (const t of world.teammates || []) wolfSet.add(t);
    // 2) 模拟其他玩家投票（不含 me）——v1.7.2（B-2）：好人分支加入"跟票集中"（优先投已有票的高分候选），
    //    与现实 decideVote 的 concentratedPick 一致（否则模拟比现实更"理性"，平票边缘的 payoff 估计失真）
    const counts = {};
    for (const voter of allVoters) {
      let pick = null;
      if (wolfSet.has(voter)) {
        let bv = Infinity;
        for (const c of pool) { if (teammates.includes(c)) continue; const s = scN(c); if (s < bv) { bv = s; pick = c; } }
      } else {
        let lead = null, leadN = 0;
        for (const k of Object.keys(counts)) if (counts[k] > leadN) { leadN = counts[k]; lead = k; } // 当前最高票
        let bv = -Infinity;
        for (const c of pool) { const s = scN(c); if (s > bv) bv = s; }
        const top = [];
        for (const c of pool) { const s = scN(c); if (Math.abs(s - bv) < 1e-9) top.push(c); }
        if (lead && top.includes(lead)) pick = lead;          // 已有票的高分候选 → 跟票（防分票）
        else if (top.length) pick = top[r.int(top.length)];   // 否则最高分（平局 rng 打破）
      }
      if (pick) counts[pick] = (counts[pick] || 0) + 1;
    }
    // 3) 逐候选评估"假设我投 X"（me 的票参与结算）——收益 = payoffFor(阵营分流, X 是否狼)：
    //    搭便车修正：若其他人已把 X 投成最高票，投 X 的得分仍按"X 被放逐"计（协作而非规避）；
    //    风险修正：X 被放逐且是好人 → 投 X 扣分；top≠X → 0（投 X 未促成 X 放逐）
    let scaleW = 0;
    for (const x of pool) {
      const c = Object.assign({}, counts, { [x]: (counts[x] || 0) + 1 });
      let top = null, topN = 0;
      for (const k of Object.keys(c)) if (c[k] > topN) { topN = c[k]; top = k; }
      if (!top) continue;
      if (top === x) {
        // 1.7.4（Q1）：阵营分流——此前狼 bot 也在用好人视角 payoff（放逐狼+3），与 decideVote argmin 直接打架
        // 1.7.4（二期）：PAYOFF_MODE=value 时用数据驱动 V 差分，否则解析幂律（默认 p=1,q=0）
        const useVal = opts.useValue !== undefined ? opts.useValue : process.env.PAYOFF_MODE === 'value'; // 1.8.0（人机三档）：简单→解析版 payoffFor；普通/困难→V_wolf（env 门控保留为默认）
        const g = useVal ? valuePayoff(world, wolfSet.has(x)) : payoffFor(world, wolfSet.has(x));
        score[x] += g;
        scaleW += Math.abs(g);
      }
    }
    scale += scaleW / Math.max(1, pool.length);
  }
  // 返回得分最高候选（平局用 rng 打破——派生 RNG 保证确定性）；margin 相对化（1.7.4）：
  // 绝对阈值 2 相对 ±W×3 的总分尺度近乎恒真，fallback 极少触发——改为 margin/(W×scale)，调用方用 0.05 相对阈值
  let best = null, bs = -Infinity, second = -Infinity;
  for (const x of pool) {
    const s = score[x];
    if (s > bs) { second = bs; bs = s; best = x; }
    else if (s > second) second = s;
  }
  const scaleNorm = Math.max(1e-9, scale / Math.max(1, W));
  return { target: best, margin: best ? (bs - second) / (W * scaleNorm) : 0 };
}

module.exports = { rolloutVote, payoffFor }; // 1.7.4：payoffFor 导出供语义验证/诊断
