// client.js 拆分（方案C：正则找函数名 + 独立函数体提取）
const fs = require('fs');
const path = require('path');
const proj = path.resolve(__dirname, '..');
const clientPath = path.join(proj, 'public', 'client.js');
if (!fs.existsSync(clientPath)) {
  console.error('[split-client] public/client.js 不存在（前端已拆分），禁止运行，避免覆盖 public/js/*');
  process.exit(1);
}
const src = fs.readFileSync(clientPath, 'utf8');

// 模块归属
const MOD = {};
const add = (mod, names) => names.forEach(n => MOD[n] = mod);
add('render', ['render','applyTheme','renderPlayers','renderInfo','animateTotals','deathListHtml','nameOf','renderPanel','renderLobby','roleCountsHtml','renderReveal','renderNight','hunterShotHtml','renderMorning','renderLastword','renderHandover','renderCampaign','renderSheriffVote','renderDiscuss','renderVote','renderPkSpeech','renderHunterShot','renderEnded','campClass','showOverlay','hideOverlay','onStateChange','snapshotEditing','restoreEditing']);
add('chat', ['chatVh','chatHalfH','chatHideY','chatHalfY','chatYNow','applyChatY','chatSetOpen','chatToggle','chatDragStart','chatDragMove','chatDragEnd','updateChatHandle','scrollChatIfNeeded','renderChat','quickPhrase']);
add('game', ['alivePlayers','playerOf','pickPlayerHotkey','hostPick','doThiefPick','doCupidPick','doPick','setWolfKill','setWolfCharm','doWolfConfirm','witchSave','witchPoison','hunterShoot','sendLastword','handoverPick','castVote','onCapInput','onCapChange','countChange','onSetting','onWinMode','onTieRule','onThief','kick','markCodeInvalid','showCreatedOverlay','renderBreadcrumb','shouldForceContinue','diffPlayers','openRolePop','closeRolePop','buildRulesList']);
add('fx', ['lessMotion','toggleLessMotion','pickIconFor','showNetBanner','hideNetBanner','spawnFx','fxForAction','fxTarget','collectStats','resetStats','statStats','ambientFx','setFontScale','setBotLevel','inviteUrl','copyInvite','shareInvite','flySheriffBadge','sheriffPop','hotkeyConfirmPhase','lockButton','ensureAudio','setTTS','speak','askNotify','notifyTurn','sfxOk','tone','noiseBurst','sfxWolf','sfxMorning','sfxTick','sfxHeavy','sfxFlip','sfxEnter','setSfxMaster','setSfxFlag','renderSoundPop','toggleSoundPop']);
add('music', ['musicAudio','toggleMusicPop','renderMusicPop','mpItemHtml','updateMusicNow','postMusic','musicSync','pickSong','mpNext','mpPrev','mpToggle','mpSetMode','mpModeBtn','mpPlayLocal','mpPlay']);
add('main', ['applyView','resetPollTimer','currentPollMs','ensurePollTimer','needsFastPoll','pollNow','connectSSE','init','sendChat','enterRoom']);
add('core', ['escapeHtml','toast','nextToast','saveSession','loadSession','clearSession','deviceId','randNick','fillNick','nickValue','cycleMood','genOpId','lastChatTs']);

// ---------- 收集所有函数定义位置（正则） ----------
const fnRe = /\n\s*function\s+(\w+)\s*\(/g;
let m, fns = [];
while ((m = fnRe.exec(src))) fns.push({ name: m[1], start: m.index + 1 });

// 去重（保留第一个）——按名字
const seen = {};
fns = fns.filter(f => { if (seen[f.name]) return false; seen[f.name] = true; return true; });
console.log('收集到函数:', fns.length);

// ---------- 函数体提取（正则感知的括号深度） ----------
function extractBody(code, start) {
  // 找到函数体 {（跳过参数）
  let bracePos = -1, i = start, inStr = null;
  while (i < code.length) {
    const ch = code[i];
    if (inStr) { if (ch === inStr && code[i-1] !== '\\') inStr = null; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '{') { bracePos = i; break; }
    i++;
  }
  if (bracePos < 0) return null;
  let depth = 1, j = bracePos + 1;
  inStr = null;
  while (j < code.length) {
    const ch = code[j];
    if (inStr) {
      if (inStr === '`') {
        if (ch === '`' && code[j-1] !== '\\') { inStr = null; j++; continue; }
        if (ch === '$' && code[j+1] === '{') {
          // 模板表达式：子扫描到配平的 }（含嵌套 {}
          let d2 = 1, k2 = j + 2;
          let subStr = null;
          while (k2 < code.length) {
            const sc = code[k2];
            if (subStr) { if (sc === subStr && code[k2-1] !== '\\') subStr = null; k2++; continue; }
            if (sc === '"' || sc === "'" || sc === '`') { subStr = sc; k2++; continue; }
            if (sc === '{') { d2++; k2++; continue; }
            if (sc === '}') { d2--; if (d2 === 0) break; k2++; continue; }
            k2++;
          }
          j = k2 + 1;
          continue;
        }
        j++; continue;
      }
      else if (ch === inStr && code[j-1] !== '\\') { inStr = null; j++; continue; }
      j++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; j++; continue; }
    if (ch === '/' && code[j+1] === '/') { while (j < code.length && code[j] !== '\n') j++; continue; }
    if (ch === '/' && code[j+1] === '*') { j += 2; while (j < code.length && !(code[j] === '*' && code[j+1] === '/')) j++; j += 2; continue; }
    if (ch === '/') {
      // 正则判断：前一个非空白是运算符/括号/逗号/冒号等
      let prev = '';
      for (let p = j - 1; p >= 0; p--) { if (!/\s/.test(code[p])) { prev = code[p]; break; } }
      if (/[\(\[=,:!&|?+\-*%<>{};]/.test(prev)) {
        j++;
        let inCls = false;
        while (j < code.length) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === '[' && !inCls) { inCls = true; j++; continue; }
          if (code[j] === ']' && inCls) { inCls = false; j++; continue; }
          if (code[j] === '/' && !inCls) break;
          j++;
        }
        j++;
        continue;
      }
    }
    if (ch === '{') { depth++; j++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return { end: j + 1, body: code.slice(start, j + 1) }; j++; continue; }
    j++;
  }
  return null;
}

// ---------- 分段：函数段 + 代码段 ----------
const segs = [];
for (const f of fns) {
  const r = extractBody(src, f.start);
  if (!r) { console.error('❌ 提取失败: ' + f.name + ' @' + f.start); process.exit(1); }
  f.end = r.end;
  segs.push({ type: 'fn', name: f.name, start: f.start, end: f.end, mod: MOD[f.name] || 'core' });
}
// 补代码段（函数之间的部分 → core）
segs.sort((a, b) => a.start - b.start);
const codeSegs = [];
let prev = 0;
for (const s of segs) {
  if (s.start > prev) codeSegs.push({ type: 'code', start: prev, end: s.start, mod: 'core' });
  prev = s.end;
}
if (prev < src.length) codeSegs.push({ type: 'code', start: prev, end: src.length, mod: 'core' });
const all = [...segs, ...codeSegs].sort((a, b) => a.start - b.start);

// ---------- 生成文件 ----------
const outDir = path.join(proj, 'public', 'js');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const fileNames = { core: 'core.js', render: 'render.js', chat: 'chat.js', game: 'game-actions.js', fx: 'fx-sound.js', music: 'music.js', main: 'main.js' };
const hdr = (n) => '// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）\n// 依赖：core.js 先行加载\n\n';
const parts = {};
for (const k of Object.keys(fileNames)) parts[k] = [];
for (const s of all) parts[s.mod].push(src.slice(s.start, s.end));
for (const [k, fn] of Object.entries(fileNames)) {
  const body = parts[k].join('\n\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(path.join(outDir, fn), hdr(fn) + body + '\n', 'utf8');
  console.log('✅ ' + fn + '（' + parts[k].length + ' 段, ' + body.length + ' 字符）');
}
// 校验：所有段拼接 == 源文件（零丢失）
const reassembled = all.map(s => src.slice(s.start, s.end)).join('');
console.log('\n✅ 重组校验:', reassembled === src ? '完全一致（零丢失）' : '❌ 不一致！');
console.log('源文件:', src.length, '重组:', reassembled.length);
