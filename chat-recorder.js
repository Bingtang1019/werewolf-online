'use strict';
/* =========================================================================
 * chat-recorder.js — 真人玩家聊天记录收集器（1.8.0 NLU 语料冷启动数据源）
 * 触发：game.js chatAction 中由真人发言（!p.isBot）调用；bot 发言不记录
 *       （lab 生态语料由 LLM 生成/模板渲染另行处理，真人语料必须从真人局采集）
 * 输出：data/chat-logs/human-chat.jsonl（JSONL 追加；CHAT_RECORD=0 关闭；超 100MB 滚动）
 * 用途：1.8.0 NLU 训练原始语料（意图/槽位标注前）+ 活人感语料候选
 * 隐私：仅记录对局内字段（文本/座位/角色/频道/天数/配置）；pid 为会话级随机
 *       玩家标识（非账号），用于同局内跨消息关联；不记录任何账号/昵称映射
 * 纪律：写盘失败一律静默降级——绝不阻塞游戏主流程
 * ========================================================================= */
const fs = require('fs');
const path = require('path');

const ENABLED = process.env.CHAT_RECORD !== '0';
const MAX_BYTES = parseInt(process.env.CHAT_RECORD_MAX || '100000000', 10); // 100MB
const LOG_DIR = path.join(__dirname, 'data', 'chat-logs');
const LOG_FILE = path.join(LOG_DIR, 'human-chat.jsonl');

let _fd = null;

function ensure() {
  if (_fd) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // 超限滚动：human-chat.jsonl → human-chat.1.jsonl → .2 ...
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
        let i = 1;
        while (fs.existsSync(path.join(LOG_DIR, 'human-chat.' + i + '.jsonl'))) i++;
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'human-chat.' + i + '.jsonl'));
      }
    } catch (e) { /* 首次创建：文件不存在，跳过滚动 */ }
    _fd = fs.openSync(LOG_FILE, 'a');
    return true;
  } catch (e) {
    return false; // 目录/文件不可写 → 静默降级
  }
}

/** 记录一条真人发言（调用方已过滤 bot；任何失败静默——绝不阻塞对局） */
function record(room, p, ch, text) {
  if (!ENABLED) return;
  if (!ensure()) return;
  const cfg = room.config || {};
  const st = room.settings || {};
  const rec = {
    ts: Date.now(),
    roomId: room.id || null,
    day: room.dayNum || 0,
    phase: room.phase || null,
    ch: ch || 'all',
    seat: p.seat != null ? p.seat : null,
    pid: p.id,
    name: p.name || '', // v1.7.18: 玩家名——按"人机"前缀剔除测试 bot 发言（收集器原版缺名字段，无法按名筛选）
    role: p.role || null,
    cap: cfg.cap != null ? cfg.cap : (st.cap != null ? st.cap : null),
    preset: cfg.presetKey || cfg.preset || null,
    text: String(text).slice(0, 200),
  };
  try {
    fs.writeSync(_fd, JSON.stringify(rec) + '\n');
  } catch (e) { /* 静默 */ }
}

module.exports = { record };
