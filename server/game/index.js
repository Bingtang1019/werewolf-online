// 自动生成（game.js 拆分——index 聚合导出，勿手改，重新运行 tools/split-game.js）

const shared = require('./shared');
require('./flow');
require('./vote');
require('./chat');
require('./actions');
require('./bot');
require('./view');

module.exports = {
  debugRoom: shared.ctx["debugRoom"],
  ROLE_INFO: shared.ROLE_INFO, rooms: shared.rooms, createRoom: shared.ctx["createRoom"], joinRoom: shared.ctx["joinRoom"], handleAction: shared.ctx["handleAction"], handleChat: shared.ctx["handleChat"], handleAdvance: shared.ctx["handleAdvance"], handleLeave: shared.ctx["handleLeave"], handleKick: shared.ctx["handleKick"], viewFor: shared.ctx["viewFor"], resumeRoom: shared.ctx["resumeRoom"], byToken: shared.ctx["byToken"], removePlayer: shared.ctx["removePlayer"], handleMusic: shared.ctx["handleMusic"], // 安全加固（C1/C2/C3）：token 定位玩家；v1.7.21：断线超时清理用 removePlayer；v1.7.25：房间全局播放控制
  checkWin: shared.ctx["checkWin"], // 1.7.4：导出供规则测试/实验室直接判定
  // v1.6.1：钩子用 setter 导出（CommonJS 值导出会让外部赋值不生效）
  setOnChange: shared.setOnChange,
  setOnBroken: shared.setOnBroken,
  addMessage: shared.ctx["addMessage"],
  // 1.7.0（B1-2）：lab 平台——批量落盘 vote 样本（房间结束时 flush 剩余）
  flushLabSamples: shared.ctx["flushLabSamples"],
};

