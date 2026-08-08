'use strict';
/* =========================================================================
 * test/lab/core/room-runner.js —— 单局执行器（v1.7.1：虚拟时间版）
 *   runOneLabGame(cfg)：完整对局 → GameRecord。
 *   虚拟模式：clock.setMode('virtual') 后，驱动只推时钟（tickNext），
 *   阶段超时/bot 延迟全部按虚拟时间走，游戏自己走完（1 局墙钟 ≈0.2~1s）。
 *   seed 注入：每局重置 global.rng（seedHash），配对/确定性双跑同 seed 完全一致。
 * ========================================================================= */
const fs = require('fs');
const Game = require('../../../game.js');
const clock = require('../../../server/clock');
const { createRng } = require('../../../server/ai/rng.js');

/* seed → 全局 RNG 重置：保证"同 seed 两遍，房间 RNG/房间号/调度时序全部一致" */
function seedHash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function buildBotLine(cap, level) { return Array(cap - 1).fill(level); }

/** 跑一局完整对局到终局，返回 GameRecord。cfg: {cap, counts, winMode, botLevel|botLine, seed, gameId, scenario, sampleFile, timeoutMs} */
async function runOneLabGame(cfg) {
  global.rng = createRng(seedHash(cfg.seed));                 // ★ 每局重置（配对/确定性双跑的正确姿势）
  const r = Game.createRoom('房主');
  const room = Game.rooms.get(r.roomId);
  const host = r.playerId;
  const t0 = Date.now();
  let guard = 0; // v1.8.0：移到 try 外——catch 分支的 perf 需要它（驱动循环计数）
  try {
    if (cfg.sampleFile) { room.labGameId = cfg.gameId; room.labSampleFile = cfg.sampleFile; } // vote 样本采集（game.js 钩子）
  if (cfg.loverMode) room.loverMode = cfg.loverMode; // v2（M1）：恋人机制模式（off/classic/v2），lab 可配
  if (cfg.presetKey) room.presetKey = cfg.presetKey; // v3：配置标识（rollout payoff 路由键）
  if (cfg.loverTest) room.loverTest = cfg.loverTest; // A/B 注入（M3.5）：'cupid-dead-n1' / 'cupid-immortal'
  if (cfg.loverLocked) room.loverLocked = !!cfg.loverLocked; // A/B 注入（M3.5）：解绑禁用（G3）
    for (const [a, d] of [
      ['settings', { sheriff: false, winMode: cfg.winMode || 'edge', tieRule: 'pk', botMode: 'auto' }],
      ['setCounts', { counts: cfg.counts }],
      ['setCap', { cap: cfg.cap }],
    ]) {
      const res = Game.handleAction(room.id, host, a, d);
      if (!(res && res.ok)) throw { kind: 'config', msg: `${a}: ${JSON.stringify(res)}` };
    }
    const line = cfg.botLine || buildBotLine(cfg.cap, cfg.botLevel || 'simulate');
    for (const lv of line) {
      const res = Game.handleAction(room.id, host, 'add_bot', { level: lv });
      if (!(res && res.ok)) throw { kind: 'config', msg: `add_bot: ${JSON.stringify(res)}` };
    }
    let res = Game.handleAction(room.id, host, 'start');
    if (!(res && res.ok)) throw { kind: 'config', msg: `start: ${JSON.stringify(res)}` };
    res = Game.handleAction(room.id, host, 'hostPick', { role: 'random' });
    if (!(res && res.ok)) throw { kind: 'config', msg: `hostPick: ${JSON.stringify(res)}` };

    // ---- 驱动到终局：虚拟模式无脑推时钟，游戏自动跑完 ----
    const v = clock.isVirtual();
    const v0 = clock.now();
    while (room.phase !== 'ended') {
      if (++guard > 50000) throw { kind: 'stall', msg: `驱动超限 ${room.phase}/${room.nightStep}` };
      if (v && clock.now() - v0 > (cfg.timeoutMs || 60 * 60 * 1000)) throw { kind: 'stall', msg: `虚拟时间超限 ${room.phase}` };
      if (v && Date.now() - t0 > (cfg.wallBudgetMs || 8000)) throw { kind: 'wall', msg: `墙钟超限 ${Date.now() - t0}ms phase=${room.phase}（决策性能退化或卡死，见 perf.ticks）` }; // v1.8.0：虚拟模式墙钟兜底（虚拟时间与墙钟解耦，决策慢不会触发虚拟超限）
      if (v) {
        if (!clock.hasNext()) {                              // 无定时器且未结束 → 卡死兜底
          const r2 = Game.handleAdvance(room.id, host);
          if (!(r2 && r2.ok)) throw { kind: 'stall', msg: `卡死 phase=${room.phase} step=${room.nightStep}` };
          continue;
        }
        clock.tickNext();
        await new Promise(r3 => setImmediate(r3));           // 让渡 microtask
      } else {
        const ph = room.phase;                               // 真实模式：沿用旧驱动
        if (['morning','discuss','handover','lastword','sheriff_campaign','pk_speech'].includes(ph)) Game.handleAdvance(room.id, host);
        else if (['vote','sheriff_vote','pk_vote'].includes(ph) && !room.votes.hasOwnProperty(host)) Game.handleAction(room.id, host, 'vote', { target: null });
        await new Promise(r3 => setTimeout(r3, 50));
      }
    }
    // ---- 收集 GameRecord（事件流来自 game.js 已有的 pushEvent）----
    const roles = (room.endInfo && room.endInfo.roles) || [];
    const players = roles.map((x, i) => {
      const rp = room.players.find(p => p.id === x.id);
      return { seat: x.seat || (i + 1), id: x.id, role: x.role, roleKey: rp ? rp.role : null, camp: x.camp, isBot: !!x.isBot }; // 1.7.4：roleKey=真实角色（英文，供 V 重建/训练标签）
    });
    const fk = (room.events || []).find(e => e.type === 'wolf_kill' && e.night === 1);
    const firstKill = fk ? { id: fk.data.kill, camp: roles.find(x => x.id === fk.data.kill) ? roles.find(x => x.id === fk.data.kill).camp : '?' } : null;
    // v2（M1）：恋人机制元数据（M3 时序敏感性分析：丘比特死亡轮次 / 解绑 / 权能）
    const lv = room.loverMode === 'v2' && room.loverV2 ? { power: room.loverV2.power, unbindUsed: room.loverV2.unbind.used, unbindNight: room.loverV2.timeline.unbindNight, cupidDeadNight: room.loverV2.timeline.cupidDeadNight } : null;
    return {
      schema: 'lab.game-record@1', gameId: cfg.gameId, seed: cfg.seed, scenario: cfg.scenario || 'lab',
      startedAt: new Date(t0).toISOString(),       durMs: Date.now() - t0,
      perf: { ticks: guard, wallMs: Date.now() - t0 }, // v1.8.0：决策性能信号（墙钟/虚拟时间解耦——超时诊断用）
      config: { cap: cfg.cap, counts: cfg.counts, botLine: line, winMode: cfg.winMode || 'edge', name: cfg.name || null, loverMode: room.loverMode, presetKey: room.presetKey || null },
      result: { winner: room.endInfo ? room.endInfo.winner : null, timeout: false, error: null, ...(lv ? { loverMeta: lv } : {}) },
      players,
      seerHistory: Array.isArray(room.seerHistory) ? room.seerHistory.map(h => ({ target: h.target, result: h.result, night: h.night })) : null, // v4.2：查验历史（信息特征 checkedWolves/checkedCount——训练侧数据源）
      events: (room.events || []).map(e => ({
        i: 0, t: e.type, night: e.night || 0,
        actor: (e.data && (e.data.shooter || e.data.actor)) || null,
        target: (e.data && (e.data.kill != null ? e.data.kill : e.data.exiled)) || null,
        data: e.data || {},
      })),
      firstKill,
      samples: (cfg.flushSamples === false && room.labSampleBuf && room.labSampleBuf.length) ? room.labSampleBuf.slice() : null, // v1.8.0：worker 模式样本回传（主线程统一写盘，防多 worker 竞态）
      rolloutAudit: (room._rolloutAuditBuf && room._rolloutAuditBuf.length) ? room._rolloutAuditBuf.slice() : null, // 1.7.17：rollout 分歧审计（LAB_AUDIT_ROLLOUT=2）
    };
  } catch (e) {
    return { schema: 'lab.game-record@1', gameId: cfg.gameId, seed: cfg.seed, scenario: cfg.scenario || 'lab',
      startedAt: new Date(t0).toISOString(), durMs: Date.now() - t0,
      perf: { ticks: guard, wallMs: Date.now() - t0 }, // v1.8.0：catch 分支同样带 perf（超时/卡死局的诊断信号）
      config: { cap: cfg.cap, counts: cfg.counts, botLine: cfg.botLine || [], winMode: cfg.winMode || 'edge', name: cfg.name || null },
      result: { winner: null, timeout: true, error: e.kind ? e : { kind: 'engine', msg: e.message } },
      players: [], events: [], firstKill: null,
      samples: (cfg.flushSamples === false && room.labSampleBuf && room.labSampleBuf.length) ? room.labSampleBuf.slice() : null,
      rolloutAudit: (room._rolloutAuditBuf && room._rolloutAuditBuf.length) ? room._rolloutAuditBuf.slice() : null }; // 1.7.17：rollout 分歧审计（LAB_AUDIT_ROLLOUT=2）
  } finally {
    if (cfg.flushSamples !== false && room.labSampleBuf && room.labSampleBuf.length) { // flush 投票样本（v1.8.0：worker 模式 flushSamples=false → 样本随 GameRecord 回传主线程统一写盘）
      try { fs.appendFileSync(room.labSampleFile, room.labSampleBuf.join('\n') + '\n'); } catch (e) { /* 采集失败不影响对局 */ }
    }
    clock.clearAll(); // v1.7.2（A-4）：清空虚拟时钟残留定时器；v1.8.0 起 runPoolParallel 用 worker 进程隔离（无并发干扰），runPool 串行路径仍受益于清理（防队列线性膨胀 O(n) 插入退化）
    Game.rooms.delete(room.id);   // 引擎无公开销毁接口，直接清 Map
  }
}
module.exports = { runOneLabGame, seedHash };
