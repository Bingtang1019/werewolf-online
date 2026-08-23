// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

function applyView(v) {
  if (!v || v.error) return;
  if (view && v.v < view.v) return;
  musicSync(v); // v1.7.25（房间全局播放）：音乐状态同步
  // 上帝配音（v1.6.0）：夜晚开始 / 夜晚步骤切换时播报
  if (ttsOn && view) {
    if (v.phase === 'night' && view.phase !== 'night') speak('天黑请闭眼，请各位准备');
    if (v.phase === 'night' && v.nightStep && v.nightStep !== view.nightStep) speak((stepText[v.nightStep] || '请睁眼'));
  }
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
  if (window.__setMusicView) window.__setMusicView(view); // v1.7.22：歌单面板同步房主身份（审批区显隐）
}

function resetPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollMs = 0; // 强制按当前阶段重新计算间隔
  ensurePollTimer();
}

function currentPollMs() {
  if (!view) return isCfTunnel() ? 1000 : 800;
  // 连续失败（>=2 次）→ 指数退避，避免断线时轰炸隧道；CF 模式退避更缓
  if (pollFail >= 2) {
    const base = isCfTunnel() ? 3000 : 2000;
    return Math.min(isCfTunnel() ? 20000 : 15000, base * Math.pow(2, pollFail - 2));
  }
  // SSE 正常 → 长心跳即可（状态变化由推送即时触发）
  if (sseConnected) return SSE_HEARTBEAT_MS;
  // 常规轮询（SSE 不可用时回退原逻辑）；CF 模式降低请求频率，减少隧道压力
  if (isCfTunnel()) return needsFastPoll() ? 1000 : 2200;
  return needsFastPoll() ? 700 : 1600;
}

function ensurePollTimer() {
  const want = currentPollMs();
  if (pollTimer && pollMs === want) return;
  pollMs = want;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, want);
}

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

function pollNow() {
  if (!roomId || !token) return;
  poll();
}

function connectSSE() {
  if (!roomId || !token) return;
  if (sseDisabled) return; // v1.5.4：已降级为纯轮询，不再尝试长连接
  // v1.6.4（A1-P1-3）+ 1.8.0 CF 特化：快速隧道（trycloudflare）对 SSE 长连接不友好（http2 边缘取消）→ 直接纯轮询；可通过 CF 模式开关强制/关闭
  if (isCfTunnel()) { sseDisabled = true; return; }
  try { if (sse) sse.close(); } catch (e) {}
  sseConnected = false;
  try {
    sse = new EventSource(`api/stream?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`);
    sse.onopen = () => { sseConnected = true; ensurePollTimer(); }; // 切到 30s 心跳
    sse.onmessage = e => {
      try {
        const j = JSON.parse(e.data);
        if (!j) return;
        if (j.v && view && j.v > view.v) pollNow(); // 版本变化 → 立即拉取最新状态
      } catch (e) { /* 忽略非 JSON 数据 */ }
    };
    sse.onerror = () => {
      // SSE 断开：立即回退常规轮询（含指数退避）
      sseConnected = false;
      try { if (sse) sse.close(); } catch (e) {}
      sse = null;
      sseFails = (sseFails || 0) + 1;
      ensurePollTimer();
      // v1.5.4：连续失败 3 次 → 降级纯轮询（快速隧道对 SSE 长连接不友好时避免重连风暴，页面靠轮询存活）
      if (sseFails >= 3) { sseDisabled = true; }
      else setTimeout(connectSSE, 5000);
    };
  } catch (e) { sse = null; sseConnected = false; }
}

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
    const s = loadSession();
    const r = await api('api/join', { roomId: code, name, token: (s && s.token) || '', deviceId: deviceId() }); // v1.7.24：带 deviceId——token 失效时按设备认领旧位（防满员/分身）
    if (r.error || !r.playerId) { toast('无法进入上次房间：' + (r.error || '房间可能已解散'), 'err'); return; }
    token = r.token; // 安全加固：token 只从 create/join 响应获取，不进视图
    localStorage.lwName = name;
    localStorage.lwRoom = code;
    enterRoom(code, r.playerId, r.view);
    toast('🎉 已进入房间 ' + code);
  });
  // v1.7.29（刷新自动回房）：页面加载时若存在会话 → 自动 join 认领回房（刷新不再“掉出”——
  // 与上次房间按钮同链路：token 认领 + deviceId 兜底——刷新/断线后自动恢复原位）
  const sess = loadSession();
  const lastCode = localStorage.lwRoom;
  if (sess && sess.room && sess.token && lastCode && !location.search.includes('left=1')) {
    (async () => {
      const r = await api('api/join', { roomId: lastCode, name: nickValue(), token: sess.token, deviceId: deviceId() });
      if (r.error || !r.playerId) { /* 房间已解散/满员——保留“上次房间”按钮由用户手动处理 */ }
      else {
        token = r.token; // 安全加固：token 只从 create/join 响应获取，不进视图
        localStorage.lwName = nickValue();
        enterRoom(lastCode, r.playerId, r.view);
      }
    })();
  }
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
      const totalSec = view && dl2 ? (view.phaseDeadline ? (view.phaseTimeout || 30) : (view.nightTimeout || 30)) : 0;
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
  const offCard = $('card-offline');
  if (offCard) {
    offCard.addEventListener('click', openOfflineSetup);
    offCard.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOfflineSetup(); } });
  }
  const bOff = $('btn-offline');
  if (bOff) bOff.addEventListener('click', openOfflineSetup);
  const offStart = $('off-start'); if (offStart) offStart.addEventListener('click', startOfflineSetup);
  const offCancel = $('off-cancel'); if (offCancel) offCancel.addEventListener('click', closeOfflineSetup);
  const offCap = $('off-cap'); if (offCap) offCap.addEventListener('change', refreshOfflineCounts);
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
    await api('api/leave', { room: roomId, token });
    clearSession();
    location.reload();
  });

  // v1.7.26（分身根治）：不再主动发 leave——SSE 断线 60s 超时清理；token 不续期（一个 token 永久对应一个成员）
  // 房号点击即复制（9）→ v1.3.0：复制邀请链接
  $('room-code').addEventListener('click', copyInvite);
  // 身份芯片点击 → 大卡弹窗（8）
  const elChip = $('my-role-chip'); if (elChip) elChip.addEventListener('click', openRolePop);
  const elPop = $('role-pop'); if (elPop) elPop.addEventListener('click', closeRolePop);
  // 移动端聊天悬浮窗（v1.7.18+）：底端把手（唯一入口——聊天按钮已移除）+
  // 拖拽区 = 把手 + 标签页 + touchcancel + 拖拽后抑制 click + 外部点击收起
  const chd = $('chat-handle');
  const cht = $('chat-tabs');
  const bindChatDrag = el => {
    if (!el) return;
    el.addEventListener('touchstart', e => { if (e.touches[0]) chatDragStart(e.touches[0].clientY); }, { passive: true });
    el.addEventListener('touchmove', e => { if (chatDrag && e.touches[0]) { e.preventDefault(); chatDragMove(e.touches[0].clientY); } }, { passive: false });
    el.addEventListener('touchend', () => chatDragEnd());
    el.addEventListener('touchcancel', () => chatDragEnd());
  };
  if (chd) {
    chd.addEventListener('click', e => { e.stopPropagation(); if (chatSuppressClick) return; chatToggle(); });
    bindChatDrag(chd);
  }
  if (cht) bindChatDrag(cht);
  document.addEventListener('click', e => {
    if (document.body.classList.contains('chat-open') && !e.target.closest('#right')) {
      chatSetOpen(false);
    }
  });
  updateChatHandle();
  $('btn-force').addEventListener('click', () => { if (view && view.my && view.my.isHost) doAdvance(); });
  $('btn-chat').addEventListener('click', sendChat);
  $('chat-text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) sendChat(); });
  $('chat-text').addEventListener('blur', () => setTimeout(hideChatMentionPop, 150));
  // 聊天 UI 增强：点击消息里的玩家名 → 在输入框插入 @名字（A2-6）
  const cmsgs = $('chat-msgs');
  if (cmsgs) cmsgs.addEventListener('click', e => {
    const el = e.target.closest('[data-mention]');
    if (!el) return;
    const name = el.getAttribute('data-mention') || '';
    if (name) chatMention(name);
  });
  // 移动端底部快捷导航（E）
  const mnChat = $('mn-chat'); if (mnChat) mnChat.addEventListener('click', chatToggle);
  const mnTheme = $('mn-theme'); if (mnTheme) mnTheme.addEventListener('click', cycleUserTheme);
  const mnSound = $('mn-sound'); if (mnSound) mnSound.addEventListener('click', e => { e.stopPropagation(); toggleSoundPop(); });
  const mnLeave = $('mn-leave'); if (mnLeave) mnLeave.addEventListener('click', () => { const b = $('btn-leave'); if (b) b.click(); });
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
  // 减少动效 + 高对比度（F）：恢复上次选择并绑定开关
  try { if (localStorage.ww_less_motion === '1') toggleLessMotion(true); } catch (e) {}
  const lmEl = $('in-less-motion');
  if (lmEl) {
    lmEl.checked = localStorage.ww_less_motion === '1';
    lmEl.addEventListener('change', () => toggleLessMotion(lmEl.checked));
  }
  applyHighContrast();
  renderCfModeButtons();
  applyUserTheme();
  applyCustomAccent();
  const accentEl = $('in-accent');
  if (accentEl) {
    try { accentEl.value = localStorage.lwAccent || '#e8b64c'; } catch (e) {}
    accentEl.addEventListener('input', () => setCustomAccent(accentEl.value));
  }
  // 起始页设置抽屉（C）
  const hsOpen = $('btn-home-settings');
  const hsClose = $('btn-home-settings-close');
  const hsDrawer = $('home-settings-drawer');
  if (hsOpen) hsOpen.addEventListener('click', () => { if (hsDrawer) { hsDrawer.classList.remove('hidden'); renderThemeChips(); } });
  if (hsClose) hsClose.addEventListener('click', () => { if (hsDrawer) hsDrawer.classList.add('hidden'); });
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

  // 声音设置（v1.6.3）：顶栏 🔊 总开关 → 点击展开分项（含上帝配音）；首次交互后创建 AudioContext（浏览器自动播放策略）
  const sb = $('btn-sound');
  if (sb) {
    try { sfxOn = localStorage.ww_sfx !== '0'; } catch (e) {}
    try { const f = JSON.parse(localStorage.ww_sfx_flags || '{}'); for (const k of Object.keys(sfxFlags)) if (typeof f[k] === 'boolean') sfxFlags[k] = f[k]; } catch (e) {}
    try { ttsOn = localStorage.ww_tts === '1'; } catch (e) {}
    renderSoundPop();
    sb.addEventListener('click', e => { e.stopPropagation(); toggleSoundPop(); });
    const sbh = $('btn-sound-home'); // v1.7.17：首页音效入口（面板已全局化）
    if (sbh) sbh.addEventListener('click', e => { e.stopPropagation(); toggleSoundPop(); });
    // v1.7.25：歌单按钮（房间歌单面板——播放/点歌/审批）
    const bm = $('btn-music');
    if (bm) bm.addEventListener('click', e => { e.stopPropagation(); toggleMusicPop(); });
    // v1.7.26：歌单播放器完整绑定（播放/上下首/模式/音量/点歌/委托——补齐 HEAD 缺失）
    $('mp-play') && $('mp-play').addEventListener('click', e => { e.stopPropagation(); mpToggle(); });
    $('mp-next') && $('mp-next').addEventListener('click', e => { e.stopPropagation(); mpNext(); });
    $('mp-prev') && $('mp-prev').addEventListener('click', e => { e.stopPropagation(); mpPrev(); });
    $('mp-mode') && $('mp-mode').addEventListener('click', e => {
      e.stopPropagation();
      postMusic('mode', { mode: ((musicState.mode || 0) + 1) % 3 });
    });
    $('mp-vol') && $('mp-vol').addEventListener('input', e => {
      musicState.vol = +e.target.value;
      if (musicState.audio) musicState.audio.volume = musicState.vol / 100;
      try { localStorage.ww_music_vol = String(musicState.vol); } catch (err) {}
    });
    $('mp-submit') && $('mp-submit').addEventListener('click', () => {
      const url = $('mp-url').value.trim();
      if (!url) { toast('请先粘贴歌曲链接'); return; }
      if (!/^https?:\/\//i.test(url)) { toast('仅支持 http/https 直链'); return; }
      const note = $('mp-note').value.trim();
      postMusic('apply', { url, name: note || '成员点歌' }).then(() => {
        $('mp-url').value = ''; $('mp-note').value = '';
        toast('📨 已提交申请，等待房主审批');
      });
    });
    const mpPop2 = $('music-pop');
    if (mpPop2) mpPop2.addEventListener('click', e => {
      const songEl = e.target.closest('[data-song]');
      const act = songEl && songEl.getAttribute('data-act');
      const revEl = e.target.closest('[data-review]');
      if (songEl && !act) { mpPlay(songEl.getAttribute('data-song')); return; }
      if (revEl) { postMusic(revEl.getAttribute('data-act') === 'ok' ? 'approve' : 'reject', { id: revEl.getAttribute('data-review') }); }
    });
    try { if (localStorage.ww_music_mode) musicState.mode = +localStorage.ww_music_mode || 0; } catch (err) {}
    mpModeBtn();
    $('sp-master').addEventListener('change', () => setSfxMaster($('sp-master').checked));
    $('sp-wolf').addEventListener('change', () => setSfxFlag('wolf', $('sp-wolf').checked));
    $('sp-morning').addEventListener('change', () => setSfxFlag('morning', $('sp-morning').checked));
    $('sp-tick').addEventListener('change', () => setSfxFlag('tick', $('sp-tick').checked));
    $('sp-heavy').addEventListener('change', () => setSfxFlag('heavy', $('sp-heavy').checked));
    $('sp-flip').addEventListener('change', () => setSfxFlag('flip', $('sp-flip').checked));
    $('sp-enter').addEventListener('change', () => setSfxFlag('enter', $('sp-enter').checked));
    $('sp-tts').addEventListener('change', () => setTTS($('sp-tts').checked));
    document.addEventListener('click', e => { const pop = $('sound-pop'); if (pop && !pop.classList.contains('hidden') && !(e.target.closest && e.target.closest('.sound-pop-wrap, .js-sound-btn'))) pop.classList.add('hidden'); });
  }

  /* ---- 歌单面板（v1.7.22）：BGM 氛围音 + 成员点歌（UI 版——播放后端待接入） ---- */
  
  // 官方歌单：运行时从 playlist.json 加载（tools/music/ 生成——加歌无需改前端代码）
    // 官方歌单（一/二）：运行时从 playlist.json / playlist2.json 加载
  Promise.all([
    fetch('music/playlist.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('music/playlist2.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('music/playlist3.json').then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([pl1, pl2, pl3]) => {
    const list = [];
    (pl1 || []).forEach(s => list.push({ id: s.id, name: s.name, url: s.url, src: 'official', dur: 0, playing: false }));
    (pl2 || []).forEach(s => list.push({ id: 'b' + s.id, name: s.name, url: s.url, src: 'official2', dur: 0, playing: false }));
    (pl3 || []).forEach(s => list.push({ id: 'x' + s.id, name: s.name, url: s.url, src: 'official3', dur: 0, playing: false }));
    if (list.length) { musicState.list = list; renderMusicPop(); }
  }).catch(() => {});
}

function sendChat() {
  if ($('chat-text').disabled) return; // 当前频道不可发言（如夜晚全体频道）
  const text = $('chat-text').value.trim();
  if (!text) return;
  $('chat-text').value = '';
  hideChatMentionPop();
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
  sseFails = 0; sseDisabled = false; // v1.5.4：进房重置 SSE 降级状态
  askNotify(); // v1.6.0：进房时请求系统通知权限
  connectSSE(); // SSE 推送唤醒（失败自动回退轮询）
}

init();
