'use strict';
/* =========================================================================
 * 狼人杀 网页客户端
 * 通过轮询 /api/state 获取状态，POST /api/action 发送操作
 * ========================================================================= */

const $ = id => document.getElementById(id);
let view = null;
let roomId = null;
let me = null;
let pollTimer = null;
let pollMs = 0;
let pollBusy = false; // 轮询在途标记：慢网络下跳过重叠轮询，防止增量叠加
let draft = {};       // 当前面板的草稿选择 { target, target2, kill, charm }
let lastPhaseKey = null; // 上次渲染的阶段标识（变化时清空草稿）
let chatTab = 'all';
let lastChatCount = -1;
let lastChatTab = null; // 上次渲染的频道，防
const lastTabTs = {}; // 各频道最后已读消息时间戳（红点）止两频道消息数恰好相同时切 tab 不重绘
let toastTimer = null;

/* ---------------------------- 工具 ---------------------------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* 类型化 toast：info/success/error/系统四色；多条排队依次显示（33/34/35） */
const toastQueue = [];
function toast(msg, type) {
  const t = $('toast');
  if (!t) return;
  toastQueue.push({ msg: String(msg), type: type || 'info' });
  if (!toastTimer) nextToast();
}
function nextToast() {
  const t = $('toast');
  if (!t || !toastQueue.length) { toastTimer = null; return; }
  const item = toastQueue.shift();
  t.textContent = item.msg;
  t.className = 'toast-' + (item.type || 'info');
  t.classList.remove('hidden', 'leaving');
  const dur = item.type === 'error' ? 4000 : 2600;
  toastTimer = setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => { t.classList.add('hidden'); nextToast(); }, 260);
  }, dur);
}
function saveSession() { try { localStorage.setItem('ww_session', JSON.stringify({ room: roomId, me })); } catch (e) {} }
function loadSession() { try { return JSON.parse(localStorage.getItem('ww_session')); } catch (e) { return null; } }
function clearSession() { try { localStorage.removeItem('ww_session'); } catch (e) {} }

const PHASE_TEXT = {
  lobby: '🏠 房间准备中', reveal: '🃏 身份展示', night: '🌙 夜晚',
  morning: '🌅 天亮公告', lastword: '💬 遗言', handover: '👮 警徽移交',
  sheriff_campaign: '🗳️ 警长竞选（报名）', sheriff_vote: '🗳️ 警长竞选（投票）',
  discuss: '☀️ 白天发言', vote: '🗳️ 放逐投票', pk_speech: '⚔️ PK 发言', pk_vote: '🗳️ PK 投票',
  hunter_shot: '🔫 猎人开枪', ended: '🏁 游戏结束',
};
const DEATH_TEXT = {
  wolf: '被狼人杀害', poison: '被女巫毒杀', exile: '被投票放逐', shoot: '被猎人枪杀',
  charm: '被狼美人魅惑带走', lover: '殉情', dream: '随摄梦人出局', left: '离开游戏',
};
const ROLE_NAMES = {
  villager: '平民', seer: '预言家', witch: '女巫', hunter: '猎人', dreamer: '摄梦人',
  guard: '守卫', wolf: '狼人', wolfBeauty: '狼美人', thief: '盗贼', cupid: '丘比特',
};
// 职业→阵营配色（good/wolf/third），用于职业配置列表/身份展示卡/玩家角色标签
const ROLE_CAMP = { villager: 'good', seer: 'good', witch: 'good', hunter: 'good', dreamer: 'good', guard: 'good', wolf: 'wolf', wolfBeauty: 'wolf', cupid: 'third' };
const ROLE_CAMP_TEXT = { '平民': 'good', '预言家': 'good', '女巫': 'good', '猎人': 'good', '摄梦人': 'good', '守卫': 'good', '狼人': 'wolf', '狼美人': 'wolf', '丘比特': 'third' };
// 职业图标（key→emoji / 中文名→emoji）
const ROLE_EMOJI = { villager: '🏡', seer: '🔮', witch: '🧪', hunter: '🔫', dreamer: '😴', guard: '🛡️', wolf: '🐺', wolfBeauty: '🌹', cupid: '💘', thief: '🃏' };
const ROLE_EMOJI_TEXT = { '平民': '🏡', '预言家': '🔮', '女巫': '🧪', '猎人': '🔫', '摄梦人': '😴', '守卫': '🛡️', '狼人': '🐺', '狼美人': '🌹', '丘比特': '💘', '盗贼': '🃏' };
// 盗贼“窃走”文案：各职业的被窃之物
const THIEF_ITEM = { villager: '身份', seer: '水晶球', witch: '魔药', hunter: '猎枪', dreamer: '幻境', guard: '护盾', wolf: '爪牙', wolfBeauty: '魅力', cupid: '弓箭' };
// 按座位号固定的动物头像
const SEAT_AVATARS = ['🦉', '🐱', '🐶', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐰', '🦄', '🐙', '🐳', '🦋'];
const avatarOf = p => {
  const n = p.seat ? p.seat - 1 : (p.id ? p.id.charCodeAt(0) : 0);
  return SEAT_AVATARS[Math.abs(n) % SEAT_AVATARS.length];
};
// 心情表情（点击自己的表情按钮循环切换，再点到底即关闭）
const MOODS = ['😀', '😨', '😤', '😭', '😏', '🤔', '😇', '🤡', '😴', '😱', '🥳', '🕶️'];
function cycleMood() {
  const moods = (view && view.moods) || MOODS; // 表情白名单以服务端下发为准（前后端一致 N6）
  const cur = view.my.mood;
  if (!cur) return act('mood', { mood: moods[0] });
  const i = moods.indexOf(cur);
  if (i < 0 || i === moods.length - 1) return act('mood', { mood: null });
  return act('mood', { mood: moods[i + 1] });
}
// 玩家死亡红闪：首次发现死亡时记录结束时间，1.5s 内保留动画类
const prevAlive = {};
const deadFlash = {};

/* ---------------------------- API ---------------------------- */
async function api(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await res.json();
  } catch (e) {
    return { error: '无法连接服务器：请确认已运行 node server.js，并通过 http://localhost:3000 访问' };
  }
}
async function act(action, data) {
  const r = await api('api/action', { room: roomId, me, action, data: data || {}, chatSince: lastChatTs() });
  if (r.error) { toast(r.error); return null; }
  if (r.left) { clearSession(); location.reload(); return null; }
  applyView(r.view);
  resetPollTimer();
  render();
  return view;
}
async function chatSend(ch, text) {
  const r = await api('api/chat', { room: roomId, me, data: { ch, text }, chatSince: lastChatTs() });
  if (r.error) { toast(r.error); return; }
  applyView(r.view);
  resetPollTimer();
  render();
}
async function doAdvance() {
  const r = await api('api/advance', { room: roomId, me, chatSince: lastChatTs() });
  if (r.error) { toast(r.error); return; }
  applyView(r.view);
  resetPollTimer();
  render();
}
/* 客户端最后一条消息的 ts：作为聊天增量传输的锚点（0=需要全量） */
function lastChatTs() {
  return view && view.chat && view.chat.length ? view.chat[view.chat.length - 1].ts : 0;
}
/* 应用服务器视图：忽略慢轮询返回的旧版本，防止覆盖刚提交的新状态 */
function applyView(v) {
  if (!v || v.error) return;
  if (view && v.v < view.v) return;
  // 聊天增量合并：服务端只发 since 之后的新消息，本地拼接；全量（首载/重连）时直接替换
  // 防重：在途轮询/发送可能携带重叠增量（同一 since），按消息 id 去重，避免同一条消息被拼接多次
  if (v.chatFull !== true && view && Array.isArray(v.chat) && view.chat && view.chat.length) {
    const have = new Set(view.chat.map(m => m.id));
    const fresh = v.chat.filter(m => !have.has(m.id));
    if (fresh.length) {
      v.chat = view.chat.concat(fresh);
      if (v.chat.length > 500) v.chat.splice(0, v.chat.length - 500);
    } else {
      v.chat = view.chat;
    }
  }
  view = v;
}
/* 重置轮询计时器（API 提交成功后调用，避免紧邻的旧请求干扰） */
function resetPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollMs = 0; // 强制按当前阶段重新计算间隔
  ensurePollTimer();
}
/* 自适应轮询间隔：需要我操作时快（700ms），否则慢（1600ms），大幅降低隧道带宽占用 */
function currentPollMs() {
  if (!view) return 800;
  return needsFastPoll() ? 700 : 1600;
}
function ensurePollTimer() {
  const want = currentPollMs();
  if (pollTimer && pollMs === want) return;
  pollMs = want;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, want);
}
/* 判断当前是否轮到我操作（决定轮询快慢） */
function needsFastPoll() {
  const v = view; if (!v) return true;
  if (!v.my.alive) return false; // 已出局：慢速轮询即可
  switch (v.phase) {
    case 'lobby': case 'reveal': return true;
    case 'night': {
      if (!v.night) return true;
      if (v.night.step === 'hunter') return !!(v.night.hunter && v.night.hunter.shooter === v.my.id);
      return (v.night.actors || []).some(a => a.id === v.my.id);
    }
    case 'sheriff_campaign': return !(v.campaign && v.campaign.myDecided);
    case 'sheriff_vote': return !(v.sheriffVote && v.sheriffVote.myVoted);
    case 'morning': case 'discuss': case 'pk_speech': return v.my.isHost;
    case 'lastword': return !!((v.lastword && v.lastword.entitled || []).some(e => e.id === v.my.id && !e.posted));
    case 'handover': return !!(v.handover && v.handover.from === v.my.id);
    case 'vote': case 'pk_vote': return !(v.vote && v.vote.myVoted);
    case 'hunter_shot': return !!(v.hunterShot && v.hunterShot.shooter === v.my.id);
    case 'ended': return !!v.canRematch;
    default: return true;
  }
}
async function poll() {
  if (!roomId || !me) return;
  if (pollBusy) return; // 上一轮轮询尚未返回：跳过本次（避免慢网络下请求堆积、增量重叠）
  pollBusy = true;
  try {
    const ver = view ? view.v : -1;
    const res = await fetch(`api/state?room=${encodeURIComponent(roomId)}&me=${encodeURIComponent(me)}&v=${ver}&since=${lastChatTs()}`);
    const j = await res.json();
    if (j.error) {
      if (j.error === 'room-not-found') { toast('房间已解散'); clearSession(); setTimeout(() => location.reload(), 1200); return; }
      if (j.error === 'player-not-found') { clearSession(); setTimeout(() => location.reload(), 800); return; }
      return;
    }
    if (j.changed === false) { ensurePollTimer(); return; } // 版本未变化：无需重绘，直接等下一轮
    const prevPhase = view && view.phase;
    const prevStep = view && view.nightStep;
    const isNew = !view || j.v > view.v;
    applyView(j);
    if (isNew && prevPhase !== undefined && (prevPhase !== view.phase || prevStep !== view.nightStep)) {
      onStateChange(prevPhase, view.phase);
    }
    render();
    ensurePollTimer();
  } catch (e) { ensurePollTimer(); /* 网络抖动忽略 */ }
  finally { pollBusy = false; }
}

/* ---------------------------- 状态变化提示 ---------------------------- */
/* 夜晚/天亮过渡遮罩（#overlay-night） */
let overlayTimer = null;
function showOverlay(title, sub, card, deaths, emoji) {
  const ov = $('overlay-night');
  if (!ov) return;
  ov.querySelector('.on-title').innerHTML = title;
  ov.querySelector('.on-sub').textContent = sub;
  const cardEl = ov.querySelector('.on-card');
  const dd = $('on-deaths');
  if (dd) dd.innerHTML = deaths ? `<div class="od-item">${deaths}</div>` : '';
  const oe = $('on-card-emoji');
  if (oe) oe.textContent = emoji || '';
  if (card) { cardEl.classList.remove('hidden'); $('on-card-title').textContent = card; }
  else cardEl.classList.add('hidden');
  ov.classList.remove('hidden');
  clearTimeout(overlayTimer);
}
function hideOverlay() {
  clearTimeout(overlayTimer);
  const ov = $('overlay-night');
  if (ov) ov.classList.add('hidden');
}
function onStateChange(prev, next) {
  if (!prev || prev === next) return;
  const n = PHASE_TEXT[next] || next;
  if (next === 'night') {
    toast('🌙 天黑请闭眼');
    // 仅存活玩家展示“第 N 夜”遮罩（已出局玩家不阻塞观战）；6 秒防呆自动关闭，也可点“开始行动”提前关闭
    if (view && view.my.alive) {
      showOverlay(`🌙 第 ${view.nightNum || 1} 夜`, '天黑请闭眼，请等待各位行动…', `你是：${view.my.role || '？'}`, null, ROLE_EMOJI_TEXT[view.my.role] || '🎭');
      overlayTimer = setTimeout(hideOverlay, 6000);
    }
  } else if (next === 'morning') {
    toast('🌅 天亮了');
    // 天亮遮罩带死亡摘要（31）
    const deathsHtml = (view.morningDeaths || []).map(d => `${ROLE_EMOJI_TEXT[d.role] || ''} ${escapeHtml(d.name)}：${DEATH_TEXT[d.deadBy] || d.deadBy}`).join('<br>');
    showOverlay('☀️ 天亮了', deathsHtml ? '请查看昨晚结果' : '昨夜平安无事', null, deathsHtml || '🌙 昨夜平安无事', '☀️');
    overlayTimer = setTimeout(hideOverlay, 2500);
  } else if (next === 'ended') toast('🏁 游戏结束');
  else toast(n);
}

/* ---------------------------- 渲染主入口 ---------------------------- */
let editingSnapshot = null;
/* 渲染前快照正在编辑的输入框（遗言框/聊天框等），渲染后恢复内容与光标，避免重绘打断输入 */
function snapshotEditing() {
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
    editingSnapshot = { id: el.id, value: el.value, start: el.selectionStart, end: el.selectionEnd };
  } else editingSnapshot = null;
}
function restoreEditing() {
  const s = editingSnapshot;
  editingSnapshot = null;
  if (!s || !s.id) return;
  const el = document.getElementById(s.id);
  if (!el) return; // 阶段已切换，该输入框已不存在
  try {
    if (el.value !== s.value) el.value = s.value;
    el.focus();
    if (el.setSelectionRange) el.setSelectionRange(s.start, s.end);
  } catch (e) { /* ignore */ }
}
function render() {
  if (!view) return;
  snapshotEditing();
  // 顶栏【强制继续】仅房主在非大厅/非结束阶段可见
  const forceBtn = $('btn-force');
  if (forceBtn) forceBtn.classList.toggle('hidden', !(view.my && view.my.isHost && view.phase !== 'lobby' && view.phase !== 'ended'));
  // 顶栏【强制继续】智能点亮：存在未操作者才脉冲（7）
  if (forceBtn && !forceBtn.classList.contains('hidden')) {
    const act = shouldForceContinue();
    forceBtn.classList.toggle('force-ready', act);
    forceBtn.classList.toggle('force-idle', !act);
  }
  // 阶段面包屑（5）
  renderBreadcrumb();
  // 玩家进出提示（45）
  diffPlayers();
  // 阶段或夜晚子步骤变化时，清空上次面板的草稿选择（防止残留目标误填充下一步骤）
  const phaseKey = view.phase + (view.nightStep ? ':' + view.nightStep : '') + (view.reveal ? ':' + view.reveal.stage : '');
  if (phaseKey !== lastPhaseKey) {
    // kill/charm 初始值必须用 undefined：doWolfConfirm 以 `!== undefined` 判断是否携带，null 会被误判成“已选择空刀/不魅惑”
    draft = { target: null, target2: null, thiefIdx: undefined, kill: undefined, charm: undefined };
    lastPhaseKey = phaseKey;
  }
  // 顶栏
  $('room-code').textContent = view.roomId;
  $('phase-text').textContent = PHASE_TEXT[view.phase] || view.phase;
  $('day-text').textContent = view.phase === 'night' ? `第 ${view.nightNum} 夜` : (view.dayNum ? `第 ${view.dayNum} 天` : '');
  const chip = $('my-role-chip');
  if (view.my.role) {
    chip.textContent = `${ROLE_EMOJI_TEXT[view.my.role] || ''} ${view.my.role}${view.my.camp ? ' · ' + view.my.camp : ''}${view.my.alive ? '' : '（已出局）'}`;
    chip.style.display = '';
    chip.style.cursor = 'pointer';
    chip.title = '点击查看技能详情';
  } else chip.style.display = 'none';
  renderPlayers();
  renderInfo();
  renderPanel();
  renderChat();
  applyTheme(); // 昼夜主题：夜晚全局压暗变冷，白天回暖
  restoreEditing();
}
/* 昼夜主题切换（ToS/狼人杀APP经典氛围）：仅切换 CSS 变量，重绘安全 */
function applyTheme() {
  const body = document.body;
  if (!view) { body.classList.remove('theme-night', 'theme-day'); return; }
  const night = view.phase === 'night';
  const day = ['morning', 'lastword', 'handover', 'sheriff_campaign', 'sheriff_vote', 'discuss', 'vote', 'pk_speech', 'pk_vote', 'hunter_shot'].includes(view.phase);
  body.classList.toggle('theme-night', night);
  body.classList.toggle('theme-day', day);
}

/* ---------------------------- 玩家列表 ---------------------------- */
function renderPlayers() {
  const alive = view.players.filter(p => p.alive).sort((a, b) => a.seat - b.seat);
  const dead = view.players.filter(p => !p.alive).sort((a, b) => a.seat - b.seat);
  // 新死亡 → 红闪 + 播报（46）
  for (const p of dead) {
    if (prevAlive[p.id] === true && !deadFlash[p.id]) {
      deadFlash[p.id] = Date.now() + 1500;
      toast(`💀 ${p.name}：${DEATH_TEXT[p.deadBy] || p.deadBy}`, 'err');
    }
    prevAlive[p.id] = false;
  }
  for (const p of alive) prevAlive[p.id] = true;
  const card = p => {
    const flashCls = !p.alive && deadFlash[p.id] > Date.now() ? ' death-flash' : '';
    const name = escapeHtml(p.name) + (p.isBot ? ' <span class="badge bot-badge" title="人机">🤖</span>' : '') + (p.isMe ? ' <span class="badge">我</span>' : '') + (p.sheriff ? ' <span class="sheriff-mark" title="警长">👮</span>' : '') + (p.isMe && view.myLover ? ' <span class="p-badge" title="情侣">💞</span>' : '');
    const moodHtml = p.isMe
      ? `<button class="mood-btn ${p.mood ? 'has' : ''}" onclick="cycleMood()" title="心情表情，点击切换">${p.mood || '🎭'}</button>`
      : (p.mood ? `<span class="mood-tag">${escapeHtml(p.mood)}</span>` : '');
    const role = p.role ? `<div class="prole ${ROLE_CAMP_TEXT[p.role] || ''}">${ROLE_EMOJI_TEXT[p.role] || ''} ${escapeHtml(p.role)}</div>` : '';
    const deadTxt = p.alive ? '' : `<div class="pdead">💀 ${DEATH_TEXT[p.deadBy] || p.deadBy}${p.deadNote ? '（' + escapeHtml(p.deadNote) + '）' : ''}</div>`;
    return `<div class="player ${p.isMe ? 'me' : ''} ${p.alive ? '' : 'dead'}${flashCls} ${draft.target === p.id || draft.target2 === p.id ? 'selected' : ''}" data-id="${p.id}">
      <div class="phead"><div class="avatar ${p.alive ? '' : 'dead'}">${avatarOf(p)}</div>
      <div class="pmeta"><div class="pname">${name}${moodHtml}<span class="pseat">#${p.seat}</span></div>${role}${deadTxt}</div></div>
    </div>`;
  };
  // 座位排序 + 墓地分区（3 轻量版）
  $('players').innerHTML = alive.map(card).join('') +
    (dead.length ? `<div class="dead-title">☠️ 已出局（${dead.length}）</div>` + dead.map(card).join('') : '');
}

/* ---------------------------- 信息区（公告/计票） ---------------------------- */
function renderInfo() {
  const info = $('info');
  let html = '';
  // 情侣信息（被指认的瞬间醒来彼此确认身份，之后随时可见）
  if (view.myLover) {
    html += `<div class="info-box" style="border-color:var(--third)">💞 你的情侣：<b>${escapeHtml(view.myLover.name)}</b>（身份：${escapeHtml(view.myLover.role)}）${view.myLover.cupidName ? '　指认者：' + escapeHtml(view.myLover.cupidName) : ''}</div>`;
  }
  // 预言家查验记录（任何阶段可见）
  if (view.seerHistory && view.seerHistory.length) {
    html += `<div class="info-box" style="border-color:var(--good)">🔮 查验记录：` +
      view.seerHistory.map(h => `第${h.night}夜 ${escapeHtml(h.name)}：${h.result === 'wolf' ? '<span style="color:var(--wolf)">🐺狼人</span>' : '<span style="color:var(--good)">😇好人</span>'}`).join('　') +
      `</div>`;
  }
  // 夜间 / 白天死亡公告
  const deaths = (view.morningDeaths && view.morningDeaths.length) ? view.morningDeaths
    : (view.dayDeaths && view.dayDeaths.length ? view.dayDeaths : []);
  if (view.phase === 'morning' && view.morningDeaths) {
    if (view.morningDeaths.length === 0) html += `<div class="safe-night">☀️ 昨夜平安无事</div>`;
    else html += deathListHtml(view.morningDeaths, '昨夜死亡');
  }
  if (view.phase !== 'morning' && deaths && deaths.length) {
    html += deathListHtml(deaths, '本日死亡');
  }
  // 投票结果
  if (view.lastVoteResult && (view.lastVoteResult.result || view.lastVoteResult.kind)) {
    const lv = view.lastVoteResult;
    const kind = lv.kind === 'sheriff' ? '警长竞选结果' : lv.kind === 'pk' ? 'PK 投票结果' : '放逐投票结果';
    const resTxt = lv.result === 'exile' ? `⚖️ ${escapeHtml(nameOf(lv.exiled))} 被放逐` : lv.result === 'elected' ? `👮 ${escapeHtml(nameOf(lv.exiled))} 当选警长` : lv.result === 'tie' ? '⚖️ 平票' : '⚖️ 无人出局';
    let totals = '';
    if (lv.totals) {
      totals = Object.entries(lv.totals).map(([id, n]) => `<div class="vt-line ${lv.exiled === id ? 'win' : ''}"><span>${escapeHtml(nameOf(id))}</span><span>${fmtVote(n)}</span></div>`).join('');
      totals = `<div class="vote-total">${totals}</div>`;
    }
    html += `<div class="panel-title">${kind}</div><div>${resTxt}</div>${totals}`;
  }
  if (html) { info.innerHTML = html; info.classList.add('show'); }
  else info.classList.remove('show');
}
function deathListHtml(list, title) {
  return `<div class="panel-title">💀 ${title}</div><div class="death-list">` + list.map(d =>
    `<div class="death-item"><div class="di-emoji">${ROLE_EMOJI_TEXT[d.role] || '💀'}</div><div class="di-name">${escapeHtml(d.name)}</div><div class="di-role">${ROLE_EMOJI_TEXT[d.role] || ''} ${escapeHtml(d.role || '?')}</div><div class="di-cause">${DEATH_TEXT[d.deadBy] || d.deadBy}${d.deadNote ? '（' + escapeHtml(d.deadNote) + '）' : ''}</div></div>`
  ).join('') + `</div>`;
}
function fmtVote(n) { return n + ' 票'; }
function nameOf(id) { const p = view.players.find(x => x.id === id); return p ? p.name : '?'; }

/* ---------------------------- 主面板 ---------------------------- */
function renderPanel() {
  const panel = $('panel');
  panel.classList.remove('night-panel');
  // 轮到我行动 → 面板呼吸光圈（“睁眼”高亮）
  panel.classList.toggle('my-turn', view.phase !== 'lobby' && view.phase !== 'reveal' && view.phase !== 'ended' && needsFastPoll());
  let html;
  switch (view.phase) {
    case 'lobby': html = renderLobby(); break;
    case 'reveal': html = renderReveal(); break;
    case 'night': html = renderNight(); panel.classList.add('night-panel'); break;
    case 'morning': html = renderMorning(); break;
    case 'lastword': html = renderLastword(); break;
    case 'handover': html = renderHandover(); break;
    case 'sheriff_campaign': html = renderCampaign(); break;
    case 'sheriff_vote': html = renderSheriffVote(); break;
    case 'discuss': html = renderDiscuss(); break;
    case 'vote': html = renderVote(); break;
    case 'pk_speech': html = renderPkSpeech(); break;
    case 'pk_vote': html = renderVote(true); break;
    case 'hunter_shot': html = renderHunterShot(); break;
    case 'ended': html = renderEnded(); break;
    default: html = '';
  }
  // 重绘守卫：内容未变化时不替换 DOM——避免轮询高频重绘把“正在进行的点击”吞掉（偶现按钮点不动）
  if (panel.innerHTML !== html) panel.innerHTML = html;
}

/* ---------------- 大厅 ---------------- */
function renderLobby() {
  const isHost = view.my.isHost;
  let html = `<div class="panel-title">🏠 房间 ${view.roomId} <span class="badge">${view.players.length}/${view.playerCap} 人</span></div>`;
  html += `<div class="panel-desc">把房间号发给朋友，人满后由房主开局。</div>`;
  if (isHost) {
    html += `<div class="set-group"><div class="sg-title">人数（<span id="cap-title-num">${view.playerCap}</span> 人，4~18）</div>
      <input id="cap-slider" type="range" min="${Math.max(4, view.players.length)}" max="18" value="${view.playerCap}" oninput="onCapInput(this.value)" onchange="onCapChange(this.value)">
      <div class="tip-text" id="cap-tip">当前 ${view.playerCap} 人</div></div>`;
    html += `<div class="set-group"><div class="sg-title">职业配置（总数须等于人数）</div>` + roleCountsHtml() + `<div class="total-hint" id="count-hint"></div></div>`;
    html += `<div class="set-group"><div class="sg-title">规则</div>
      <div class="radio-row">
        <label><input type="checkbox" ${view.settings.sheriff ? 'checked' : ''} onchange="onSetting('sheriff', this.checked)"> 👮 警长选举（可关闭）</label>
        <label><input type="radio" name="winmode" value="edge" ${view.settings.winMode === 'edge' ? 'checked' : ''} onchange="onWinMode('edge')"> 屠边</label>
        <label><input type="radio" name="winmode" value="city" ${view.settings.winMode === 'city' ? 'checked' : ''} onchange="onWinMode('city')"> 屠城</label>
      </div>
      <div class="radio-row" style="margin-top:6px">
        <label><input type="radio" name="tie" value="pk" ${view.settings.tieRule === 'pk' ? 'checked' : ''} onchange="onTieRule('pk')"> 平票PK</label>
        <label><input type="radio" name="tie" value="none" ${view.settings.tieRule === 'none' ? 'checked' : ''} onchange="onTieRule('none')"> 平票无人出局</label>
      </div>
      <div class="radio-row" style="margin-top:6px">
        <label><input type="checkbox" ${view.settings.thief ? 'checked' : ''} onchange="onThief(this.checked)"> 🃏 盗贼玩法（身份牌总数须比人数多 1）</label>
      </div>
      <div class="tip-text">开启后：随机一名玩家为盗贼，从两张身份牌中择一（有狼必选狼），另一张作废。</div></div>`;
    html += `<div class="set-group"><div class="sg-title">🤖 人机调试</div>
      <div class="radio-row">
        <label><input type="radio" name="botmode" value="auto" ${view.settings.botMode !== 'passive' ? 'checked' : ''} onchange="onSetting('botMode','auto')">简单AI（会投票）</label>
        <label><input type="radio" name="botmode" value="passive" ${view.settings.botMode === 'passive' ? 'checked' : ''} onchange="onSetting('botMode','passive')">挂机（弃票）</label>
      </div>
      <div class="btn-row">
        <button onclick="act('add_bot',{})">＋ 添加人机</button>
        <button onclick="act('remove_bot',{})">－ 移除最后一个人机</button>
      </div>
      <div class="tip-text">人机自动执行本职业行动（夜晚决策/白天投票），用于缺人陪练与调试；添加后请同步调整人数上限，也可用「踢出」移除任意人机。</div></div>`;
    const ready = view.players.length === view.playerCap;
    html += `<div class="btn-row"><button class="primary" id="btn-start" onpointerdown="act('start')" ${ready ? '' : 'disabled'}>开始游戏</button></div>`;
    if (!ready) html += `<div class="tip-text">还需 ${view.playerCap - view.players.length} 人加入</div>`;
  } else {
    html += `<div class="waiting">等待房主配置并开始游戏…</div>`;
  }
  html += `<div class="set-group"><div class="sg-title">玩家列表（${view.players.length} 人）</div>` +
    view.players.map(p =>
      `<div class="count-row"><div class="cr-name">${escapeHtml(p.name)}${p.isBot ? ' <span class="badge bot-badge">🤖人机</span>' : ''}${p.id === view.host ? ' <span class="badge">房主</span>' : ''}</div>` +
      (isHost && p.id !== view.my.id ? `<div class="cr-ctrl"><button class="danger mini" onclick="kick('${p.id}')">踢出</button></div>` : '') + `</div>`
    ).join('') + `</div>`;
  return html;
}
function roleCountsHtml() {
  const c = view.roleCounts;
  // 盗贼不再作为身份卡配置，改为房主开关“盗贼玩法”
  const order = ['wolf', 'villager', 'seer', 'witch', 'hunter', 'guard', 'dreamer', 'wolfBeauty', 'cupid'];
  return order.map(k => {
    const n = c[k] || 0;
    if (k === 'wolf' || k === 'villager') {
      return `<div class="count-row"><div class="cr-name ${ROLE_CAMP[k] || ''}">${ROLE_NAMES[k]}</div>
        <div class="cr-ctrl"><button onclick="countChange('${k}',-1)">−</button><span id="c-${k}">${n}</span><button onclick="countChange('${k}',1)">+</button></div></div>`;
    }
    return `<div class="count-row"><div class="cr-name ${ROLE_CAMP[k] || ''}">${ROLE_NAMES[k]}</div>
      <div class="cr-ctrl"><button onclick="countChange('${k}',${n === 1 ? -1 : 1})">${n === 1 ? '移除' : '添加'}</button></div></div>`;
  }).join('');
}

/* ---------------- 身份展示 ---------------- */
function renderReveal() {
  const rv = view.reveal || {};
  let html = `<div class="panel-title">🃏 身份展示</div>`;
  // 房主选择期望职业（或随机分配）
  if (rv.canPick) {
    html += `<div class="panel-desc">由你决定本局职业（可选一种身份牌，或随机分配；之后随机指定盗贼——若开启）。</div>`;
    html += `<div class="role-cards">` + (rv.available || []).map((r, i) =>
      `<div class="role-card ${ROLE_CAMP[r.key] || ''}" style="animation-delay:${i * 60}ms" onclick="hostPick('${r.key}')"><div class="rc-emoji">${ROLE_EMOJI[r.key] || ''}</div><div class="rc-name">${r.name}</div><div class="rc-desc">${escapeHtml(r.desc)}</div></div>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button onclick="hostPick('random')">🎲 随机分配</button></div>`;
  } else if (rv.isThief && rv.thiefCards) {
    // 盗贼选牌（注意：非房主拿到的 stage 为 null，不能作为判断依据；isThief/thiefCards 已由服务端判定）
    html += `<div class="panel-desc">🃏 你是<b>盗贼</b>！从以下两张身份牌中选择一张作为你的身份（若有狼人牌则必须选狼人），另一张作废：</div>`;
    html += `<div class="role-cards">` + (rv.thiefCards || []).map((r, i) =>
      `<div class="role-card ${ROLE_CAMP[r.key] || ''} ${draft.thiefIdx === i ? 'chosen' : ''}" style="animation-delay:${i * 80}ms" onclick="draft.thiefIdx = ${i}; render()"><div class="rc-emoji">${ROLE_EMOJI[r.key] || ''}</div><div class="rc-name">${r.name}</div><div class="rc-desc">${escapeHtml(r.desc)}</div></div>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button class="primary" onpointerdown="doThiefPick()" ${draft.thiefIdx === undefined ? 'disabled' : ''}>确认选择</button></div>`;
  } else if (rv.thiefPicking) {
    html += `<div class="waiting">🃏 盗贼正在窃走......（30 秒内自动选择）</div>`;
  } else if (!rv.dealt) {
    html += `<div class="waiting">正在准备身份牌，请稍候…</div>`;
  } else if (rv.myRole) {
    if (rv.thiefTook) {
      const item = THIEF_ITEM[rv.thiefTook] || '身份';
      html += `<div class="tip-text" style="margin-bottom:8px">🃏 盗贼窃走了「${ROLE_NAMES[rv.thiefTook] || '神秘身份'}的${item}」</div>`;
    }
    html += `<div class="identity-reveal"><span class="ir-emoji">${ROLE_EMOJI_TEXT[rv.myRole] || '🎭'}</span><div class="ir-name">${escapeHtml(rv.myRole)}</div></div>`;
    html += `<div class="panel-desc" style="margin-top:10px">${escapeHtml(rv.myDesc || '')}</div>`;
    const meP = view.players.find(p => p.isMe);
    html += meP && meP.confirmed
      ? `<div class="tip-text">✅ 已确认，等待其他人…</div>`
      : `<div class="btn-row"><button class="primary" onpointerdown="act('confirm')">确认身份</button></div>`;
    html += `<div class="tip-text">${rv.thiefTook ? '⏳ 盗贼结果展示中，5 秒后自动进入夜晚…' : '⏳ 全员确认或等待 5 秒后自动进入夜晚'}</div>`;
  }
  const done = (rv.confirmed || []).filter(c => c.ok).length;
  const need = (rv.confirmed || []).length;
  html += `<div class="tip-text" style="margin-top:12px">已确认 ${done}/${need}${view.my.isHost ? '　房主可点击右上角【强制继续】跳过等待' : ''}</div>`;
  return html;
}

/* ---------------- 夜晚 ---------------- */
function renderNight() {
  const n = view.night || {};
  const step = n.step;
  const stepText = {
    thief: '盗贼请睁眼', cupid: '丘比特请睁眼', lovers: '情侣请睁眼确认彼此',
    guard: '守卫请睁眼', dreamer: '摄梦人请睁眼', wolf: '狼人请睁眼', seer: '预言家请睁眼',
    witch: '女巫请睁眼', hunter: '猎人请睁眼',
  };
  let html = `<div class="panel-title night-title">🌙 第 ${view.nightNum} 夜 · ${stepText[step] || '夜晚'}</div>`;
  if (step !== 'hunter') {
    const actors = n.actors || [];
    const doneCount = actors.filter(a => a.acted).length;
    html += `<div class="tip-text">${actors.length ? `等待操作：${doneCount}/${actors.length}` : ''}</div>`;
  }
  switch (step) {
    case 'hunter': html += hunterShotHtml(view.night.hunter); break;
    case 'cupid': {
      if (view.my.roleKey === 'cupid') {
        const picked = [draft.target, draft.target2].filter(Boolean).map(nameOf).join(' 和 ');
        const pickTip = `<div class="tip-text">已选：${picked || '—'}　（点已选玩家可取消，点第三人可替换）</div>`;
        if (view.nightNum === 1) {
          html += `<div class="panel-desc">选择两名玩家成为情侣（可包含自己），点选两名玩家后确认：</div>`;
          html += pickTip;
          html += `<div class="btn-row"><button class="primary" onpointerdown="doCupidPick()" ${draft.target && draft.target2 ? '' : 'disabled'}>确定情侣</button></div>`;
          if (!draft.target || !draft.target2) html += `<div class="tip-text">在左侧玩家列表中点选两名玩家</div>`;
        } else {
          html += `<div class="panel-desc">上一对情侣已殉情，你可以重新指定两名玩家为情侣（阵营将随新情侣变化），也可以选择不再指定：</div>`;
          html += pickTip;
          html += `<div class="btn-row"><button class="primary" onpointerdown="doCupidPick()" ${draft.target && draft.target2 ? '' : 'disabled'}>重新指定情侣</button></div>`;
          html += `<div class="btn-row"><button onpointerdown="act('cupid_pick',{ids:null})">本轮不指定（放弃重选）</button></div>`;
          if (!draft.target || !draft.target2) html += `<div class="tip-text">在左侧玩家列表中点选两名玩家</div>`;
        }
      } else html += `<div class="waiting">等待丘比特处理情侣…</div>`;
      break;
    }
    case 'lovers': {
      if (n.lovers) {
        html += `<div class="panel-title night-title" style="color:var(--third)">💞 你的情侣是：${escapeHtml(n.lovers.partnerName)}</div>`;
        html += `<div class="panel-desc">被丘比特指认的瞬间你们醒来，<b>彼此确认了对方的身份</b>：</div>`;
        html += `<div class="role-card" style="max-width:340px;margin:8px auto"><div class="rc-name">${escapeHtml(n.lovers.partnerName)} 的身份：${escapeHtml(n.lovers.partnerRole)}</div></div>`;
        html += `<div class="panel-desc">💘 指认你们的丘比特是：<b>${escapeHtml(n.lovers.cupidName)}</b>（对方不知道你的身份，丘比特也不知道你们各自的真实阵营）</div>`;
        html += `<div class="btn-row"><button class="primary" onpointerdown="act('lovers_ok')">知道了</button></div>`;
      } else html += `<div class="waiting">等待情侣确认…</div>`;
      break;
    }
    case 'guard': {
      if (view.my.roleKey === 'guard') {
        const last = n.guard && n.guard.last;
        html += `<div class="panel-desc">守护一名玩家（可守自己，不能连续两晚守同一人）。上一晚守护：${last ? escapeHtml(nameOf(last)) : '无'}</div>`;
        html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
        html += `<div class="btn-row"><button class="primary" onpointerdown="doPick('guard_pick', 'guard')" ${draft.target ? '' : 'disabled'}>确认守护</button></div>`;
        if (!draft.target) html += `<div class="tip-text">在左侧玩家列表中点选目标</div>`;
      } else html += `<div class="waiting">等待守卫行动…</div>`;
      break;
    }
    case 'dreamer': {
      if (view.my.roleKey === 'dreamer') {
        html += `<div class="panel-desc">选择一名玩家成为梦游者（不能梦自己；梦游者免疫夜间伤害）。</div>`;
        html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
        html += `<div class="btn-row"><button class="primary" onpointerdown="doPick('dreamer_pick', 'dreamer')" ${draft.target ? '' : 'disabled'}>确认</button></div>`;
        if (!draft.target) html += `<div class="tip-text">在左侧玩家列表中点选目标</div>`;
      } else html += `<div class="waiting">等待摄梦人行动…</div>`;
      break;
    }
    case 'wolf': {
      if (n.wolf) {
        const hasWolfBeauty = n.wolf.teammates.some(t => t.role === '狼美人');
        html += `<div class="panel-desc">狼队共商：选择今晚刀人目标（可自刀 / 空刀）${hasWolfBeauty ? '；并选择魅惑目标（狼美人的能力）' : ''}。</div>`;
        html += `<div class="wolf-team">${n.wolf.teammates.map(t => `<span class="member">🐺 ${escapeHtml(t.name)}（${t.role}）</span>`).join('')}</div>`;
        // 各狼选定的刀人对象
        if (n.wolf.selections && n.wolf.selections.length) {
          html += `<div class="set-group"><div class="sg-title">各狼选定的刀人对象</div>` +
            n.wolf.selections.map(s => {
              const txt = s.kill === undefined ? '未选择' : s.kill === null ? '空刀' : escapeHtml(nameOf(s.kill));
              return `<div class="count-row"><div class="cr-name">${escapeHtml(s.name)}${s.id === view.my.id ? '（我）' : ''}</div><div class="cr-ctrl">🔪 ${txt}</div></div>`;
            }).join('') + `</div>`;
        }
        const killed = draft.kill === 'none' ? '空刀' : draft.kill ? nameOf(draft.kill) : (n.wolf.kill ? nameOf(n.wolf.kill) : '未选择');
        const charmed = draft.charm === 'none' ? '不魅惑' : draft.charm ? nameOf(draft.charm) : (n.wolf.charm ? nameOf(n.wolf.charm) : '未选择');
        html += `<div class="set-group"><div class="sg-title">🔪 刀人目标：${escapeHtml(killed)}</div>
          <div class="btn-row">${alivePlayers().map(p => `<button class="mini" onpointerdown="setWolfKill('${p.id}')">${escapeHtml(p.name)}</button>`).join('')}
          <button class="mini" onpointerdown="setWolfKill('none')">空刀</button></div></div>`;
        if (hasWolfBeauty) {
          html += `<div class="set-group"><div class="sg-title">💘 魅惑目标：${escapeHtml(charmed)}</div>
            <div class="btn-row">${alivePlayers().filter(p => p.id !== view.my.id).map(p => `<button class="mini" onpointerdown="setWolfCharm('${p.id}')">${escapeHtml(p.name)}</button>`).join('')}
            <button class="mini" onpointerdown="setWolfCharm('none')">不魅惑</button></div></div>`;
        }
        const meActed = n.actors.find(a => a.id === view.my.id);
        html += `<div class="btn-row"><button class="primary" onpointerdown="doWolfConfirm()" ${meActed && meActed.acted ? 'disabled' : ''}>确认行动</button></div>`;
        if (meActed && meActed.acted) html += `<div class="tip-text">✅ 你已确认，等待其他狼人…</div>`;
      } else html += `<div class="waiting">等待狼人行动…</div>`;
      break;
    }
    case 'seer': {
      if (view.my.roleKey === 'seer') {
        html += `<div class="panel-desc">查验一名玩家是好人还是狼人。</div>`;
        html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
        html += `<div class="btn-row"><button class="primary" onpointerdown="doPick('seer_pick', 'seer')" ${draft.target ? '' : 'disabled'}>查验</button></div>`;
        if (n.seer && n.seer.history && n.seer.history.length) {
          html += `<div class="set-group"><div class="sg-title">历史查验</div>` +
            n.seer.history.map(h => `<div class="count-row"><div class="cr-name">第${h.night}夜 · ${escapeHtml(h.name)}</div><div class="cr-ctrl">${h.result === 'wolf' ? '<span style="color:var(--wolf)">🐺 狼人</span>' : '<span style="color:var(--good)">✅ 好人</span>'}</div></div>`).join('') + `</div>`;
        }
      } else html += `<div class="waiting">等待预言家查验…</div>`;
      break;
    }
    case 'witch': {
      if (view.my.roleKey === 'witch' && n.witch) {
        const w = n.witch;
        const victim = w.victim ? nameOf(w.victim) : '无人被袭击';
        html += `<div class="panel-desc">今晚被狼人袭击的是：<b>${escapeHtml(victim)}</b>（解药可救；每晚最多用一瓶药，可自救）。</div>`;
        html += `<div class="set-group"><div class="sg-title">解药 ${w.saveUsed ? '（已使用）' : '（未使用）'}</div>
          <div class="btn-row"><button class="primary" onpointerdown="witchSave()" ${!w.saveUsed && w.victim ? '' : 'disabled'}>使用解药救他</button></div></div>`;
        html += `<div class="set-group"><div class="sg-title">毒药 ${w.poisonUsed ? '（已使用）' : '（未使用）'}</div>
          <div class="tip-text">已选：${draft.poison ? escapeHtml(nameOf(draft.poison)) : '—'}</div>
          <div class="btn-row">${alivePlayers().filter(p => p.id !== view.my.id).map(p => `<button class="mini" onpointerdown="draft.poison='${p.id}'; renderPanel()">${escapeHtml(p.name)}</button>`).join('')}</div></div>`;
        html += `<div class="btn-row"><button class="primary" onpointerdown="witchPoison()" ${draft.poison && !w.poisonUsed ? '' : 'disabled'}>毒杀他</button><button onpointerdown="act('witch_act',{save:false})">跳过（本晚不用药）</button></div>`;
      } else html += `<div class="waiting">等待女巫行动…</div>`;
      break;
    }
    default: {
      if (!actors || actors.length === 0) html += `<div class="waiting">等待所有角色行动…</div>`;
      else {
        const waitText = actors.map(a => `${escapeHtml(a.name)}${a.acted ? ' ✅' : '…'}`).join('、');
        html += `<div class="waiting">${escapeHtml(waitText)}</div>`;
      }
    }
  }
  if (view.my.isHost) html += `<div class="tip-text" style="margin-top:12px">房主可【强制继续】跳过等待（未操作者视为弃权/放弃）</div>`;
  return html;
}
function hunterShotHtml(h) {
  if (h && h.shooter === view.my.id) {
    return `<div class="panel-title" style="color:var(--accent)">🔫 你被狼人杀害 / 放逐，可以开枪</div>
      <div class="panel-desc">选择一名玩家枪杀（不能开枪自杀），或选择放弃。</div>
      <div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>
      <div class="btn-row">${alivePlayers().filter(p => p.id !== view.my.id).map(p => `<button class="mini" onpointerdown="draft.target='${p.id}'; renderPanel()">${escapeHtml(p.name)}</button>`).join('')}</div>
      <div class="btn-row"><button class="primary" onpointerdown="hunterShoot()" ${draft.target ? '' : 'disabled'}>开枪</button><button onpointerdown="hunterShoot()" ${draft.target ? 'style="display:none"' : ''}>放弃开枪</button></div>`;
  }
  return `<div class="waiting">等待猎人开枪…</div>`;
}

/* ---------------- 白天各阶段 ---------------- */
function renderMorning() {
  let html = `<div class="panel-title">🌅 天亮了（第 ${view.dayNum} 天）</div>`;
  if (view.morningDeaths && view.morningDeaths.length === 0) html += `<div class="safe-night">昨夜平安无事</div>`;
  else if (view.morningDeaths) html += deathListHtml(view.morningDeaths, '昨夜死亡');
  html += `<div class="tip-text">请阅读公告。${view.morning.canContinue ? '点击继续进入白天流程。' : '等待房主继续…'}</div>`;
  if (view.morning.canContinue) html += `<div class="btn-row"><button class="primary" onpointerdown="doAdvance()">继续</button></div>`;
  return html;
}
function renderLastword() {
  const lw = view.lastword || {};
  let html = `<div class="panel-title">💬 遗言</div>`;
  const myEnt = lw.entitled && lw.entitled.find(e => e.id === view.my.id);
  if (myEnt && !myEnt.posted) {
    html += `<div class="panel-desc">你有一句遗言可以发表（仅一次）：</div>`;
    html += `<textarea id="lw-text" rows="3" placeholder="最后的遗言…" maxlength="200"></textarea>`;
    html += `<div class="btn-row"><button class="primary" onpointerdown="sendLastword()">发表遗言</button><button onpointerdown="act('skip')">放弃遗言</button></div>`;
  } else {
    const wait = (lw.entitled || []).map(e => `${escapeHtml(e.name)}${e.posted ? ' ✅' : '…'}`).join('、');
    html += `<div class="waiting">等待遗言：${escapeHtml(wait)}</div>`;
  }
  if (lw.canAdvance) html += `<div class="btn-row"><button onpointerdown="doAdvance()">跳过遗言</button></div>`;
  return html;
}
function renderHandover() {
  const h = view.handover || {};
  let html = `<div class="panel-title">👮 警徽移交</div>`;
  if (h.from === view.my.id) {
    html += `<div class="panel-desc">你已出局，可以选择将警徽移交给一名存活玩家，或撕毁警徽。</div>`;
    html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
    // 目标选择按钮（与点玩家卡双保险：任一方式均可选定移交对象）
    html += `<div class="btn-row">` + alivePlayers().filter(p => p.id !== view.my.id).map(p =>
      `<button class="mini ${draft.target === p.id ? 'chosen' : ''}" onpointerdown="draft.target='${p.id}'; renderPanel()">${escapeHtml(p.name)}</button>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button class="primary" onpointerdown="handoverPick()" ${draft.target ? '' : 'disabled'}>移交警徽</button><button onpointerdown="act('handover',{target:null})">撕毁警徽</button></div>`;
  } else {
    html += `<div class="waiting">${escapeHtml(h.fromName || '')} 正在处理警徽…</div>`;
  }
  if (h.canAdvance) html += `<div class="btn-row"><button onpointerdown="doAdvance()">跳过（撕毁）</button></div>`;
  return html;
}
function renderCampaign() {
  const c = view.campaign || {};
  let html = `<div class="panel-title">🗳️ 警长竞选 · 报名</div>`;
  html += `<div class="panel-desc">是否竞选警长？竞选者稍后接受全体投票（警长白天最后发言，投票计 1.5 票）。</div>`;
  if (!c.myDecided) {
    html += `<div class="btn-row"><button class="primary" onpointerdown="act('campaign',{run:true})">我要竞选</button><button onpointerdown="act('campaign',{run:false})">放弃</button></div>`;
  } else {
    html += `<div class="tip-text">✅ 你已做出选择</div>`;
  }
  html += `<div class="tip-text" style="margin-top:8px">报名进度：${c.progress}/${c.need}${c.candidates.length ? '　竞选者：' + c.candidates.map(x => escapeHtml(x.name)).join('、') : ''}</div>`;
  if (c.canAdvance) html += `<div class="btn-row"><button onpointerdown="doAdvance()">跳过报名</button></div>`;
  return html;
}
function renderSheriffVote() {
  const s = view.sheriffVote || {};
  let html = `<div class="panel-title">🗳️ 警长竞选 · 投票</div>`;
  html += `<div class="panel-desc">投给一名竞选者（或弃票）。</div>`;
  html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
  html += `<div class="btn-row">${s.candidates.map(p => `<button class="mini" onpointerdown="draft.target='${p.id}'; renderPanel()">${escapeHtml(p.name)}</button>`).join('')}</div>`;
  html += `<div class="btn-row"><button class="primary" onpointerdown="castVote()" ${draft.target ? '' : 'disabled'}>投票</button><button onpointerdown="castVote(true)">弃票</button></div>`;
  html += `<div class="tip-text">已投 ${s.voted}/${s.need}</div>`;
  return html;
}
function renderDiscuss() {
  let html = `<div class="panel-title">☀️ 白天发言（第 ${view.dayNum} 天）</div>`;
  html += `<div class="panel-desc">自由发言讨论，找出狼人。死后玩家也可发言。</div>`;
  if (view.discuss && view.discuss.canStartVote) {
    html += `<div class="btn-row"><button class="primary" onpointerdown="act('startVote')">进入放逐投票</button></div>`;
  } else {
    html += `<div class="waiting">等待房主宣布进入投票…</div>`;
  }
  if (view.sheriff) {
    const sp = view.players.find(p => p.id === view.sheriff);
    if (sp) html += `<div class="tip-text">👮 警长：${escapeHtml(sp.name)}（最后发言，1.5 票）</div>`;
  }
  return html;
}
function renderVote(isPk) {
  const v = view.vote || {};
  let html = `<div class="panel-title">${isPk ? '🗳️ PK 投票' : '🗳️ 放逐投票'}</div>`;
  if (isPk && v.pkTied) html += `<div class="panel-desc">平票玩家 PK：${v.pkTied.map(p => escapeHtml(p.name)).join('、')}（只能投给 PK 玩家）</div>`;
  else html += `<div class="panel-desc">投给一名玩家（可弃票）。得票最多者被放逐。${view.sheriff ? '警长计 1.5 票。' : ''}</div>`;
  html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
  // PK 投票只列出平票玩家；普通投票列出所有存活玩家
  const candidates = isPk && v.pkTied && v.pkTied.length ? v.pkTied : alivePlayers();
  html += `<div class="btn-row">${candidates.map(p => `<button class="mini" onpointerdown="draft.target='${p.id}'; renderPanel()">${escapeHtml(p.name)}</button>`).join('')}</div>`;
  html += `<div class="btn-row"><button class="primary" onpointerdown="castVote()" ${draft.target ? '' : 'disabled'}>投票</button><button onpointerdown="castVote(true)">弃票</button></div>`;
  const pct = v.need ? Math.round(v.voted / v.need * 100) : 0;
  html += `<div class="vote-progress"><div class="vp-bar"><div class="vp-fill" style="width:${pct}%"></div></div><span>已投 ${v.voted}/${v.need}</span></div>`;
  return html;
}
function renderPkSpeech() {
  const p = view.pkSpeech || {};
  let html = `<div class="panel-title">⚔️ PK 发言</div>`;
  html += `<div class="panel-desc">平票玩家 ${(p.tied || []).map(x => escapeHtml(x.name)).join('、')} 做最后陈述，然后重新投票。</div>`;
  if (p.canStartVote) html += `<div class="btn-row"><button class="primary" onpointerdown="act('startVote')">开始 PK 投票</button></div>`;
  else html += `<div class="waiting">等待房主开始 PK 投票…</div>`;
  return html;
}
function renderHunterShot() {
  return `<div class="panel-title">🔫 猎人开枪</div>` + hunterShotHtml(view.hunterShot);
}
function renderEnded() {
  const e = view.endInfo || {};
  let html = `<div class="winner-banner ${e.winner || ''}">${escapeHtml(e.text || '游戏结束')}</div>`;
  html += `<div class="panel-desc">本局身份公开：</div>`;
  html += `<div class="end-roles">` + (e.roles || []).map(r =>
    `<div class="player ${r.alive ? '' : 'dead'}"><div class="phead"><div class="avatar ${r.alive ? '' : 'dead'}">${avatarOf(r)}</div><div class="pmeta"><div class="pname">${escapeHtml(r.name)}${r.alive ? '' : ' 💀'}</div><div class="prole ${campClass(r.camp)}-role">${ROLE_EMOJI_TEXT[r.role] || ''} ${escapeHtml(r.role)}</div><div class="pdead"><span class="camp-tag ${campClass(r.camp)}">${escapeHtml(r.camp)}</span></div></div></div></div>`
  ).join('') + `</div>`;
  if (view.canRematch) html += `<div class="btn-row"><button class="primary" onpointerdown="act('rematch')">再来一局</button></div>`;
  return html;
}
function campClass(c) {
  if (c === '好人') return 'good';
  if (c === '狼人') return 'wolf';
  if (c === '第三方') return 'third';
  return '';
}

/* ---------------------------- 聊天 ---------------------------- */
function renderChat() {
  // 夜晚自动切私聊频道（48）：全体频道夜晚关闭时，直接切到狼/情侣
  if (view.phase === 'night' && chatTab === 'all') {
    const priv = (view.myChannels || []).find(ch => ch !== 'all');
    if (priv) chatTab = priv;
  }
  // 频道标签
  const tabs = [['all', '全体']];
  if (view.myChannels && view.myChannels.includes('wolf')) tabs.push(['wolf', '🐺 狼人(仅夜晚)']);
  if (view.myChannels && view.myChannels.includes('lover')) tabs.push(['lover', '💞 情侣']);
  if (!tabs.some(t => t[0] === chatTab)) chatTab = 'all';
  // 私聊红点（25）：非当前 tab 有新消息
  const dots = {};
  for (const t of tabs) {
    const key = t[0];
    if (key !== chatTab) {
      const last = lastTabTs[key] || 0;
      if (view.chat.some(m => m.ch === key && m.ts > last)) dots[key] = true;
    }
  }
  $('chat-tabs').innerHTML = tabs.map(t =>
    `<div class="chat-tab ${chatTab === t[0] ? 'active' : ''}${dots[t[0]] ? ' dot' : ''}" onclick="chatTab='${t[0]}'; renderChat()">${t[1]}</div>`).join('');
  // 消息
  const msgs = view.chat.filter(m => m.ch === chatTab);
  // 消息数变化或频道切换时才重绘（两个频道消息数恰好相同时，仅靠数量无法区分）
  if (msgs.length !== lastChatCount || lastChatTab !== chatTab) {
    $('chat-msgs').innerHTML = msgs.map(m => {
      if (m.marker === '系统') return `<div class="chat-sys">🛎️ ${escapeHtml(m.text)}</div>`;
      const mine = !!(m.from && m.from === me);
      const chCls = m.ch === 'wolf' ? 'ch-wolf' : m.ch === 'lover' ? 'ch-lover' : '';
      const lwCls = m.marker === '遗言' ? 'marker-lastword' : '';
      const sender = view.players.find(p => p.id === m.from);
      const av = sender ? avatarOf(sender) : '👤';
      return `<div class="chat-msg ${chCls} ${mine ? 'mine' : ''} ${lwCls}">
        ${mine ? '' : `<span class="cm-avatar">${av}</span>`}
        ${m.marker && m.marker !== '遗言' ? `<span class="cm-marker">${escapeHtml(m.marker)}</span>` : ''}
        <span class="cm-name">${escapeHtml(m.name)}</span><span class="cm-text">${escapeHtml(m.text)}</span></div>`;
    }).join('');
    lastChatCount = msgs.length;
    lastChatTab = chatTab;
    // 智能滚动（24）：距底部 <40px 才自动滚到底，用户上翻历史不被打断
    const box = $('chat-msgs');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  if (msgs.length) lastTabTs[chatTab] = msgs[msgs.length - 1].ts;
  // 发送权限：与服务端 chatAccess 一致（全体频道夜晚关闭；私密频道仅成员可发）
  const canSend = chatTab === 'all' ? view.phase !== 'night' : !!(view.myChannels && view.myChannels.includes(chatTab));
  const ci = $('chat-text'), cb = $('btn-chat');
  ci.disabled = !canSend;
  cb.disabled = !canSend;
  ci.placeholder = canSend ? '说点什么…' : (chatTab === 'all' && view.phase === 'night' ? '🌙 夜晚不能发言' : '该频道当前不可发言');
  // 快捷短语条（26）
  const qp = $('quick-phrases');
  if (qp) {
    if (canSend) {
      qp.classList.remove('hidden');
      const tgt = draft.target ? nameOf(draft.target) : '';
      const phrases = ['我跳预言家', '过', tgt ? '踩 ' + tgt : '踩', tgt ? '保 ' + tgt : '保', '哈哈哈', '晚上见'];
      qp.innerHTML = phrases.map(p => `<button onclick="quickPhrase('${p.replace(/'/g, '\\\'')}')">${escapeHtml(p)}</button>`).join('');
    } else qp.classList.add('hidden');
  }
}

/* ---------------------------- 交互辅助 ---------------------------- */
function alivePlayers() { return view.players.filter(p => p.alive); }
function playerOf(id) { return view.players.find(p => p.id === id); }

// 玩家卡片点击 → 选择目标（各面板根据 phase/step 决定用途）
document.addEventListener('click', e => {
  if (e.target.closest('button')) return; // 按钮（如心情表情/投票）不触发玩家卡选中
  const card = e.target.closest('.player');
  if (!card) return;
  const id = card.dataset.id;
  const p = playerOf(id);
  if (!p || !p.alive) return;
  const step = view.night && view.night.step;
  if (view.phase === 'vote' || view.phase === 'pk_vote' || view.phase === 'sheriff_vote') {
    // PK 投票只能投给平票玩家（与服务端校验一致）
    if (view.phase === 'pk_vote' && view.vote && view.vote.pkTied && !view.vote.pkTied.some(t => t.id === id)) return;
    draft.target = id; renderPanel(); renderPlayers();
    card.scrollIntoView({ block: 'nearest' }); // 选中卡片滚入视口（39）
  } else if (view.phase === 'night') {
    if (step === 'guard' && view.my.roleKey === 'guard') { draft.target = id; renderPanel(); renderPlayers(); card.scrollIntoView({ block: 'nearest' }); }
    else if (step === 'dreamer' && view.my.roleKey === 'dreamer') { draft.target = id; renderPanel(); renderPlayers(); card.scrollIntoView({ block: 'nearest' }); }
    else if (step === 'seer' && view.my.roleKey === 'seer') { draft.target = id; renderPanel(); renderPlayers(); card.scrollIntoView({ block: 'nearest' }); }
    else if (step === 'cupid' && view.my.roleKey === 'cupid') {
      // 点已选者取消；两人已满时点第三人替换 target2
      if (draft.target === id) draft.target = null;
      else if (draft.target2 === id) draft.target2 = null;
      else if (!draft.target) draft.target = id;
      else if (!draft.target2) draft.target2 = id;
      else draft.target2 = id;
      renderPanel(); renderPlayers();
    }
    else if (step === 'hunter' && view.night.hunter && view.night.hunter.shooter === view.my.id) { draft.target = id; renderPanel(); renderPlayers(); }
  } else if (view.phase === 'handover' && view.handover.from === view.my.id) {
    draft.target = id; renderPanel(); renderPlayers();
  }
});

function hostPick(role) { act('hostPick', { role }); }
function doThiefPick() {
  if (draft.thiefIdx === undefined) return toast('请先选择一张身份牌');
  return act('thief_pick', { idx: draft.thiefIdx });
}
function doCupidPick() {
  if (!draft.target || !draft.target2) return toast('请选择两名玩家');
  return act('cupid_pick', { ids: [draft.target, draft.target2] });
}
function doPick(action, kind) {
  const target = draft.target;
  if (!target) return toast('请选择目标');
  const r = act(action, { target });
  if (r) { if (kind === 'guard' || kind === 'dreamer') draft.target = null; }
  return r;
}
function setWolfKill(id) { draft.kill = id; renderPanel(); }
function setWolfCharm(id) { draft.charm = id; renderPanel(); }
function doWolfConfirm() {
  const data = {};
  if (draft.kill !== undefined) data.kill = draft.kill === 'none' ? null : draft.kill;
  if (draft.charm !== undefined) data.charm = draft.charm === 'none' ? null : draft.charm;
  data.confirm = true;
  draft.kill = undefined; draft.charm = undefined;
  return act('wolf_set', data);
}
function witchSave() { return act('witch_act', { save: true }); }
function witchPoison() {
  if (!draft.poison) return toast('请先选择毒杀目标');
  return act('witch_act', { poison: draft.poison });
}
function hunterShoot() { return act('hunter_shoot', { target: draft.target || null }); }
function sendLastword() {
  const text = $('lw-text').value;
  if (!text.trim()) return toast('请输入遗言内容');
  return act('post', { text });
}
function handoverPick() { return act('handover', { target: draft.target }); }
function castVote(abstain) {
  if (!abstain && !draft.target) return toast('请选择投票目标');
  return act('vote', { target: abstain ? null : draft.target });
}

/* ---------------------------- 大厅操作 ---------------------------- */
/* 人数滑条：拖动时仅本地更新显示（不发请求），松手才一次性提交 → 拖动顺滑不卡顿 */
function onCapInput(v) {
  const n = Math.min(18, Math.max(4, parseInt(v, 10) || 4));
  const tip = $('cap-tip');
  if (tip) tip.textContent = '当前 ' + n + ' 人（拖动中…）';
  const tt = $('cap-title-num');
  if (tt) tt.textContent = n;
}
function onCapChange(v) {
  const n = Math.min(18, Math.max(4, parseInt(v, 10) || 4));
  const tip = $('cap-tip');
  if (tip) tip.textContent = '当前 ' + n + ' 人';
  const tt = $('cap-title-num');
  if (tt) tt.textContent = n;
  act('setCap', { cap: n });
}
function countChange(key, delta) {
  const c = Object.assign({}, view.roleCounts);
  c[key] = Math.max(0, (c[key] || 0) + delta);
  if (key === 'wolf' && c.wolf < 1) c.wolf = 1;
  if (key === 'villager' && c.villager < 1) c.villager = 1;
  act('setCounts', { counts: c });
}
function onSetting(key, val) { act('settings', { [key]: val }); }
function onWinMode(v) { act('settings', { winMode: v }); }
function onTieRule(v) { act('settings', { tieRule: v }); }
function onThief(v) { act('settings', { thief: v }); }
function kick(id) { api('api/kick', { room: roomId, me, target: id }).then(r => { if (r.error) toast(r.error); else { applyView(r.view); resetPollTimer(); render(); } }); }

/* ---------------------------- 初始化 ---------------------------- */
/* ============ UI/UX v3 辅助 ============ */
/* 阶段面包屑（5）：显示当前阶段到投票的步骤链 */
function renderBreadcrumb() {
  const el = $('breadcrumb');
  if (!el) return;
  const chain = [
    ['morning', '🌅 公告'], ['lastword', '💬 遗言'], ['handover', '👮 警徽'], ['sheriff_campaign', '🗳️ 竞选'],
    ['sheriff_vote', '🗳️ 警长投票'], ['discuss', '☀️ 发言'], ['vote', '🗳️ 投票'],
    ['pk_speech', '⚔️ PK 发言'], ['pk_vote', '🗳️ PK 投票'], ['hunter_shot', '🔫 开枪'],
  ];
  const idx = chain.findIndex(s => s[0] === view.phase);
  el.innerHTML = idx >= 0
    ? chain.slice(idx).map((s, i) => `<span class="bc-step ${i === 0 ? 'bc-now' : ''}">${s[1]}</span>`).join('<span class="bc-arrow">→</span>')
    : '';
}
/* 强制继续智能判定（7）：存在未操作者才点亮 */
function shouldForceContinue() {
  const v = view; if (!v) return false;
  if (v.phase === 'morning' || v.phase === 'discuss' || v.phase === 'handover' || v.phase === 'hunter_shot') return true;
  if (v.phase === 'night') return (v.night && v.night.actors || []).some(a => !a.acted);
  if (v.phase === 'vote' || v.phase === 'pk_vote') return !!(v.vote && v.vote.need > 0 && v.vote.voted < v.vote.need);
  if (v.phase === 'sheriff_vote') return !!(v.sheriffVote && v.sheriffVote.need > 0 && v.sheriffVote.voted < v.sheriffVote.need);
  if (v.phase === 'sheriff_campaign') return true;
  if (v.phase === 'lastword') return (v.lastword && v.lastword.entitled || []).some(e => !e.posted);
  return false;
}
/* 玩家进出提示（45） */
let leaveArmed = false; // 离开二次确认（10）
let prevPlayerIds = null, prevPlayerNames = {};
function diffPlayers() {
  const ids = new Set(view.players.map(p => p.id));
  if (prevPlayerIds) {
    for (const pid of prevPlayerIds) if (!ids.has(pid)) { const n = prevPlayerNames[pid]; if (n) toast(`🚪 ${n} 离开了房间`, 'sys'); }
    for (const p of view.players) if (!prevPlayerIds.has(p.id)) toast(`🟢 ${p.name} 加入了房间`, 'sys');
  }
  prevPlayerIds = ids;
  view.players.forEach(p => { prevPlayerNames[p.id] = p.name; });
}
/* 快捷短语（26） */
function quickPhrase(txt) {
  const ci = $('chat-text');
  if (!ci || ci.disabled) return;
  ci.value = (ci.value ? ci.value + ' ' : '') + txt;
  ci.focus();
}
/* 身份大卡弹窗（8） */
function openRolePop() {
  const pop = $('role-pop');
  if (!pop || !view.my.role) return;
  $('rp-emoji').textContent = ROLE_EMOJI_TEXT[view.my.role] || '🎭';
  $('rp-name').textContent = view.my.role;
  $('rp-desc').textContent = view.my.desc || '';
  const card = pop.querySelector('.rp-card');
  card.className = 'rp-card ' + (ROLE_CAMP_TEXT[view.my.role] || '');
  pop.classList.remove('hidden');
}
function closeRolePop() { const pop = $('role-pop'); if (pop) pop.classList.add('hidden'); }
/* 规则速览（14） */
function buildRulesList() {
  const el = $('rules-list'); if (!el) return;
  const skills = {
    villager: '无技能，靠发言找狼', seer: '每晚查验一人', witch: '一解药一毒药，可自救', hunter: '出局可开枪带人',
    dreamer: '每晚梦游一人', guard: '每晚守护一人，不能连守', wolf: '夜晚刀人', wolfBeauty: '被放逐带走魅惑者',
    cupid: '指定情侣', thief: '开局窃取一张身份牌',
  };
  el.innerHTML = Object.keys(ROLE_NAMES).map(k =>
    `<div class="rules-item ${ROLE_CAMP[k] || ''}"><span class="ri-camp"></span><span>${ROLE_EMOJI[k] || ''} ${ROLE_NAMES[k]}：${skills[k] || ''}</span></div>`
  ).join('');
  const rv = $('rules-view'); if (rv) rv.classList.remove('hidden');
}
function init() {
  // 记住昵称 + 上次房间（12/13）
  const savedName = localStorage.lwName;
  if (savedName) $('in-name').value = savedName;
  buildRulesList();
  const lastRoom = localStorage.lwRoom;
  if (lastRoom) {
    const lr = $('last-room'); if (lr) lr.classList.remove('hidden');
    const b = $('btn-last-room'); if (b) b.textContent = '🚪 上次房间 ' + lastRoom + ' · 重新进入';
  }
  $('btn-last-room').addEventListener('click', async () => {
    const code = localStorage.lwRoom; if (!code) return;
    const name = $('in-name').value.trim() || '玩家' + Math.floor(Math.random() * 900 + 100);
    $('home-err').textContent = '';
    const r = await api('api/join', { roomId: code, name });
    if (r.error || !r.playerId) { toast('无法进入上次房间：' + (r.error || '房间可能已解散'), 'err'); return; }
    localStorage.lwName = name;
    localStorage.lwRoom = code;
    enterRoom(code, r.playerId, r.view);
    toast('🎉 已进入房间 ' + code);
  });
  // 白天阶段/夜晚步骤/盗贼选牌倒计时：每秒更新顶栏剩余秒数（数据来自服务端 deadline）
  setInterval(() => {
    const el = document.getElementById('phase-countdown');
    if (!el) return;
    // 优先级：白天阶段 > 夜晚步骤 > 盗贼选牌
    const dl = view && (view.phaseDeadline || view.nightDeadline || view.hunterDeadline || view.revealDeadline);
    if (view && dl) {
      const left = Math.ceil((dl - Date.now()) / 1000);
      if (left > 0) { el.textContent = '⏱ ' + left + 's'; el.classList.toggle('urgent', left <= 10); }
      else el.textContent = '';
    } else el.textContent = '';
    // 顶栏底部倒计时进度条（白天用 PHASE_TIMEOUT，夜晚/盗贼用 NIGHT_TIMEOUT 比例收缩）
    const bar = document.getElementById('phase-bar-fill');
    if (bar) {
      const dl2 = view && (view.phaseDeadline || view.nightDeadline || view.hunterDeadline || view.revealDeadline);
      const totalSec = view && view.phaseDeadline ? (view.phaseTimeout || 30) : (view.nightTimeout || 30);
      if (view && dl2 && totalSec) {
        const leftMs = dl2 - Date.now();
        const pct = Math.max(0, Math.min(100, leftMs / (totalSec * 1000) * 100));
        bar.style.width = pct + '%';
        bar.classList.toggle('urgent', leftMs <= 10000);
        bar.parentElement.classList.remove('hidden');
      } else {
        bar.parentElement.classList.add('hidden');
        bar.style.width = '0%';
      }
    }
  }, 1000);
  // file:// 协议检测：直接双击打开 index.html 无法联机
  if (location.protocol === 'file:') {
    $('home-err').textContent = '❌ 请勿直接双击打开本文件。请先运行 node server.js，再通过 http://localhost:3000 访问';
  } else {
    // 服务器连接自检
    fetch('healthz').then(r => r.json()).catch(() => {
      $('home-err').textContent = '⚠️ 无法连接服务器：请确认已运行 node server.js，然后访问 http://localhost:3000';
    });
  }
  // 首页
  $('btn-create').addEventListener('click', async () => {
    const name = $('in-name').value.trim() || '玩家' + Math.floor(Math.random() * 900 + 100);
    $('home-err').textContent = '';
    const btn = $('btn-create');
    btn.disabled = true; btn.textContent = '创建中…'; // 忙碌态防连点（16）
    const r = await api('api/create', { name });
    btn.disabled = false; btn.textContent = '创建房间';
    if (r.error || !r.roomId || !r.playerId) { $('home-err').textContent = r.error || '创建失败，请重试'; return; }
    localStorage.lwName = name;
    localStorage.lwRoom = r.roomId;
    enterRoom(r.roomId, r.playerId, r.view);
    toast('🎉 房间创建成功：' + r.roomId);
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(r.roomId); } catch (e) {}
  });
  $('btn-join').addEventListener('click', () => {
    $('join-line').classList.toggle('hidden');
    if (!$('join-line').classList.contains('hidden')) $('in-code').focus();
  });
  $('btn-join-go').addEventListener('click', async () => {
    const code = $('in-code').value.trim().toUpperCase();
    const name = $('in-name').value.trim() || '玩家' + Math.floor(Math.random() * 900 + 100);
    if (!/^[0-9A-Z]{6}$/.test(code)) return toast('房间号格式错误（6 位数字或字母）');
    $('home-err').textContent = '';
    const r = await api('api/join', { roomId: code, name });
    if (r.error || !r.playerId) { $('home-err').textContent = r.error || '加入失败，请检查房间号'; return; }
    enterRoom(code, r.playerId, r.view);
    toast('🎉 已进入房间 ' + code);
  });
  $('btn-copy').addEventListener('click', () => {
  if (navigator.clipboard) navigator.clipboard.writeText(view.roomId).then(() => toast('房间号已复制'));
  else toast('房间号：' + view.roomId);
});
$('btn-leave').addEventListener('click', async () => {
    // 离开二次确认（10）：第一次变红色确认态，3 秒内再点才生效
    if (!leaveArmed) {
      leaveArmed = true;
      const b = $('btn-leave');
      b.textContent = '确认离开？';
      b.classList.add('confirming');
      setTimeout(() => { if (leaveArmed) { leaveArmed = false; b.textContent = '离开'; b.classList.remove('confirming'); } }, 3000);
      return;
    }
    leaveArmed = false;
    await api('api/leave', { room: roomId, me });
    clearSession();
    location.reload();
  });
  // 房号点击即复制（9）
  $('room-code').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText(view.roomId).then(() => toast('房间号已复制'));
    else toast('房间号：' + view.roomId);
  });
  // 身份芯片点击 → 大卡弹窗（8）
  $('my-role-chip').addEventListener('click', openRolePop);
  $('role-pop').addEventListener('click', closeRolePop);
  // 移动端聊天抽屉（2）
  const bco = $('btn-chat-open');
  if (bco) bco.classList.remove('hidden');
  $('btn-chat-open').addEventListener('click', e => { e.stopPropagation(); document.body.classList.toggle('chat-open'); });
  document.addEventListener('click', e => {
    if (document.body.classList.contains('chat-open') && !e.target.closest('#right') && !e.target.closest('#btn-chat-open')) {
      document.body.classList.remove('chat-open');
    }
  });
  $('btn-force').addEventListener('click', () => { if (view && view.my && view.my.isHost) doAdvance(); });
  $('btn-chat').addEventListener('click', sendChat);
  $('chat-text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) sendChat(); });
  const oc = $('on-close');
  if (oc) oc.addEventListener('click', hideOverlay); // 空值守卫：缺元素不导致 init 崩溃（C1）
  $('in-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join-go').click(); });
  $('in-code').addEventListener('input', () => { const v = $('in-code').value.trim().toUpperCase(); if (v.length === 6 && /^[0-9A-Z]{6}$/.test(v)) $('btn-join-go').click(); }); // 6 位自动进入（15）
  $('in-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create').click(); });

  // 重连
  const s = loadSession();
  if (s && s.room && s.me) {
    (async () => {
      const res = await fetch(`api/state?room=${encodeURIComponent(s.room)}&me=${encodeURIComponent(s.me)}`);
      const j = await res.json();
      if (!j.error) enterRoom(s.room, s.me, j);
      else clearSession();
    })();
  }
}
function sendChat() {
  if ($('chat-text').disabled) return; // 当前频道不可发言（如夜晚全体频道）
  const text = $('chat-text').value.trim();
  if (!text) return;
  $('chat-text').value = '';
  chatSend(chatTab, text);
}
function enterRoom(room, playerId, v) {
  if (!room || !playerId) return; // 参数缺失则留在首页
  roomId = room;
  me = playerId;
  view = v;
  lastPhaseKey = null;
  prevPlayerIds = null; // 进出提示基准重置（45）
  saveSession();
  // 重名提示（47）
  const dup = v.players && v.players.find(p => p.id !== playerId && p.name === (v.my && v.my.name));
  if (dup) toast(`⚠️ 与「${dup.name}」重名，注意区分`, 'err');
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  render();
  resetPollTimer();
  poll();
}
init();
