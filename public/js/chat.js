// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

function chatVh() { // 动态视口高（移动端浏览器工具栏存在时 innerHeight/vh 偏大——输入框被盖"打不了字"的根因）
  const vv = window.visualViewport;
  return vv && vv.height ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 600);
}

function chatHalfH() { return Math.max(320, Math.round(chatVh() * 0.55)); }

function chatHideY() { return chatVh() - CHAT_HANDLE_H; }

function chatHalfY() { return Math.max(0, chatVh() - chatHalfH()); }

function chatYNow() {
  const r = $('right');
  if (!r) return chatHideY();
  const m = /translateY\((-?[\d.]+)px\)/.exec(r.style.transform);
  return m ? parseFloat(m[1]) : (document.body.classList.contains('chat-open') ? chatHalfY() : chatHideY());
}

function applyChatY(y, animate) {
  const r = $('right');
  if (!r) return;
  r.style.transition = animate ? '' : 'none';
  r.style.transform = 'translateY(' + y + 'px)';
}

function chatSetOpen(open, full) {
  document.body.classList.toggle('chat-open', !!open);
  document.body.classList.toggle('chat-full', !!(open && full));
  applyChatY(open ? (full ? 0 : chatHalfY()) : chatHideY(), true);
  if (open) { chatUnread = 0; updateChatHandle(); }
}

function chatToggle() {
  const open = document.body.classList.contains('chat-open');
  const full = document.body.classList.contains('chat-full');
  if (open && !full) chatSetOpen(false);           // 半屏 → 收起
  else if (open && full) chatSetOpen(true, false); // 全屏 → 半屏
  else chatSetOpen(true);                           // 隐藏 → 半屏
}

function chatDragStart(y) { chatDrag = { startY: y, startYp: chatYNow(), moved: false }; }

function chatDragMove(y) {
  if (!chatDrag) return;
  if (!chatDrag.moved && Math.abs(y - chatDrag.startY) > CHAT_DRAG_TOL) {
    chatDrag.moved = true;
    chatSuppressClick = true; // 进入拖拽——本次 touch 序列的 click 作废
  }
  const yp = Math.max(0, Math.min(chatHideY(), chatDrag.startYp + (y - chatDrag.startY)));
  applyChatY(yp, false);
}

function chatDragEnd() {
  if (!chatDrag) return;
  const cur = chatYNow();
  const moved = chatDrag.moved;
  chatDrag = null;
  const half = chatHalfY(), hide = chatHideY();
  let y = hide;
  if (cur < (half + 0) / 2) y = 0;        // 顶部区 → 全屏
  else if (cur < (hide + half) / 2) y = half; // 中部 → 半屏
  chatSetOpen(y < hide, y === 0);
  if (moved) setTimeout(() => { chatSuppressClick = false; }, 350); // 拖拽后抑制松手 click
}

function updateChatHandle() {
  const el = $('chat-handle-label');
  if (!el) return;
  el.textContent = document.body.classList.contains('chat-open') ? '' : (chatUnread ? '聊天 · ' + chatUnread : '聊天');
}

function scrollChatIfNeeded(force) {
  const box = $('chat-msgs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  if (force || nearBottom) {
    requestAnimationFrame(() => { try { box.scrollTop = box.scrollHeight; } catch (e) {} });
  }
}

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
          : (t.indexOf('情侣') >= 0 || t.indexOf('丘比特') >= 0 || t.indexOf('魅') >= 0) ? '💘'
        : t.indexOf('解除') >= 0 ? '💔'
        : '🛎️';
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
    // 隐藏时新消息未读计数（悬浮窗把手提示；打开即清零）
    if (!document.body.classList.contains('chat-open') && msgs.length > lastChatCount) {
      chatUnread += msgs.length - lastChatCount;
      updateChatHandle();
    }
    lastChatCount = msgs.length;
    lastChatTab = chatTab;
    // 智能滚动（24）v1.7.18：距底部 <40px 才自动滚（上翻不打断）；最后一条是
    // 自己发的 → 强制滚到底（聊天 UX 标准：自己发消息总是可见）
    scrollChatIfNeeded(!!(msgs.length && msgs[msgs.length - 1].from === me));
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

function quickPhrase(txt) {
  const ci = $('chat-text');
  if (!ci || ci.disabled) return;
  ci.value = (ci.value ? ci.value + ' ' : '') + txt;
  ci.focus();
}
