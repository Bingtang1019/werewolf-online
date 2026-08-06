'use strict';
/* =========================================================================
 * server/clock.js —— 可注入时钟单例（v1.7.1）
 *   setMode('real')    生产：真实时间，行为零变化（默认）
 *   setMode('virtual') 测试/实验室：虚拟时间，墙钟不随游戏时间流逝
 * game.js / bot-brain.js 所有定时器与时间戳一律经此模块，禁止裸用全局。
 * 切换模式须在无活动房间时进行（已挂定时器不会被迁移）。
 * ========================================================================= */
const real = { setTimeout, clearTimeout, now: Date.now };

class VirtualClock {
  constructor() { this._now = 0; this._q = []; this._seq = 0; }
  setTimeout(fn, ms, ...args) {
    const at = this._now + Math.max(0, ms | 0);
    const id = ++this._seq;
    let i = this._q.length;
    while (i > 0 && this._q[i - 1].at > at) i--;   // 按触发时刻有序
    this._q.splice(i, 0, { id, at, fn, args });
    return id;
  }
  clearTimeout(id) { const i = this._q.findIndex(t => t.id === id); if (i >= 0) this._q.splice(i, 1); }
  now() { return this._now; }
  hasNext() { return this._q.length > 0; }
  /** 跳到下一个定时器到期时刻并同步执行其回调；返回是否执行了 */
  tickNext() {
    if (!this._q.length) return false;
    const t = this._q.shift();
    this._now = t.at;
    t.fn(...t.args);
    return true;
  }
  /** 推进 now+ms；期间新设的 ≤target 定时器继续执行（同步快进） */
  tick(ms) {
    const target = this._now + ms;
    let guard = 0;
    while (this._q.length) {
      const t = this._q[0];
      if (t.at > target) break;
      if (++guard > 1e6) throw new Error('虚拟时钟 tick 死循环（疑似 0ms 自递归定时器）');
      this._q.shift(); this._now = t.at; t.fn(...t.args);
    }
    this._now = target;
  }
  sleep(ms) { return new Promise(r => this.setTimeout(r, ms)); }
  clearAll() { this._q = []; } // v1.7.2（A-4）：清空队列（跑量场景每局 finally 清理残留定时器，防队列线性膨胀）
}

let impl = real;
const clock = {
  setTimeout: (fn, ms, ...a) => impl.setTimeout(fn, ms, ...a),
  clearTimeout: id => impl.clearTimeout(id),
  now: () => impl.now(),
  setMode(mode) { impl = mode === 'virtual' ? new VirtualClock() : real; },
  isVirtual: () => impl !== real,
  tickNext: () => (impl !== real ? impl.tickNext() : false),
  tick: ms => { if (impl !== real) impl.tick(ms); },
  hasNext: () => (impl !== real ? impl.hasNext() : false),
  clearAll: () => { if (impl !== real) impl.clearAll(); },
  sleep: ms => (impl !== real ? impl.sleep(ms) : new Promise(r => setTimeout(r, ms))),
};
module.exports = clock;
