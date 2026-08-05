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
    close() { ws.end(); },
  };
}
module.exports = { createRecorder };
