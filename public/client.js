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
let sse = null;            // EventSource（SSE 推送唤醒）
let sseConnected = false;  // SSE 当前是否可用
const SSE_HEARTBEAT_MS = 30000; // SSE 可用时的心跳轮询间隔（30 秒）
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

/* 趣味昵称生成器（v1.2.0）：与座位动物头像风格统一，告别“玩家123” */
const NICK_A = ['神秘', '熬夜', '迷糊', '暴躁', '温柔', '社恐', '早起', '咸鱼', '佛系', '炫酷'];
const NICK_B = ['小狐狸', '猫头鹰', '北极熊', '刺猬', '柴犬', '水獭', '企鹅', '花栗鼠', '树懒', '小狼'];
let genNick = '';
function randNick() { return NICK_A[Math.floor(Math.random() * NICK_A.length)] + NICK_B[Math.floor(Math.random() * NICK_B.length)]; }
/* 填入随机昵称并记住（首访自动生成 / 🎲 换一个）；昵称输入框为空时用它兜底 */
function fillNick() {
  genNick = randNick();
  const el = $('in-name');
  if (el) el.value = genNick;
  try { localStorage.lwName = genNick; } catch (e) {}
}
function nickValue() { return ($('in-name') && $('in-name').value.trim()) || genNick || randNick(); }

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
// 职业专属光晕色（中文名→色值，与 ROLE_EMOJI_TEXT 对齐；--rc 用于身份卡/死亡卡/睁眼提示）
const ROLE_GLOW_TEXT = { '平民': '#7fd4a8', '预言家': '#5aa2ff', '女巫': '#b06af0', '猎人': '#ff8c5a', '摄梦人': '#6ad8d0', '守卫': '#ffd166', '狼人': '#ff6b6b', '狼美人': '#ff7bac', '丘比特': '#ff8fd8', '盗贼': '#ffd76a' };
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
let lastInfoHtml = null;   // 信息区内容缓存（配合重绘守卫：内容未变不重建 DOM）
let prevSheriff = null;    // 上次渲染的警长（变化时触发警徽飞行/撕毁提示）
let prevFocusPhase = null; // 上次触发过“选人自动滚动”的阶段键（每阶段仅滚动一次）
let pollFail = 0;          // 连续轮询失败计数（>=2 显示弱网横幅）
let prevMyTurn = false;    // 上次是否轮到我行动（变化时短震，v1.3.0）
let AC = null;             // Web Audio 上下文（首次用户交互后创建）
let sfxOn = true;          // 音效开关（localStorage ww_sfx）

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
  fxForAction(action, data || {}); // v1.3.0：行动成功 → 目标卡反馈动画
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
  collectStats(v); // v1.3.0：赛后趣味统计本地累积（增量聊天按 id 去重）
  // 新一局（rematch / 重新开局）→ 清空本局统计
  if (view && view.phase === 'ended' && v.phase !== 'ended' && stat.deaths.length) resetStats();
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
  // 连续失败（>=2 次）→ 指数退避，避免断线时轰炸隧道
  if (pollFail >= 2) return Math.min(15000, 2000 * Math.pow(2, pollFail - 2));
  // SSE 正常 → 长心跳即可（状态变化由推送即时触发）
  if (sseConnected) return SSE_HEARTBEAT_MS;
  // 常规轮询（SSE 不可用时回退原逻辑）
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
    pollFail = 0; hideNetBanner(); // 服务器有响应即视为网络正常（29）
    if (j.error) {
      if (j.error === 'room-not-found') { toast('房间已解散'); clearSession(); setTimeout(() => location.reload(), 1200); return; }
      if (j.error === 'player-not-found') { vibrate([120, 60, 120]); clearSession(); setTimeout(() => location.reload(), 800); return; } // 被踢：两段震（v1.3.0）
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
  } catch (e) {
    ensurePollTimer();
    pollFail++;
    if (pollFail >= 2) showNetBanner(); // 连续失败 2 次提示弱网，成功自动消失（29）
  }
  finally { pollBusy = false; }
}

/* 立即执行一次轮询（SSE 推送触发；pollBusy 防重入） */
function pollNow() {
  if (!roomId || !me) return;
  poll();
}

/* ============ SSE 推送唤醒（可选优化，失败自动回退轮询） ============ */
function connectSSE() {
  if (!roomId || !me) return;
  try { if (sse) sse.close(); } catch (e) {}
  sseConnected = false;
  try {
    sse = new EventSource(`api/stream?room=${encodeURIComponent(roomId)}&me=${encodeURIComponent(me)}`);
    sse.onopen = () => { sseConnected = true; ensurePollTimer(); }; // 切到 30s 心跳
    sse.onmessage = e => {
      try {
        const j = JSON.parse(e.data);
        if (!j) return;
        if (j.gone) { toast('房间已解散'); clearSession(); setTimeout(() => location.reload(), 1200); return; }
        if (j.v && view && j.v > view.v) pollNow(); // 版本变化 → 立即拉取最新状态
      } catch (e) { /* 忽略非 JSON 数据 */ }
    };
    sse.onerror = () => {
      // SSE 断开：立即回退常规轮询（含指数退避），5 秒后尝试重连
      sseConnected = false;
      try { if (sse) sse.close(); } catch (e) {}
      sse = null;
      ensurePollTimer();
      setTimeout(connectSSE, 5000);
    };
  } catch (e) { sse = null; sseConnected = false; }
}

/* ---------------------------- 状态变化提示 ---------------------------- */
/* 夜晚/天亮过渡遮罩（#overlay-night） */
let overlayTimer = null;
function showOverlay(title, sub, card, deaths, emoji, waitPulse) {
  const ov = $('overlay-night');
  if (!ov) return;
  ov.querySelector('.on-title').innerHTML = title;
  ov.querySelector('.on-sub').textContent = sub;
  const cardEl = ov.querySelector('.on-card');
  const dd = $('on-deaths');
  // deaths 为 HTML（死亡翻牌卡/平安夜金光）时原样注入，纯文本时包成 od-item（6）
  if (dd) dd.innerHTML = (deaths && deaths.indexOf('<') >= 0) ? deaths : (deaths ? `<div class="od-item">${deaths}</div>` : '');
  const oe = $('on-card-emoji');
  if (oe) oe.textContent = emoji || '';
  if (card) { cardEl.classList.remove('hidden'); $('on-card-title').textContent = card; }
  else cardEl.classList.add('hidden');
  ov.classList.toggle('night-wait', !!waitPulse); // 非行动者：柔和呼吸光（6）
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
    sfxWolf();
    // 仅存活玩家展示“第 N 夜”遮罩（已出局玩家不阻塞观战）；6 秒防呆自动关闭，也可点“开始行动”提前关闭
    if (view && view.my.alive) {
      const acting = !!(view.night && view.night.actors || []).some(a => a.id === view.my.id); // 轮到我行动才给身份卡
      showOverlay(`🌙 第 ${view.nightNum || 1} 夜`, '天黑请闭眼，请等待各位行动…', acting ? `你是：${view.my.role || '？'}` : null, null, ROLE_EMOJI_TEXT[view.my.role] || '🎭', !acting);
      const oe = $('on-card-emoji');
      if (oe && ROLE_GLOW_TEXT[view.my.role]) oe.style.setProperty('--rc', ROLE_GLOW_TEXT[view.my.role]); // 角色专属光晕（3）
      overlayTimer = setTimeout(hideOverlay, 6000);
    }
  } else if (next === 'morning') {
    toast('🌅 天亮了');
    const deaths = view.morningDeaths || [];
    if (deaths.length) {
      // 死亡翻牌（11）：背面牌依次翻面露出身份+死因；死亡翻牌是规则自带环节，动画放遮罩层不参与重绘
      const flipHtml = `<div class="flip-grid">` + deaths.map((d, i) => {
        const glow = ROLE_GLOW_TEXT[d.role] || '';
        return `<div class="flip-card" style="animation-delay:${i * 240}ms"><div class="fc-inner">` +
          `<div class="fc-face fc-back"></div>` +
          `<div class="fc-face fc-front" ${glow ? `style="--rc:${glow}"` : ''}><div class="fc-name">${escapeHtml(d.name)}</div><div class="fc-emoji">${ROLE_EMOJI_TEXT[d.role] || '💀'}</div>` +
          `<div class="fc-role">${escapeHtml(d.role || '？')}</div><div class="fc-cause">${DEATH_TEXT[d.deadBy] || d.deadBy}</div></div>` +
          `</div></div>`;
      }).join('') + `</div>`;
      showOverlay('☀️ 天亮了', '请查看昨晚结果', null, flipHtml, '☀️');
      sfxFlip();
      const oe = $('on-card-emoji');
      if (oe) oe.style.setProperty('--rc', '#ffd76a');
      overlayTimer = setTimeout(hideOverlay, Math.max(2800, 1800 + deaths.length * 500));
    } else {
      // 平安夜：金色光芒（11）
      showOverlay('☀️ 天亮了', '昨夜平安无事', null, `<div class="safe-morning">🌙 昨夜平安无事</div>`, '☀️');
      sfxMorning();
      overlayTimer = setTimeout(hideOverlay, 2600);
    }
  } else if (next === 'ended') { toast('🏁 游戏结束'); sfxMorning(); }
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
  // 轮到我选人：玩家区扫光 + 动作图标（7/8）——在 renderPlayers 之前设置好图标
  const pIcon = pickIconFor();
  const playersEl = $('players');
  if (playersEl) {
    playersEl.dataset.pick = pIcon;
    playersEl.classList.toggle('pick-mode', !!pIcon && view.players.some(x => x.alive && x.id !== view.my.id));
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
  // 移动端自动滚动到玩家列表（7）：每个选择阶段仅一次，不打扰用户上翻
  if (pIcon && prevFocusPhase !== lastPhaseKey && playersEl) {
    prevFocusPhase = lastPhaseKey;
    if (window.matchMedia('(max-width: 900px)').matches) playersEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // 警徽飞行/撕毁提示/落位（13/16）：仅在非移交阶段比较（移交中警长仍是旧任）
  if (view.phase === 'lobby' || view.phase === 'ended') prevSheriff = null;
  else if (view.phase !== 'handover' && view.sheriff !== prevSheriff) {
    if (prevSheriff && view.sheriff) { const old = playerOf(prevSheriff); if (old && !old.alive) flySheriffBadge(prevSheriff, view.sheriff); }
    else if (prevSheriff && !view.sheriff) toast('👮 警徽被撕毁', 'sys');
    else if (!prevSheriff && view.sheriff) sheriffPop(view.sheriff);
    prevSheriff = view.sheriff;
  }
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
      toast(`💀 ${p.name}：${DEATH_TEXT[p.deadBy] || p.deadBy}`, 'death');
      sfxHeavy(); // 死亡重击音效（33）
      if (p.id === view.my.id) vibrate(300); // 自己被刀：长震（v1.3.0）
    }
    prevAlive[p.id] = false;
  }
  for (const p of alive) prevAlive[p.id] = true;
  const card = p => {
    const flashCls = !p.alive && deadFlash[p.id] > Date.now() ? ' death-flash' : '';
    // 竞选角标（16）：警长竞选报名阶段的竞选者
    const isCandidate = view.phase === 'sheriff_campaign' && view.campaign && view.campaign.candidates.some(c => c.id === p.id);
    // 选中动作图标（8）：本轮需要选人时，已选卡片右上角浮出动作图标
    const pickIc = p.alive && (draft.target === p.id || draft.target2 === p.id) ? (($('players') && $('players').dataset.pick) || '✓') : '';
    const name = (p.alive ? '' : '💀 ') + escapeHtml(p.name) + (p.isBot ? ' <span class="badge bot-badge" title="人机">🤖</span>' : '') + (p.isMe ? ' <span class="badge">我</span>' : '') + (p.sheriff ? ' <span class="sheriff-mark" title="警长">👮</span>' : '') + (isCandidate ? ' <span class="badge cam-badge">🎤 竞选</span>' : '') + (p.isMe && view.myLover ? ' <span class="p-badge" title="情侣">💞</span>' : '');
    const moodHtml = p.isMe
      ? `<button class="mood-btn ${p.mood ? 'has' : ''}" onclick="cycleMood()" title="心情表情，点击切换">${p.mood || '🎭'}</button>`
      : (p.mood ? `<span class="mood-tag">${escapeHtml(p.mood)}</span>` : '');
    const role = p.role ? `<div class="prole ${ROLE_CAMP_TEXT[p.role] || ''}">${ROLE_EMOJI_TEXT[p.role] || ''} ${escapeHtml(p.role)}</div>` : '';
    const deadTxt = p.alive ? '' : `<div class="pdead">💀 ${DEATH_TEXT[p.deadBy] || p.deadBy}${p.deadNote ? '（' + escapeHtml(p.deadNote) + '）' : ''}</div>`;
    return `<div class="player ${p.isMe ? 'me' : ''} ${p.alive ? '' : 'dead'}${flashCls} ${draft.target === p.id || draft.target2 === p.id ? 'selected' : ''}" data-id="${p.id}">
      <div class="phead"><div class="avatar ${p.alive ? '' : 'dead'}">${avatarOf(p)}</div>
      <div class="pmeta"><div class="pname">${name}${moodHtml}<span class="pseat">#${p.seat}</span></div>${role}${deadTxt}</div></div>
      ${pickIc ? `<span class="pick-ic">${pickIc}</span>` : ''}
    </div>`;
  };
  // 座位排序 + 墓地分区（3 轻量版）：存活区按 seat 升序，墓地带分组头、死者保留座位号（hover 展开详情）
  $('players').innerHTML = alive.map(card).join('') +
    (dead.length ? `<div class="dead-title">💀 已出局（${dead.length}）</div>` + dead.map(card).join('') : '');
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
      // 揭晓动画（12）：数字滚动（0→最终票数）；放逐行红闪碎裂、平票行对撞
      const shakeCls = lv.result === 'tie' ? ' tie-shake' : '';
      totals = Object.entries(lv.totals).map(([id, n]) => {
        const isExiled = lv.exiled === id;
        return `<div class="vt-line ${isExiled ? 'win' : ''}${isExiled && lv.result === 'exile' ? ' exile-shake' : ''}${shakeCls}" style="animation-delay:${isExiled && lv.result === 'exile' ? 220 : 0}ms"><span>${escapeHtml(nameOf(id))}</span><span class="vt-n" data-n="${n}">…</span></div>`;
      }).join('');
      totals = `<div class="vote-total">${totals}</div>`;
    }
    html += `<div class="panel-title">${kind}</div><div>${resTxt}</div>${totals}`;
  }
  // 重绘守卫 + 内容缓存：内容未变化不重建 DOM（避免数字动画/弹入动画反复触发）
  if (html) {
    if (info.innerHTML !== html && lastInfoHtml !== html) { info.innerHTML = html; info.classList.add('show'); }
    lastInfoHtml = html;
  } else info.classList.remove('show');
  animateTotals();
}
/* 计票数字滚动（12）：0 → 最终票数，520ms 缓出；每个数字只跑一次 */
function animateTotals() {
  if (lessMotion()) return;
  document.querySelectorAll('#info .vt-n[data-n]').forEach(el => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const n = parseFloat(el.dataset.n) || 0;
    const t0 = performance.now();
    const step = now => {
      const p = Math.min(1, (now - t0) / 520);
      el.textContent = Math.round(n * (1 - Math.pow(1 - p, 3)) * 10) / 10; // R2：保留 1.5 票等小数（parseFloat + 一位小数）
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function deathListHtml(list, title) {
  return `<div class="panel-title">💀 ${title}</div><div class="death-list">` + list.map(d =>
    `<div class="death-item"><div class="di-emoji">${ROLE_EMOJI_TEXT[d.role] || '💀'}</div><div class="di-name">${escapeHtml(d.name)}</div><div class="di-role">${ROLE_EMOJI_TEXT[d.role] || ''} ${escapeHtml(d.role || '?')}</div><div class="di-cause">${DEATH_TEXT[d.deadBy] || d.deadBy}${d.deadNote ? '（' + escapeHtml(d.deadNote) + '）' : ''}</div></div>`
  ).join('') + `</div>`;
}
function nameOf(id) { const p = view.players.find(x => x.id === id); return p ? p.name : '?'; }

/* ---------------------------- 主面板 ---------------------------- */
function renderPanel() {
  const panel = $('panel');
  panel.classList.remove('night-panel', 'wolf-panel');
  // 轮到我行动 → 面板呼吸光圈（“睁眼”高亮）+ 首次轮到我时短震（v1.3.0）
  const myTurn = view.phase !== 'lobby' && view.phase !== 'reveal' && view.phase !== 'ended' && needsFastPoll();
  if (myTurn && !prevMyTurn) vibrate(60);
  prevMyTurn = myTurn;
  panel.classList.toggle('my-turn', myTurn);
  let html;
  switch (view.phase) {
    case 'lobby': html = renderLobby(); break;
    case 'reveal': html = renderReveal(); break;
    case 'night': {
      html = renderNight();
      panel.classList.add('night-panel');
      // 角色睁眼氛围（v1.3.0）：面板光晕随夜晚步骤变角色色（预言家蓝/女巫紫/守卫绿…）
      const nstep = view.night && view.night.step;
      if (nstep) {
        const STEP_GLOW = { thief: 'rgba(232,182,76,.4)', cupid: 'rgba(255,122,200,.5)', lovers: 'rgba(255,122,200,.35)', guard: 'rgba(74,222,128,.4)', dreamer: 'rgba(106,216,208,.45)', wolf: 'rgba(224,96,96,.45)', seer: 'rgba(90,162,255,.5)', witch: 'rgba(176,106,240,.5)', hunter: 'rgba(255,140,90,.45)' }[nstep];
        if (glow) panel.style.setProperty('--step-glow', glow);
      }
      // 狼人行动时面板整体泛红 + 狼印水印（9）
      if (view.night && view.night.step === 'wolf' && view.my && (view.my.roleKey === 'wolf' || view.my.roleKey === 'wolfBeauty')) panel.classList.add('wolf-panel');
      break;
    }
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
  if (panel.innerHTML !== html) {
    panel.innerHTML = html;
    // 面板切换轻过渡（5）：仅内容真正变化时触发；用 Web Animations，与 CSS 动画（呼吸光圈等）互不干扰
    if (!lessMotion() && panel.animate) {
      if (panel._swapAnim) panel._swapAnim.cancel(); // S5：终止上一次未完成的切换动画，避免叠加
      panel._swapAnim = panel.animate(
        [{ opacity: .4, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, easing: 'ease-out' }
      );
    }
  }
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
      `<div class="role-card ${ROLE_CAMP[r.key] || ''}" style="--rc:${ROLE_GLOW_TEXT[r.name] || ''};animation-delay:${i * 60}ms" onclick="hostPick('${r.key}')"><div class="rc-emoji">${ROLE_EMOJI[r.key] || ''}</div><div class="rc-name">${r.name}</div><div class="rc-desc">${escapeHtml(r.desc)}</div></div>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button onclick="hostPick('random')">🎲 随机分配</button></div>`;
  } else if (rv.isThief && rv.thiefCards) {
    // 盗贼选牌（注意：非房主拿到的 stage 为 null，不能作为判断依据；isThief/thiefCards 已由服务端判定）
    html += `<div class="panel-desc">🃏 你是<b>盗贼</b>！从以下两张身份牌中选择一张作为你的身份（若有狼人牌则必须选狼人），另一张作废：</div>`;
    // 盗贼警示（24）：两张牌含狼时红框闪烁提示条
    const thiefHasWolf = (rv.thiefCards || []).some(r => r.key === 'wolf' || r.key === 'wolfBeauty');
    if (thiefHasWolf) html += `<div class="tip-text thief-warn">⚠️ <b>两张牌中有狼人牌，你必须选择狼人！</b></div>`;
    html += `<div class="role-cards">` + (rv.thiefCards || []).map((r, i) =>
      `<div class="role-card ${ROLE_CAMP[r.key] || ''} ${thiefHasWolf && (r.key === 'wolf' || r.key === 'wolfBeauty') ? 'thief-wolf' : ''} ${draft.thiefIdx === i ? 'chosen' : ''}" style="--rc:${ROLE_GLOW_TEXT[r.name] || ''};animation-delay:${i * 80}ms" onclick="draft.thiefIdx = ${i}; render()"><div class="rc-emoji">${ROLE_EMOJI[r.key] || ''}</div><div class="rc-name">${r.name}</div><div class="rc-desc">${escapeHtml(r.desc)}</div></div>`
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
    const glow = ROLE_GLOW_TEXT[rv.myRole] || '';
    html += `<div class="identity-reveal ${ROLE_CAMP_TEXT[rv.myRole] || ''}" ${glow ? `style="--rc:${glow}"` : ''}><span class="ir-emoji">${ROLE_EMOJI_TEXT[rv.myRole] || '🎭'}</span><div class="ir-name">${escapeHtml(rv.myRole)}</div></div>`;
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
  if (s.myVoted) html += `<div class="tip-text voted-ok">✅ 已投${s.myVote ? '：' + escapeHtml(nameOf(s.myVote)) : '（弃票）'}</div>`; // 投票确认条（15）
  else html += `<div class="btn-row"><button class="primary" onpointerdown="castVote()" ${draft.target ? '' : 'disabled'}>投票</button><button onpointerdown="castVote(true)">弃票</button></div>`;
  html += `<div class="tip-text">已投 ${s.voted}/${s.need}</div>`;
  // 房主可见的“谁已投/投给谁”明细（v1.3.0）；非房主不下发
  if (s.votedBy && s.votedBy.length) {
    html += `<div class="vote-detail"><div class="vd-title">👁️ 房主 · 已投明细</div><div class="vd-list">` +
      s.votedBy.map(x => `<span class="vd-item">${escapeHtml(x.name)}${x.vote ? ' → ' + escapeHtml(nameOf(x.vote)) : '（弃票）'}</span>`).join('') +
      `</div></div>`;
  }
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
  if (v.myVoted) html += `<div class="tip-text voted-ok">✅ 已投${v.myVote ? '：' + escapeHtml(nameOf(v.myVote)) : '（弃票）'}</div>`; // 投票确认条（15）
  else html += `<div class="btn-row"><button class="primary" onpointerdown="castVote()" ${draft.target ? '' : 'disabled'}>投票</button><button onpointerdown="castVote(true)">弃票</button></div>`;
  const pct = v.need ? Math.round(v.voted / v.need * 100) : 0;
  html += `<div class="vote-progress${v.need > v.voted ? ' incomplete' : ''}"><div class="vp-bar"><div class="vp-fill" style="width:${pct}%"></div></div><span>已投 ${v.voted}/${v.need}</span></div>`; // 未投完进度条闪烁提醒（15）
  // 房主可见的“谁已投/投给谁”明细（v1.3.0）；非房主不下发（votedBy undefined）
  if (v.votedBy && v.votedBy.length) {
    html += `<div class="vote-detail"><div class="vd-title">👁️ 房主 · 已投明细</div><div class="vd-list">` +
      v.votedBy.map(x => `<span class="vd-item">${escapeHtml(x.name)}${x.vote ? ' → ' + escapeHtml(nameOf(x.vote)) : '（弃票）'}</span>`).join('') +
      `</div></div>`;
  }
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
  // 赛后趣味统计（v1.3.0）：整局本地累积的彩蛋
  const fun = statStats();
  if (fun) {
    html += `<div class="fun-stats"><div class="panel-title">🎉 本局趣闻</div>`;
    if (fun.talker) html += `<div class="fs-row">🗣️ 最话痨：<b>${escapeHtml(fun.talker)}</b>（${fun.talkerN} 条）</div>`;
    if (fun.first) html += `<div class="fs-row">💀 最快出局：<b>${escapeHtml(fun.first)}</b>（第 1 夜）</div>`;
    if (fun.worst) html += `<div class="fs-row">🌙 最惨烈之夜：<b>第 ${fun.worst.night} 夜</b>（${fun.worst.names.length} 人阵亡）</div>`;
    html += `</div>`;
  }
  html += `<div class="panel-desc">本局身份公开：</div>`;
  html += `<div class="end-roles">` + (e.roles || []).map(r =>
    `<div class="player ${r.alive ? '' : 'dead'}"><div class="phead"><div class="avatar ${r.alive ? '' : 'dead'}">${avatarOf(r)}</div><div class="pmeta"><div class="pname">${escapeHtml(r.name)}${r.alive ? '' : ' 💀'}</div><div class="prole ${campClass(r.camp)}-role">${ROLE_EMOJI_TEXT[r.role] || ''} ${escapeHtml(r.role)}</div><div class="pdead"><span class="camp-tag ${campClass(r.camp)}">${escapeHtml(r.camp)}</span></div></div></div></div>`
  ).join('') + `</div>`;
  if (view.canRematch) html += `<div class="btn-row"><button id="btn-rematch" class="primary" onpointerdown="act('rematch')">再来一局</button></div>`; // 脉冲（27）
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
      if (m.marker === '系统') {
        // 系统消息图标化（21）：按内容匹配图标
        const t = m.text || '';
        const icon = (t.indexOf('狼') >= 0 || t.indexOf('刀') >= 0 || t.indexOf('杀') >= 0) ? '🐺'
          : t.indexOf('枪') >= 0 ? '🔫' : t.indexOf('毒') >= 0 ? '🧪' : t.indexOf('放逐') >= 0 ? '⚖️'
          : t.indexOf('警') >= 0 ? '👮' : t.indexOf('盗') >= 0 ? '🃏' : t.indexOf('殉情') >= 0 ? '💔'
          : (t.indexOf('情侣') >= 0 || t.indexOf('丘比特') >= 0 || t.indexOf('魅') >= 0) ? '💘' : '🛎️';
        return `<div class="chat-sys">${icon} ${escapeHtml(m.text)}</div>`;
      }
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
      // B3：不拼 onclick 字符串——JSON.stringify 产出合法 JS 字符串字面量 + escapeHtml 防属性逃逸，玩家名/发言含恶意字符也安全
      qp.innerHTML = phrases.map(p => `<button onclick="quickPhrase(${escapeHtml(JSON.stringify(p))})">${escapeHtml(p)}</button>`).join('');
    } else qp.classList.add('hidden');
  }
}

/* ---------------------------- 交互辅助 ---------------------------- */
function alivePlayers() { return view.players.filter(p => p.alive); }
function playerOf(id) { return view.players.find(p => p.id === id); }

// 玩家卡片点击 → 选择目标（各面板根据 phase/step 决定用途）；再点已选者取消（8）
document.addEventListener('click', e => {
  if (e.target.closest('button')) return; // 按钮（如心情表情/投票）不触发玩家卡选中
  const card = e.target.closest('.player');
  if (!card) return;
  const id = card.dataset.id;
  if (pickPlayerHotkey(id)) card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // 移动端横向滚动卡片也能滚入视口（34）
});
/* 选人逻辑统一入口（卡片点击与快捷键 1~9 共用）：返回是否成功选中 */
function pickPlayerHotkey(id) {
  const p = playerOf(id);
  if (!p || !p.alive || !view) return false;
  const step = view.night && view.night.step;
  if (view.phase === 'vote' || view.phase === 'pk_vote' || view.phase === 'sheriff_vote') {
    const v = view.vote || view.sheriffVote || {};
    if (v.myVoted) return false; // 已投票不允许再改选（15）
    // PK 投票只能投给平票玩家（与服务端校验一致）
    if (view.phase === 'pk_vote' && view.vote && view.vote.pkTied && !view.vote.pkTied.some(t => t.id === id)) return false;
    draft.target = (draft.target === id ? null : id); renderPanel(); renderPlayers();
    return true;
  } else if (view.phase === 'night') {
    if (step === 'guard' && view.my.roleKey === 'guard') { draft.target = draft.target === id ? null : id; renderPanel(); renderPlayers(); return true; }
    else if (step === 'dreamer' && view.my.roleKey === 'dreamer') { draft.target = draft.target === id ? null : id; renderPanel(); renderPlayers(); return true; }
    else if (step === 'seer' && view.my.roleKey === 'seer') { draft.target = draft.target === id ? null : id; renderPanel(); renderPlayers(); return true; }
    else if (step === 'cupid' && view.my.roleKey === 'cupid') {
      // 点已选者取消；两人已满时点第三人替换 target2
      if (draft.target === id) draft.target = null;
      else if (draft.target2 === id) draft.target2 = null;
      else if (!draft.target) draft.target = id;
      else if (!draft.target2) draft.target2 = id;
      else draft.target2 = id;
      renderPanel(); renderPlayers();
      return true;
    }
    else if (step === 'hunter' && view.night.hunter && view.night.hunter.shooter === view.my.id) { draft.target = draft.target === id ? null : id; renderPanel(); renderPlayers(); return true; }
  } else if (view.phase === 'handover' && view.handover.from === view.my.id) {
    draft.target = draft.target === id ? null : id; renderPanel(); renderPlayers();
    return true;
  }
  return false;
}

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
  sfxTick(); // 投票确认滴答（33）
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

/* ---------------------------- 首页（v1.2.0） ---------------------------- */
/* 创建房间：成功后先展示“房间号大卡”庆祝 1.5s，再自动进入 */
async function createRoom() {
  if (!$('home') || $('home').classList.contains('hidden')) return; // 已进入房间，忽略重复触发
  const name = nickValue();
  $('home-err').textContent = '';
  const card = $('card-create');
  card.classList.add('busy'); // 忙碌态防连点（16）
  const r = await api('api/create', { name });
  card.classList.remove('busy');
  if (r.error || !r.roomId || !r.playerId) { $('home-err').textContent = r.error || '创建失败，请重试'; return; }
  localStorage.lwName = name;
  localStorage.lwRoom = r.roomId;
  try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(r.roomId); } catch (e) {}
  showCreatedOverlay(r.roomId, () => enterRoom(r.roomId, r.playerId, r.view));
}
/* 加入房间：房间号非法/不存在 → 输入框红框抖动 + 提示；joinBusy 防“满 6 位自动进入 + 回车”双触发 */
let joinBusy = false;
async function joinRoom() {
  if (joinBusy) return;
  if (!$('home') || $('home').classList.contains('hidden')) return; // 已进入房间，忽略重复触发
  joinBusy = true;
  const code = $('in-code').value.trim().toUpperCase();
  const name = nickValue();
  if (!/^[0-9A-Z]{6}$/.test(code)) { joinBusy = false; markCodeInvalid('房间号格式错误（6 位数字或字母）'); return; }
  $('home-err').textContent = '';
  const r = await api('api/join', { roomId: code, name });
  joinBusy = false;
  if (r.error || !r.playerId) { markCodeInvalid(r.error || '加入失败，请检查房间号'); $('home-err').textContent = r.error || '加入失败，请检查房间号'; return; }
  localStorage.lwName = name;
  localStorage.lwRoom = code;
  enterRoom(code, r.playerId, r.view);
  toast('🎉 已进入房间 ' + code);
}
/* 房号非法/房间不存在：红框 + 抖动（0.5s 后自动恢复，等待重新输入） */
function markCodeInvalid(msg) {
  const el = $('in-code');
  if (el) {
    el.classList.remove('valid');
    el.classList.add('invalid');
    setTimeout(() => el.classList.remove('invalid'), 500);
  }
  if (msg) toast(msg, 'err');
}
/* 创建成功“房间号大卡”（v1.2.0）：房号逐字弹出 + 复制按钮 + 进度条，1.5s 后自动入场 */
let createdTimer = null;
function showCreatedOverlay(code, then) {
  const ov = $('overlay-created');
  if (!ov) { then(); return; }
  $('cr-code').innerHTML = code.split('').map((c, i) => `<span class="cr-ch" style="animation-delay:${i * 80}ms">${c}</span>`).join('');
  const bar = $('cr-bar');
  if (bar) { bar.classList.remove('run'); void bar.offsetWidth; bar.classList.add('run'); } // 重启动画
  ov.classList.remove('hidden');
  clearTimeout(createdTimer);
  createdTimer = setTimeout(() => { ov.classList.add('hidden'); then(); }, 1500);
}
/* 在线统计（v1.2.0）：首页“🔥 当前 X 个房间正在开黑”；离开首页后不再请求 */
async function refreshStats() {
  if (!$('home') || $('home').classList.contains('hidden')) return;
  try {
    const res = await fetch('api/stats');
    const j = await res.json();
    if (!j || typeof j.rooms !== 'number') return;
    const el = $('stats-line');
    if (!el) return;
    const n = $('stats-rooms');
    if (n) n.textContent = j.rooms;
    el.classList.toggle('hidden', j.rooms <= 0);
    el.classList.toggle('hot', j.rooms > 0);
  } catch (e) { /* 统计失败静默，不影响主流程 */ }
}

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
  if (v.phase === 'reveal') return true; // S3：reveal 阶段房主可强制推进（随机代选/跳过全员确认），服务端 advance 已支持
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
  $('rp-desc').textContent = SKILL_TEXT[view.my.roleKey] || '（暂无技能说明）'; // B1：my 无 desc 字段，改用全局技能文案
  const card = pop.querySelector('.rp-card');
  card.className = 'rp-card ' + (ROLE_CAMP_TEXT[view.my.role] || '');
  pop.classList.remove('hidden');
}
function closeRolePop() { const pop = $('role-pop'); if (pop) pop.classList.add('hidden'); }
/* 职业技能文案（B1）：buildRulesList 与身份大卡弹窗共用，避免两处维护 */
const SKILL_TEXT = {
  villager: '无技能，靠发言找狼', seer: '每晚查验一人', witch: '一解药一毒药，可自救', hunter: '出局可开枪带人',
  dreamer: '每晚梦游一人', guard: '每晚守护一人，不能连守', wolf: '夜晚刀人', wolfBeauty: '被放逐带走魅惑者',
  cupid: '指定情侣', thief: '开局窃取一张身份牌',
};
/* 规则速览（14） */
function buildRulesList() {
  const el = $('rules-list'); if (!el) return;
  el.innerHTML = Object.keys(ROLE_NAMES).map(k =>
    `<div class="rules-item ${ROLE_CAMP[k] || ''}"><span class="ri-camp"></span><span>${ROLE_EMOJI[k] || ''} ${ROLE_NAMES[k]}：${SKILL_TEXT[k] || ''}</span></div>`
  ).join('');
  const rv = $('rules-view'); if (rv) rv.classList.remove('hidden');
}
/* ============ Visual v4 辅助 ============ */
/* 减少动效开关（31）：localStorage ww_less_motion；同时作用于 CSS（body.less-motion）与 JS 动画 */
function lessMotion() { return document.body.classList.contains('less-motion'); }
function toggleLessMotion(on) {
  document.body.classList.toggle('less-motion', !!on);
  try { localStorage.ww_less_motion = on ? '1' : '0'; } catch (e) {}
}
/* 轮到我选人时的动作图标（8）：决定玩家区扫光与选中卡图标 */
function pickIconFor() {
  const v = view; if (!v || !v.my || !v.my.alive) return '';
  if (v.phase === 'vote' || v.phase === 'pk_vote' || v.phase === 'sheriff_vote') {
    const vv = v.vote || v.sheriffVote || {};
    if (vv.myVoted) return ''; // 已投票不再引导选人（15）
    return '🗳️';
  }
  if (v.phase === 'handover' && v.handover && v.handover.from === v.my.id) return '👮';
  if (v.phase === 'night') {
    const s = v.night && v.night.step;
    if (s === 'guard' && v.my.roleKey === 'guard') return '🛡️';
    if (s === 'dreamer' && v.my.roleKey === 'dreamer') return '😴';
    if (s === 'seer' && v.my.roleKey === 'seer') return '🔮';
    if (s === 'cupid' && v.my.roleKey === 'cupid') return '💘';
    if (s === 'hunter' && v.night.hunter && v.night.hunter.shooter === v.my.id) return '🔫';
  }
  return '';
}
/* 弱网横幅（29） */
function showNetBanner() { const b = $('net-banner'); if (b) b.classList.remove('hidden'); }
function hideNetBanner() { const b = $('net-banner'); if (b) b.classList.add('hidden'); }
/* 全局动效层（17/20 模板入口）：独立 DOM、动画完自毁（animationend 自删 + 2.6s 兜底防泄漏），
 * 不参与 view 重绘；减少动效开关或系统 prefers-reduced-motion 时直接跳过。
 * 用法：spawnFx('💥', 'fx-boom', { left: x, top: y, '--fx': '...' }) */
function spawnFx(html, klass, styles) {
  if (lessMotion() || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return null;
  const el = document.createElement('div');
  el.className = 'fx ' + (klass || '');
  el.innerHTML = html;
  if (styles) for (const k in styles) {
    if (k === 'left' || k === 'top') el.style[k] = styles[k] + 'px';
    else el.style.setProperty(k, styles[k]);
  }
  document.body.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  return el;
}

/* ============ v1.3.0 提升组 ============ */
/* 移动端震动（v1.3.0）：轮到我短震 / 死亡长震 / 被踢两段震；减少动效时静默 */
const vibrate = ms => { try { if (navigator.vibrate && !lessMotion()) navigator.vibrate(ms); } catch (e) {} };

/* 行动反馈动画（v1.3.0）：行动成功后目标卡闪现职业图标——“我的行动有回应” */
const FX_ACTION_MAP = {
  seer_pick: { icon: '🔮', klass: 'fx-seer', ids: d => [d.target] },
  guard_pick: { icon: '🛡️', klass: 'fx-shield', ids: d => [d.target] },
  dreamer_pick: { icon: '😴', klass: 'fx-dream', ids: d => [d.target] },
  cupid_pick: { icon: '💘', klass: 'fx-heart', ids: d => d.ids || [] },
  witch_act: {
    icon: '💊', klass: 'fx-heal', ids: d => {
      if (d.save && view && view.night && view.night.witch && view.night.witch.victim) return [view.night.witch.victim]; // 解药飞向被袭者
      if (d.poison) return [d.poison];
      return [];
    },
  },
  wolf_set: {
    icon: '🔪', klass: 'fx-blade', ids: d => {
      const ids = [];
      if (d.kill !== undefined && d.kill !== null) ids.push(d.kill);
      if (d.charm !== undefined && d.charm !== null) fxTarget(d.charm, '💘', 'fx-heart'); // 狼美人魅惑单独红心
      return ids;
    },
  },
  hunter_shoot: { icon: '🔫', klass: 'fx-shot', ids: d => d.target ? [d.target] : [] },
};
function fxForAction(action, data) {
  const fx = FX_ACTION_MAP[action];
  if (!fx) return;
  for (const id of fx.ids(data)) fxTarget(id, fx.icon, fx.klass);
}
function fxTarget(id, icon, klass) {
  const el = document.querySelector(`.player[data-id="${id}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  spawnFx(icon, klass, { left: r.left + r.width / 2 - 20, top: r.top + r.height / 2 - 20 });
}

/* 赛后趣味统计（v1.3.0）：整局本地累积，不依赖服务端新增数据 */
const stat = { deaths: [], chat: {}, firstNight: null };
const statSeen = {};      // 死亡记录去重：night:m / night:d
const statMsgIds = new Set(); // 聊天按消息 id 去重（增量下发可能重叠）
function collectStats(v) {
  if (!v) return;
  // 夜晚死亡（morning 阶段下发）
  if (v.phase === 'morning' && v.morningDeaths && v.morningDeaths.length) {
    const key = v.nightNum + ':m';
    if (!statSeen[key]) {
      statSeen[key] = true;
      stat.deaths.push({ night: v.nightNum, names: v.morningDeaths.map(d => d.name) });
      if (v.nightNum === 1 && !stat.firstNight) stat.firstNight = v.morningDeaths[0].name;
    }
  }
  // 放逐死亡（dayDeaths）：并入同夜记录
  if (v.dayDeaths && v.dayDeaths.length) {
    const key = v.nightNum + ':d';
    if (!statSeen[key]) {
      statSeen[key] = true;
      const last = stat.deaths[stat.deaths.length - 1];
      if (last && last.night === v.nightNum) last.names = last.names.concat(v.dayDeaths.map(d => d.name));
      else stat.deaths.push({ night: v.nightNum, names: v.dayDeaths.map(d => d.name) });
    }
  }
  // 发言数：只统计全体频道真人消息（私聊不算“话痨”）
  if (Array.isArray(v.chat)) {
    for (const m of v.chat) {
      if (!m || !m.id || m.marker === '系统' || m.ch !== 'all' || !m.from || statMsgIds.has(m.id)) continue;
      statMsgIds.add(m.id);
      stat.chat[m.from] = (stat.chat[m.from] || 0) + 1;
    }
  }
}
function resetStats() {
  stat.deaths.length = 0; stat.chat = {}; stat.firstNight = null;
  for (const k in statSeen) delete statSeen[k];
  statMsgIds.clear();
}
function statStats() {
  let talker = null, talkerN = 0;
  for (const id in stat.chat) if (stat.chat[id] > talkerN) { talkerN = stat.chat[id]; talker = id; }
  let worst = null;
  for (const d of stat.deaths) if (d.names.length > (worst ? worst.names.length : 0)) worst = d;
  if (!talker && !stat.firstNight && !worst) return null;
  return { talker: talker ? nameOf(talker) : null, talkerN, first: stat.firstNight, worst };
}

/* 环境粒子（v1.3.0）：夜晚流星、白天阳光粒子，低频随机触发（减少动效时 spawnFx 内部跳过） */
function ambientFx() {
  if (!view || view.phase === 'lobby' || view.phase === 'reveal' || view.phase === 'ended') return;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (view.phase === 'night') {
    spawnFx('☄️', 'fx-meteor', { left: vw * (0.5 + Math.random() * 0.45), top: vh * (0.05 + Math.random() * 0.25), '--fx': `translate(${-vw * 0.45}px, ${vh * 0.32}px)` });
  } else {
    spawnFx('✨', 'fx-sun', { left: vw * (0.1 + Math.random() * 0.8), top: vh * 0.7, '--fx': `translate(0, ${-vh * 0.35}px)` });
  }
}

/* 字号调节（v1.3.0）：整页缩放三档，localStorage 记住（A-/A/A+） */
function setFontScale(k) {
  const scale = [0.9, 1, 1.12][k] || 1;
  document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
  try { localStorage.ww_font = String(k); } catch (e) {}
}

/* 邀请链接（v1.3.0）：origin + ?room=，复制/原生分享 */
function inviteUrl() { return location.origin + location.pathname + '?room=' + ((view && view.roomId) || localStorage.lwRoom || ''); }
function copyInvite() {
  const url = inviteUrl();
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('🔗 邀请链接已复制'));
  else toast('邀请链接：' + url);
}
function shareInvite() {
  const url = inviteUrl();
  if (navigator.share) navigator.share({ title: '狼人杀房间', text: '来和我玩一局狼人杀！', url }).catch(() => {});
  else copyInvite();
}
/* 警徽飞行（13）：fixed 徽章从旧警长卡飞到新警长卡（走 spawnFx 动效层样板） */
function flySheriffBadge(fromId, toId) {
  const from = document.querySelector(`.player[data-id="${fromId}"]`);
  const to = document.querySelector(`.player[data-id="${toId}"]`);
  if (!from || !to) { toast('👮 警徽已移交', 'sys'); return; }
  const fr = from.getBoundingClientRect(), tr = to.getBoundingClientRect();
  spawnFx('👮', 'fx-badge-fly', {
    left: fr.left + fr.width / 2 - 14,
    top: fr.top + fr.height / 2 - 14,
    '--fx': `translate(${tr.left - fr.left}px, ${tr.top - fr.top}px)`,
  });
  toast('👮 警徽已移交', 'sys');
}
/* 新警长当选落位（16）：警徽弹入动画 */
function sheriffPop(id) {
  const mark = document.querySelector(`.player[data-id="${id}"] .sheriff-mark`);
  if (mark && mark.animate && !lessMotion()) mark.animate(
    [{ transform: 'scale(0)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }],
    { duration: 480, easing: 'ease-out' }
  );
}
/* 快捷键（30）：数字 1~9 选座位号玩家，Enter 确认（仅选择阶段；输入框聚焦/触屏忽略） */
function hotkeyConfirmPhase() {
  const v = view; if (!v || !v.my || !v.my.alive) return false;
  if (v.phase === 'reveal') return true;
  if (['vote', 'pk_vote', 'sheriff_vote', 'handover', 'hunter_shot'].includes(v.phase)) return true;
  if (v.phase === 'night') {
    const s = v.night && v.night.step;
    return ['guard', 'dreamer', 'seer', 'cupid'].includes(s) && needsFastPoll(); // 仅无歧义的单选步骤
  }
  return false;
}
document.addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!view || !view.my || !view.my.alive) return;
  if (window.matchMedia('(pointer: coarse)').matches) return; // 触屏设备忽略快捷键
  // 数字键选座位：1~9 = 1~9 号位，0 = 10 号位；11~18 号位暂不覆盖（>10 人局罕见，且鼠标/触屏仍可用，S2）
  let n = parseInt(e.key, 10);
  if (e.key === '0') n = 10;
  if (n >= 1 && n <= 10) {
    const p = view.players.find(x => x.seat === n && x.alive);
    if (p) {
      pickPlayerHotkey(p.id);
      const card = document.querySelector(`.player[data-id="${p.id}"]`);
      if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return;
  }
  if (e.key === 'Enter' && hotkeyConfirmPhase()) {
    const btn = document.querySelector('#panel .btn-row .primary:not([disabled])');
    if (btn) { btn.click(); e.preventDefault(); }
  }
});
/* 操作防连点（28）：提交类按钮 650ms 防连点（服务端已有幂等，此为体验层防护）。
 * 关键：onpointerdown 按钮在 pointerdown 阶段锁定；onclick 按钮必须在 click 阶段锁定——
 * 若在 pointerdown 就 disable，浏览器会吞掉随后的 click 事件（表现为“点了没反应”，曾导致添加人机按钮失效）。 */
const SUBMIT_HANDLER_RE = /\b(act\(|doAdvance\(|hostPick\(|doThiefPick\(|doCupidPick\(|doPick\(|doWolfConfirm\(|witchSave\(|witchPoison\(|hunterShoot\(|sendLastword\(|handoverPick\(|castVote\(|kick\()/;
function lockButton(b) {
  if (b.dataset.busyLock) return;
  b.dataset.busyLock = '1';
  const orig = b.disabled;
  b.disabled = true;
  setTimeout(() => { if (b.isConnected) b.disabled = orig; delete b.dataset.busyLock; }, 650);
}
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('button[onpointerdown]');
  if (!b || b.disabled || b.hasAttribute('onclick')) return;
  if (!SUBMIT_HANDLER_RE.test(b.getAttribute('onpointerdown') || '')) return;
  lockButton(b);
}, true);
document.addEventListener('click', e => {
  const b = e.target.closest('button[onclick]');
  if (!b || b.disabled || b.hasAttribute('onpointerdown')) return;
  if (!SUBMIT_HANDLER_RE.test(b.getAttribute('onclick') || '')) return;
  lockButton(b); // 捕获阶段禁用：click 仍在派发中，目标阶段 onclick 照常执行，同时挡住连点
}, true);
/* 音效（33）：Web Audio 零依赖合成，localStorage ww_sfx 静音开关 */
function ensureAudio() { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC && AC.state === 'suspended') AC.resume(); } catch (e) {} }
function sfxOk() { return sfxOn && AC && AC.state === 'running'; }
function tone(freq, dur, type, vol, when, slideTo) {
  if (!sfxOk()) return;
  const t = AC.currentTime + (when || 0);
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(AC.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
function noiseBurst(dur, vol, cutoff, when) {
  if (!sfxOk()) return;
  const t = AC.currentTime + (when || 0);
  const len = Math.max(1, Math.floor(AC.sampleRate * dur));
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = AC.createBufferSource(); src.buffer = buf;
  const f = AC.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = cutoff; f.Q.value = 0.8;
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(AC.destination);
  src.start(t);
}
function sfxWolf() { ensureAudio(); tone(150, 1.0, 'sawtooth', 0.16, 0, 65); tone(152, 1.0, 'sawtooth', 0.10, 0.16, 68); } // 狼嚎：低音扫频
function sfxMorning() { ensureAudio(); [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.9, 'sine', 0.08, i * 0.12)); } // 天亮：高音和弦
function sfxTick() { ensureAudio(); tone(1250, 0.06, 'square', 0.06, 0, 700); } // 投票确认：滴答
function sfxHeavy() { ensureAudio(); tone(130, 0.5, 'sine', 0.28, 0, 55); noiseBurst(0.24, 0.15, 520, 0); } // 放逐/死亡：重击
function sfxFlip() { ensureAudio(); noiseBurst(0.14, 0.12, 2400, 0); } // 翻牌：纸张沙沙
function sfxEnter() { tone(660, .12, 'sine', .05, 0); tone(990, .16, 'sine', .05, .09); } // 入场：两声轻铃（v1.2.0）
function init() {
  // 记住昵称 + 上次房间（12/13）；无昵称首访自动生成趣味昵称（v1.2.0）
  const savedName = localStorage.lwName;
  if (savedName) $('in-name').value = savedName;
  else fillNick();
  buildRulesList();
  const lastRoom = localStorage.lwRoom;
  if (lastRoom) {
    const lr = $('last-room'); if (lr) lr.classList.remove('hidden');
    const b = $('btn-last-room'); if (b) b.textContent = '🚪 上次房间 ' + lastRoom + ' · 重新进入';
  }
  const elLR = $('btn-last-room'); if (elLR) elLR.addEventListener('click', async () => {
    const code = localStorage.lwRoom; if (!code) return;
    const name = nickValue();
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
  // 首页（v1.2.0 双卡入口：整卡可点，加入卡输入框常显）
  $('card-create').addEventListener('click', createRoom);
  $('card-create').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); createRoom(); } }); // 键盘可达性
  $('btn-nick-shuffle').addEventListener('click', e => {
    e.stopPropagation();
    fillNick();
    $('in-name').focus();
    $('in-name').select();
  });
  $('card-join').addEventListener('click', e => {
    // 点卡片空白处聚焦输入框；输入框/按钮自身点击不拦截
    if (e.target.closest('input') || e.target.closest('button')) return;
    $('in-code').focus();
  });
  $('btn-join-go').addEventListener('click', joinRoom);
  const ccp = $('btn-copy-code');
  if (ccp) ccp.addEventListener('click', copyInvite); // v1.3.0：创建大卡复制邀请链接（原复制房号）
  $('btn-copy').addEventListener('click', copyInvite); // v1.3.0：顶栏复制邀请链接
  const bsh = $('btn-share');
  if (bsh) bsh.addEventListener('click', shareInvite); // v1.3.0：移动端原生分享面板
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
  // 房号点击即复制（9）→ v1.3.0：复制邀请链接
  $('room-code').addEventListener('click', copyInvite);
  // 身份芯片点击 → 大卡弹窗（8）
  const elChip = $('my-role-chip'); if (elChip) elChip.addEventListener('click', openRolePop);
  const elPop = $('role-pop'); if (elPop) elPop.addEventListener('click', closeRolePop);
  // 移动端聊天抽屉（2）
  const bco = $('btn-chat-open');
  if (bco) bco.classList.remove('hidden');
  if (bco) bco.addEventListener('click', e => { e.stopPropagation(); document.body.classList.toggle('chat-open'); });
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
  // 房间号实时校验（v1.2.0）：输入即转大写；6 位合法金色高亮并自动进入；含非法字符红框反馈
  $('in-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('in-code').addEventListener('input', () => {
    const el = $('in-code');
    const v = el.value.trim().toUpperCase();
    el.value = v;
    el.classList.remove('valid');
    if (v.length === 6 && /^[0-9A-Z]{6}$/.test(v)) { el.classList.add('valid'); $('btn-join-go').click(); } // 6 位自动进入（15）
    else if (v && !/^[0-9A-Z]*$/.test(v)) el.classList.add('invalid');
    else el.classList.remove('invalid');
  });
  $('in-name').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });

  // 字号（v1.3.0）：恢复上次选择
  try { const fk = parseInt(localStorage.ww_font, 10); if (!isNaN(fk)) setFontScale(fk); } catch (e) {}
  // 邀请链接直达（v1.3.0）：?room=XXXXXX → 自动填入并高亮加入卡（不自动进入，避免误入他人房间）
  try {
    const qr = new URLSearchParams(location.search).get('room');
    if (qr && /^[0-9A-Z]{6}$/.test(qr)) {
      const el = $('in-code');
      el.value = qr;
      el.classList.add('valid');
      toast('🔗 已带入邀请链接的房间号，点击「进入」即可');
    }
  } catch (e) {}
  // PWA（v1.3.0）：注册 Service Worker（网络优先，弱网回退缓存；API 永不缓存）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
  // 环境粒子（v1.3.0）：夜晚流星 / 白天阳光粒子，低频随机触发
  setInterval(() => { try { ambientFx(); } catch (e) {} }, 28000);

  // 音效开关（33）：顶栏 🔊/🔇；首次交互后创建 AudioContext（浏览器自动播放策略）
  const sb = $('btn-sound');
  if (sb) {
    try { sfxOn = localStorage.ww_sfx !== '0'; } catch (e) {}
    sb.textContent = sfxOn ? '🔊' : '🔇';
    sb.addEventListener('click', () => {
      sfxOn = !sfxOn;
      sb.textContent = sfxOn ? '🔊' : '🔇';
      try { localStorage.ww_sfx = sfxOn ? '1' : '0'; } catch (e) {}
      if (sfxOn) { ensureAudio(); sfxTick(); }
    });
  }
  document.addEventListener('pointerdown', () => {
    ensureAudio();
    // 入场音效（v1.2.0）：首次交互轻铃；AudioContext 首次 resume 是异步的，等它就绪再播
    if (AC && AC.state !== 'running') AC.resume().then(() => sfxEnter()).catch(() => {});
    else sfxEnter();
  }, { once: true, capture: true });
  // 减少动效开关（31）
  const lm = $('in-less-motion');
  if (lm) {
    lm.checked = localStorage.ww_less_motion === '1';
    document.body.classList.toggle('less-motion', lm.checked);
    lm.addEventListener('change', () => toggleLessMotion(lm.checked));
  }

  // 在线统计（v1.2.0）：首页“🔥 正在开黑”，30 秒刷新，失败静默
  refreshStats();
  setInterval(refreshStats, 30000);

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
  lastInfoHtml = null; // 信息区缓存基准重置（12）
  prevSheriff = null;  // 警长飞行基准重置（13）
  prevFocusPhase = null;
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
  connectSSE(); // SSE 推送唤醒（失败自动回退轮询）
}
init();
