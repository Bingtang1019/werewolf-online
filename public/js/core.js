// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

'use strict'
const musicState = {
    list: [],
    reviews: [
    ],
    idx: -1, playing: false, vol: 40, prog: 0, timer: null, audio: null, mode: 0, srvMusic: null // v1.7.30（服务端进度）：服务端音乐状态（进度条/对齐用）
  };
;
/* =========================================================================
 * 狼人杀 网页客户端
 * 通过轮询 /api/state 获取状态，POST /api/action 发送操作
 * ========================================================================= */

const $ = id => document.getElementById(id);
let view = null;
let roomId = null;
let me = null, token = null; // 安全加固（C1/C2/C3）：me=玩家id（视图归属判断），token=会话凭证（只发服务端）
let pollTimer = null;
let pollMs = 0;
let pollBusy = false; // 轮询在途标记：慢网络下跳过重叠轮询，防止增量叠加
let sse = null;            // EventSource（SSE 推送唤醒）
let sseConnected = false;  // SSE 当前是否可用
let sseFails = 0;          // SSE 连续失败次数（v1.5.4）
let sseDisabled = false;   // SSE 降级开关（v1.5.4：快速隧道对长连接不友好时转纯轮询）
const SSE_HEARTBEAT_MS = 30000; // SSE 可用时的心跳轮询间隔（30 秒）
let draft = {};       // 当前面板的草稿选择 { target, target2, kill, charm }
let botLevelChoice = 'easy'; // v1.4.0：添加人机时的级别选择（idle/easy/smart/simulate）
let lastPhaseKey = null; // 上次渲染的阶段标识（变化时清空草稿）
let chatTab = 'all';
let lastChatCount = -1;
let lastChatTab = null; // 上次渲染的频道（防两频道消息数恰好相同时切 tab 不重绘）
const lastTabTs = {}; // 各频道最后已读消息时间戳（红点）
let toastTimer = null;

/* ---------------------------- 工具 ---------------------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Cloudflare 快速通道模式（独立开关：auto/on/off） */
function cfTunnelMode() {
  try { const m = localStorage.lwCfTunnel; if (m === 'on' || m === 'off') return m; } catch (e) {}
  return 'auto';
}
function isCfTunnel() {
  const mode = cfTunnelMode();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  const hn = (location.hostname || '').toLowerCase();
  return hn === 'trycloudflare.com' || hn.endsWith('.trycloudflare.com');
}
function setCfTunnelMode(mode) {
  if (mode !== 'auto' && mode !== 'on' && mode !== 'off') mode = 'auto';
  try { localStorage.lwCfTunnel = mode; } catch (e) {}
  renderCfModeButtons();
  // 切换后立即重置传输状态：SSE 连接按新模式重来，轮询间隔重新计算
  try { if (window.sse) { window.sse.close(); window.sse = null; } } catch (e) {}
  window.sseConnected = false;
  window.sseFails = 0;
  window.sseDisabled = false;
  if (window.connectSSE) window.connectSSE();
  if (window.ensurePollTimer) window.ensurePollTimer();
  toast('🚇 快速通道模式：' + ({ auto: '自动', on: '开启', off: '关闭' }[mode] || mode));
}
function cycleCfTunnelMode() {
  const order = ['auto', 'on', 'off'];
  const cur = cfTunnelMode();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setCfTunnelMode(next);
}
function renderCfModeButtons() {
  const mode = cfTunnelMode();
  const label = { auto: '自动', on: '开启', off: '关闭' }[mode] || mode;
  document.querySelectorAll('.js-cf-mode-btn').forEach(b => {
    b.textContent = b.id && b.id.indexOf('room') !== -1 ? ('🚇 ' + label) : ('🚇 隧道:' + label);
  });
}

/* 主题与个性化（F）：月夜 / 暗红 / 森林 / 晨曦，本地持久化 */
const THEME_LIST = [
  { id: 'moon', name: '月夜', icon: '🌙' },
  { id: 'ember', name: '暗红', icon: '🔥' },
  { id: 'forest', name: '森林', icon: '🌲' },
  { id: 'dawn', name: '晨曦', icon: '🌅' },
  { id: 'rose', name: '玫瑰', icon: '🌹' },
  { id: 'gold', name: '黄金', icon: '⭐' },
];
function themeName(id) {
  const t = THEME_LIST.find(x => x.id === id);
  return t ? t.name : '月夜';
}
function themeIcon(id) {
  const t = THEME_LIST.find(x => x.id === id);
  return t ? t.icon : '🌙';
}
function currentTheme() {
  try { const t = localStorage.lwTheme; if (THEME_LIST.some(x => x.id === t)) return t; } catch (e) {}
  return 'moon';
}
function applyUserTheme(id) {
  if (!THEME_LIST.some(x => x.id === id)) id = 'moon';
  document.body.classList.remove('theme-moon', 'theme-ember', 'theme-forest', 'theme-dawn', 'theme-rose', 'theme-gold');
  document.body.classList.add('theme-' + id);
  try { localStorage.lwTheme = id; } catch (e) {}
  renderUserThemeButtons();
  renderThemeChips();
}
function cycleUserTheme() {
  const order = THEME_LIST.map(t => t.id);
  const cur = currentTheme();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  applyUserTheme(next);
  toast('🎨 主题：' + themeName(next));
}
function renderUserThemeButtons() {
  const id = currentTheme();
  const name = themeName(id), icon = themeIcon(id);
  document.querySelectorAll('.js-theme-btn').forEach(b => {
    if (b.id && b.id.indexOf('room') !== -1) b.textContent = icon;
    else b.textContent = icon + ' ' + name;
  });
}
function renderThemeChips() {
  const el = $('theme-chips');
  if (!el) return;
  const cur = currentTheme();
  el.innerHTML = THEME_LIST.map(t =>
    `<button class="theme-chip ${cur === t.id ? 'active' : ''}" data-theme="${t.id}" title="${t.name}">${t.icon} ${t.name}</button>`
  ).join('');
}
function applyCustomAccent() {
  try {
    const v = localStorage.lwAccent;
    if (v && /^#[0-9a-fA-F]{6}$/.test(v)) document.body.style.setProperty('--accent', v);
  } catch (e) {}
}
function setCustomAccent(v) {
  if (!v || !/^#[0-9a-fA-F]{6}$/.test(v)) return;
  document.body.style.setProperty('--accent', v);
  try { localStorage.lwAccent = v; } catch (e) {}
}

/* 复制文本到剪贴板（A：聊天消息复制等通用入口） */
function copyText(text, tip) {
  const done = () => toast(tip || '已复制', 'success');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败', 'error'); }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else fallback();
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

function saveSession() { try { localStorage.setItem('ww_session', JSON.stringify({ room: roomId, me, token })); } catch (e) {} }

function loadSession() { try { return JSON.parse(localStorage.getItem('ww_session')); } catch (e) { return null; } }

function clearSession() { try { localStorage.removeItem('ww_session'); } catch (e) {} }

// v1.7.24（设备校验）：设备指纹持久化——刷新后 token 失效时服务端按 deviceId 认领旧位（消灭刷新分身）

function deviceId() {
  try {
    let d = localStorage.getItem('ww_device');
    if (!d) {
      d = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('ww_device', d);
    }
    return d;
  } catch (e) { return ''; }
}

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
/* 夜晚步骤文案（v1.6.2：从 renderNight 局部提升为模块级，TTS 播报 / 后台通知 / 面板标题共用同一套，避免散落三处不一致） */
const stepText = {
  thief: '盗贼请睁眼', cupid: '丘比特请睁眼', lovers: '情侣请睁眼确认彼此',
  guard: '守卫请睁眼', dreamer: '摄梦人请睁眼', wolf: '狼人请睁眼', seer: '预言家请睁眼',
  witch: '女巫请睁眼', hunter: '猎人请睁眼',
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
// 职业专属光晕色（中文名→色值；--rc 用于身份卡/死亡卡/睁眼提示）
const ROLE_GLOW_TEXT = { '平民': '#7fd4a8', '预言家': '#5aa2ff', '女巫': '#b06af0', '猎人': '#ff8c5a', '摄梦人': '#6ad8d0', '守卫': '#ffd166', '狼人': '#ff6b6b', '狼美人': '#ff7bac', '丘比特': '#ff8fd8', '盗贼': '#ffd76a' };
/* 1.8.1 SVG 职业图标体系（G）：线性风格，随主题 currentColor 着色 */
const ROLE_SVG = {
  villager: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9h14v-9"/><path d="M10 19v-5h4v5"/></svg>',
  seer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2"/></svg>',
  witch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3h4M11 3v5l-4 9a3 3 0 0 0 2.7 4h4.6a3 3 0 0 0 2.7-4l-4-9V3"/><path d="M8 14h8"/></svg>',
  hunter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
  dreamer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/><path d="M13 12h3l-2 3h3"/></svg>',
  guard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  wolf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l3 3c1-1.5 3-2 5-2s4 .5 5 2l3-3"/><path d="M5 10c0 5 3 8 7 8s7-3 7-8c0-2-1-3-2-4"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/><path d="M12 13v3"/></svg>',
  wolfBeauty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-6-4-8-8a4 4 0 0 1 7-3 4 4 0 0 1 7 3c-2 4-6 8-6 8z"/><path d="M12 9v5"/></svg>',
  cupid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20s-6-4-8-8a4 4 0 0 1 7-3 4 4 0 0 1 7 3c-2 4-6 8-6 8z"/><path d="M4 4l8 8M10 4h4v4"/></svg>',
  thief: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
};
const ROLE_SVG_TEXT = {};
for (const k of Object.keys(ROLE_NAMES)) ROLE_SVG_TEXT[ROLE_NAMES[k]] = ROLE_SVG[k];
function roleIconHtml(role) {
  const svg = ROLE_SVG_TEXT[role] || ROLE_SVG[role] || '';
  return svg ? `<span class="role-ico">${svg}</span>` : '';
}
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
let ttsOn = false;          // 上帝配音开关（v1.6.0，localStorage ww_tts）
let notifyAsked = false;    // 通知权限是否已请求过（v1.6.0）
let AC = null;             // Web Audio 上下文（首次用户交互后创建）
let sfxOn = true;          // 音效总开关（localStorage ww_sfx）
const sfxFlags = { wolf: true, morning: true, tick: true, heavy: true, flip: true, enter: true }; // v1.6.3：分项开关（localStorage ww_sfx_flags）

/* ---------------------------- API ---------------------------- */
/* v1.6.4（A1-P1-1）：幂等/可重复操作清单——网络失败自动重试（沿用同一 opId，服务端去重防双执行）；
 * 非幂等（createRoom/joinRoom/kick/leave）不重试。 */
const IDEMPOTENT_ACTIONS = ['vote', 'wolf_set', 'guard_pick', 'dreamer_pick', 'seer_pick', 'witch_act', 'cupid_pick', 'confirm', 'handover', 'post', 'mood'];

function genOpId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); // 非安全上下文（http://局域网IP）回退
}

async function api(path, body) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await res.json();
  } catch (e) {
    return { error: '无法连接服务器：请确认已运行 node server.js，并通过 http://localhost:3000 访问', netFail: true }; // v1.6.4：netFail 供幂等重试区分网络失败与业务失败
  }
}
async function act(action, data) {
  const payload = { room: roomId, token, action, data: data || {}, chatSince: lastChatTs() };
  if (IDEMPOTENT_ACTIONS.includes(action)) payload.opId = genOpId(); // v1.6.4（A1-P1-1）：幂等操作带 opId，网络失败自动重试（同 opId 服务端去重）
  let r = await api('api/action', payload);
  for (let i = 0; i < 2 && r && r.netFail; i++) { // 最多重试 2 次（间隔 500ms）——隧道 50% 失败率下“点不动”体感显著改善
    await new Promise(res => setTimeout(res, 500));
    r = await api('api/action', payload);
  }
  if (r.error) { toast(r.error); return null; }
  if (r.left) { clearSession(); location.reload(); return null; }
  fxForAction(action, data || {}); // v1.3.0：行动成功 → 目标卡反馈动画
  applyView(r.view);
  resetPollTimer();
  render();
  return view;
}
async function chatSend(ch, text) {
  const payload = { room: roomId, token, data: { ch, text }, chatSince: lastChatTs(), opId: genOpId() }; // v1.6.4（A1-P1-1）：聊天重试靠 opId 防“一句话说两遍”
  let r = await api('api/chat', payload);
  for (let i = 0; i < 2 && r && r.netFail; i++) {
    await new Promise(res => setTimeout(res, 500));
    r = await api('api/chat', payload);
  }
  if (r.error) { toast(r.error); return; }
  applyView(r.view);
  resetPollTimer();
  render();
}
async function doAdvance() {
  const r = await api('api/advance', { room: roomId, token, chatSince: lastChatTs() });
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

/* 重置轮询计时器（API 提交成功后调用，避免紧邻的旧请求干扰） */

/* 自适应轮询间隔：需要我操作时快（700ms），否则慢（1600ms），大幅降低隧道带宽占用 */

/* 判断当前是否轮到我操作（决定轮询快慢） */

async function poll() {
  if (!roomId || !token) return;
  if (pollBusy) return; // 上一轮轮询尚未返回：跳过本次（避免慢网络下请求堆积、增量重叠）
  pollBusy = true;
  try {
    const ver = view ? view.v : -1;
    const cf = isCfTunnel();
    const res = await fetch(`api/state?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&v=${ver}&since=${lastChatTs()}&cf=${cf ? 1 : 0}`, cf ? { cache: 'no-store' } : undefined);
    const j = await res.json();
    if (pollFail >= 2) toast('📶 连接已恢复'); // 弱网恢复提示（H）
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

/* ============ SSE 推送唤醒（可选优化，失败自动回退轮询） ============ */

/* ---------------------------- 状态变化提示 ---------------------------- */
/* 夜晚/天亮过渡遮罩（#overlay-night） */
let overlayTimer = null;

/* ---------------------------- 渲染主入口 ---------------------------- */
let editingSnapshot = null;
/* 渲染前快照正在编辑的输入框（遗言框/聊天框等），渲染后恢复内容与光标，避免重绘打断输入 */

/* 昼夜主题切换（ToS/狼人杀APP经典氛围）：仅切换 CSS 变量，重绘安全 */

/* ---------------------------- 玩家列表 ---------------------------- */

/* ---------------------------- 信息区（公告/计票） ---------------------------- */

/* 计票数字滚动（12）：0 → 最终票数，520ms 缓出；每个数字只跑一次 */

/* ---------------------------- 主面板 ---------------------------- */

/* ---------------- 大厅 ---------------- */

/* ---------------- 身份展示 ---------------- */

/* ---------------- 夜晚 ---------------- */

/* ---------------- 白天各阶段 ---------------- */

/* ---------------------------- 聊天 ---------------------------- */
/* 移动端聊天悬浮窗（v1.7.18）：底端隐藏露把手 + 上拉半屏/全屏——三档位移、
 * 拖拽跟手、松手吸附最近档位、隐藏时未读计数。桌面/横屏侧栏模式不受影响 */
const CHAT_HANDLE_H = 44; // 把手高度（与 style.css #chat-handle 同步）
const CHAT_DRAG_TOL = 8; // 拖动判定阈值（px）——超过才算拖拽（抑制后续 click）
let chatUnread = 0;
let chatDrag = null;
let chatSuppressClick = false; // 拖拽松手后抑制浏览器派发的 click（防二次 toggle）

 // 半屏高（px）

 // 隐藏位移（px）

 // 半屏位移

/* 聊天自动滚动（v1.7.18 强化）：nearBottom 智能滚（用户上翻不打断）/ force
 * （自己发消息）强制滚到底；rAF 延后一帧等布局稳定（emoji/内容渲染后
 * scrollHeight 才最终——同步滚会因高度未定而无效，这是"自动下拉消失"的诱因） */

/* ---------------------------- 交互辅助 ---------------------------- */

// 玩家卡片点击 → 选择目标（各面板根据 phase/step 决定用途）；再点已选者取消（8）
document.addEventListener('click', e => {
  if (e.target.closest('button')) return; // 按钮（如心情表情/投票）不触发玩家卡选中
  const card = e.target.closest('.player');
  if (!card) return;
  const id = card.dataset.id;
  if (pickPlayerHotkey(id)) { card.scrollIntoView({ block: 'nearest', inline: 'nearest' }); focusPrimaryAction(); } // 移动端横向滚动卡片也能滚入视口（34）
});
// 双击玩家卡：投票阶段直接投给他（快捷操作）
document.addEventListener('dblclick', e => {
  const card = e.target.closest('.player');
  if (!card || !view || !view.my || !view.my.alive) return;
  if (view.phase !== 'vote' && view.phase !== 'pk_vote' && view.phase !== 'sheriff_vote') return;
  const voteInfo = view.vote || view.sheriffVote || {};
  if (voteInfo.myVoted) return;
  draft.target = card.dataset.id;
  castVote();
});
/* 选人逻辑统一入口（卡片点击与快捷键 1~9 共用）：返回是否成功选中 */

/* ---------------------------- 大厅操作 ---------------------------- */
/* 人数滑条：拖动时仅本地更新显示（不发请求），松手才一次性提交 → 拖动顺滑不卡顿 */

/* ---------------------------- 首页（v1.2.0） ---------------------------- */
/* 离线模式（v1.4.1 → C3 增强）：先打开设置弹窗，再按选项建房 + 自动加满人机，单机陪练 */
function offlineDefaultCounts(cap) {
  const wolf = cap >= 14 ? 4 : cap >= 9 ? 3 : cap >= 5 ? 2 : 1;
  const witch = cap >= 5 ? 1 : 0;
  return { wolf, seer: 1, witch, hunter: 0, guard: 0, dreamer: 0, wolfBeauty: 0, cupid: 0, villager: cap - wolf - 1 - witch };
}
function refreshOfflineCounts() {
  const cap = parseInt(($('off-cap') && $('off-cap').value) || '6', 10) || 6;
  const c = offlineDefaultCounts(cap);
  for (const k of Object.keys(c)) { const el = $('off-count-' + k); if (el) el.value = c[k]; }
}
function openOfflineSetup() {
  refreshOfflineCounts();
  const m = $('offline-modal');
  if (m) m.classList.remove('hidden');
}
function closeOfflineSetup() {
  const m = $('offline-modal');
  if (m) m.classList.add('hidden');
}
async function startOfflineSetup() {
  const cap = parseInt(($('off-cap') && $('off-cap').value) || '6', 10) || 6;
  const level = ($('off-level') && $('off-level').value) || 'smart';
  const winMode = ($('off-winmode') && $('off-winmode').value) || 'edge';
  const thirdWinMode = ($('off-thirdwin') && $('off-thirdwin').value) || 'majority';
  const sheriff = !!($('off-sheriff') && $('off-sheriff').checked);
  const thief = !!($('off-thief') && $('off-thief').checked);
  const counts = {};
  for (const k of ['wolf', 'seer', 'witch', 'hunter', 'guard', 'dreamer', 'wolfBeauty', 'cupid', 'villager']) {
    const el = $('off-count-' + k);
    counts[k] = el ? (parseInt(el.value, 10) || 0) : 0;
  }
  const need = cap + (thief ? 1 : 0);
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (sum !== need) {
    toast(`职业总数 ${sum} 须${thief ? '比人数多 1' : '等于人数'}（${need}）`);
    return;
  }
  closeOfflineSetup();
  await launchOffline(cap, level, winMode, sheriff, thief, thirdWinMode, counts);
}
async function launchOffline(cap, level, winMode, sheriff, thief, thirdWinMode, counts) {
  if (!$('home') || $('home').classList.contains('hidden')) return;
  const name = nickValue();
  const r = await api('api/create', { name, deviceId: deviceId(), offline: true });
  if (r.error || !r.roomId || !r.playerId) { $('home-err').textContent = r.error || '创建失败，请重试'; return; }
  const room = r.roomId, me = r.playerId;
  token = r.token;
  for (let i = 0; i < cap - 1; i++) {
    const br = await api('api/action', { room, token, action: 'add_bot', data: { level } });
    if (br.error) break;
  }
  await api('api/action', { room, token, action: 'setCap', data: { cap } });
  if (counts) await api('api/action', { room, token, action: 'setCounts', data: { counts } });
  await api('api/action', { room, token, action: 'settings', data: { sheriff, thief, winMode, thirdWinMode } });
  localStorage.lwName = name;
  localStorage.lwRoom = room;
  enterRoom(room, me, r.view);
  const levelName = ({ easy: '简单', smart: 'normal', simulate: 'hard' })[level] || level;
  toast(`🎮 离线模式已启动：1 名真人 + ${cap - 1} 名${levelName}人机，点「开始游戏」即可`);
}
/* 创建房间：成功后先展示“房间号大卡”庆祝 1.5s，再自动进入 */
async function createRoom() {
  if (!$('home') || $('home').classList.contains('hidden')) return; // 已进入房间，忽略重复触发
  const name = nickValue();
  $('home-err').textContent = '';
  const card = $('card-create');
  card.classList.add('busy'); // 忙碌态防连点（16）
  const r = await api('api/create', { name, deviceId: deviceId() });
  card.classList.remove('busy');
  if (r.error || !r.roomId || !r.playerId) { $('home-err').textContent = r.error || '创建失败，请重试'; return; }
  token = r.token; // 安全加固：token 只从 create/join 响应获取，不进视图
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
  const r = await api('api/join', { roomId: code, name, deviceId: deviceId() });
  joinBusy = false;
  if (r.error || !r.playerId) { markCodeInvalid(r.error || '加入失败，请检查房间号'); $('home-err').textContent = r.error || '加入失败，请检查房间号'; return; }
  token = r.token; // 安全加固：token 只从 create/join 响应获取，不进视图
  localStorage.lwName = name;
  localStorage.lwRoom = code;
  enterRoom(code, r.playerId, r.view);
  toast('🎉 已进入房间 ' + code);
}
/* 房号非法/房间不存在：红框 + 抖动（0.5s 后自动恢复，等待重新输入） */

/* 创建成功“房间号大卡”（v1.2.0）：房号逐字弹出 + 复制按钮 + 进度条，1.5s 后自动入场 */
let createdTimer = null;

/* 在线统计（v1.2.0）：首页“🔥 当前 X 个房间正在开黑”；离开首页后不再请求 */
async function refreshStats() {
  if (!$('home') || $('home').classList.contains('hidden')) return;
  try {
    const res = await fetch('api/stats');
    if (!res.ok) return; // 404/403（隧道/局域网访问时 stats 受 token 控制）静默忽略
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

/* 强制继续智能判定（7）：存在未操作者才点亮 */

/* 玩家进出提示（45） */
let leaveArmed = false; // 离开二次确认（10）
let prevPlayerIds = null, prevPlayerNames = {};

/* 快捷短语（26） */

/* 身份大卡弹窗（8） */

/* 职业技能文案（B1）：buildRulesList 与身份大卡弹窗共用，避免两处维护 */
const SKILL_TEXT = {
  villager: '无技能，靠发言找狼', seer: '每晚查验一人', witch: '一解药一毒药，可自救', hunter: '出局可开枪带人',
  dreamer: '每晚梦游一人', guard: '每晚守护一人，不能连守', wolf: '夜晚刀人', wolfBeauty: '被放逐带走魅惑者',
  cupid: '指定情侣', thief: '开局窃取一张身份牌',
};
/* 规则速览（14） */

/* ============ Visual v4 辅助 ============ */
/* 减少动效开关（31）：localStorage ww_less_motion；同时作用于 CSS（body.less-motion）与 JS 动画 */

/* 轮到我选人时的动作图标（8）：决定玩家区扫光与选中卡图标 */

/* 弱网横幅（29） */

/* 全局动效层（17/20 模板入口）：独立 DOM、动画完自毁（animationend 自删 + 2.6s 兜底防泄漏），
 * 不参与 view 重绘；减少动效开关或系统 prefers-reduced-motion 时直接跳过。
 * 用法：spawnFx('💥', 'fx-boom', { left: x, top: y, '--fx': '...' }) */

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

/* 赛后趣味统计（v1.3.0）：整局本地累积，不依赖服务端新增数据 */
const stat = { deaths: [], chat: {}, firstNight: null };
const statSeen = {};      // 死亡记录去重：night:m / night:d
const statMsgIds = new Set(); // 聊天按消息 id 去重（增量下发可能重叠）

/* 环境粒子（v1.3.0）：夜晚流星、白天阳光粒子，低频随机触发（减少动效时 spawnFx 内部跳过） */

/* 字号调节（v1.3.0）：整页缩放三档，localStorage 记住（A-/A/A+） */

/* 人机级别选择（v1.4.0）：lobby 人机区三选，添加时固化到 bot.botLevel */

/* 邀请链接（v1.3.0）：origin + ?room=，复制/原生分享 */

/* 警徽飞行（13）：fixed 徽章从旧警长卡飞到新警长卡（走 spawnFx 动效层样板） */

/* 新警长当选落位（16）：警徽弹入动画 */

/* 快捷键（30）：数字 1~9 选座位号玩家，Enter 确认（仅选择阶段；输入框聚焦/触屏忽略） */

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
      focusPrimaryAction();
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

/* 上帝配音（v1.6.0）：Web Speech 零依赖，夜晚阶段/步骤播报（开关控制，localStorage ww_tts） */

/* 后台行动通知（v1.6.0）：页面隐藏且轮到我行动时弹系统通知 */

 // 狼嚎：低音扫频

 // 天亮：高音和弦

 // 投票确认：滴答

 // 放逐/死亡：重击

 // 翻牌：纸张沙沙

 // 入场：两声轻铃（v1.2.0）
/* v1.6.3：声音设置面板（顶栏 🔊 → 展开分项开关 + 上帝配音） */

let lastMusicKey = '';

