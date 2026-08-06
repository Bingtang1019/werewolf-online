'use strict';
/* 流式落盘 + checkpoint（已完成的 gameId 集合）——2000 局中断不废，续跑跳过已完成 */
const fs = require('fs');
const path = require('path');

function createRecorder(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ws = fs.createWriteStream(file, { flags: 'a' });
  const done = new Set();
  if (fs.existsSync(file)) { // 续跑：扫描已有 gameId
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try { done.add(JSON.parse(line).gameId); } catch (e) { /* 忽略坏行 */ }
    }
  }
  return {
    write(rec) { ws.write(JSON.stringify(rec) + '\n'); done.add(rec.gameId); },
    has(id) { return done.has(id); },
    size: () => done.size,
    // v1.7.9：close 返回 finish promise——lab.js/scenario 必须 await 后再 process.exit，
    // 否则异步写盘未 flush 会被 exit 抢跑，万局约丢最后 1 条（goodlover 跑实测 9999/10000）
    close() { return new Promise(res => { ws.once('finish', res); ws.once('error', res); ws.end(); }); },
  };
}
module.exports = { createRecorder };
