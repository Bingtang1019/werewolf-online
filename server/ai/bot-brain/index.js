// bot-brain 拆分：index.js 聚合入口——勿手改，重新运行 tools/split-bot-brain.js
'use strict';
const shared = require('./shared');
const ctx = shared.ctx;
const modMemory = require('./memory');
const modVote = require('./vote');
const modSmart = require('./smart');
const modTalk = require('./talk');
const modAttitudes = require('./attitudes');
const modMain = require('./main');

// 注册全部函数到 ctx（供跨模块引用）
for (const k of Object.keys(shared.sharedFns || {})) ctx[k] = shared.sharedFns[k];
for (const k of Object.keys(modMemory)) ctx[k] = modMemory[k];
for (const k of Object.keys(modVote)) ctx[k] = modVote[k];
for (const k of Object.keys(modSmart)) ctx[k] = modSmart[k];
for (const k of Object.keys(modTalk)) ctx[k] = modTalk[k];
for (const k of Object.keys(modAttitudes)) ctx[k] = modAttitudes[k];
for (const k of Object.keys(modMain)) ctx[k] = modMain[k];

// 聚合导出（与原 bot-brain.js 的 module.exports 一致）
module.exports = { createBotDecision: ctx.createBotDecision, botWolfChat: ctx.botWolfChat, factionOf: ctx.factionOf, loverPartner: ctx.loverPartner, resetBotPerGame: ctx.resetBotPerGame, injectGrudge: ctx.injectGrudge };
