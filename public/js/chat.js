// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

function chatTimeLabel(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function chatShortTime(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function chatMention(name) {
  const ci = $('chat-text');
  if (!ci || ci.disabled) return;
  ci.value = (ci.value ? ci.value + ' ' : '') + '@' + name + ' ';
  ci.focus();
}

function highlightChatMentions(html) {
  const names = (view.players || []).map(p => p.name).filter(Boolean);
  for (const name of names) {
    const token = '@' + escapeHtml(name);
    html = html.split(token).join('<span class="mention">' + token + '</span>');
  }
  return html;
}

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
  hideChatMentionPop();
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

let lastMentionAlert = 0;

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
  // 私聊未读数字（C）：非当前 tab 有新消息时显示数量徽章
  const dots = {};
  for (const t of tabs) {
    const key = t[0];
    if (key !== chatTab) {
      const last = lastTabTs[key] || 0;
      const n = view.chat.filter(m => m.ch === key && m.ts > last).length;
      if (n > 0) dots[key] = n;
    }
  }
  $('chat-tabs').innerHTML = tabs.map(t =>
    `<div class="chat-tab ${chatTab === t[0] ? 'active' : ''}${dots[t[0]] ? ' dot' : ''}" data-tab="${t[0]}">${t[1]}${dots[t[0]] ? `<span class="tab-badge">${Math.min(99, dots[t[0]])}</span>` : ''}</div>`).join('');
  // 消息
  const msgs = view.chat.filter(m => m.ch === chatTab);
  // 消息数变化或频道切换时才重绘（两个频道消息数恰好相同时，仅靠数量无法区分）
  if (msgs.length !== lastChatCount || lastChatTab !== chatTab) {
    const html = [];
    let lastTs = 0;
    for (const m of msgs) {
      const t = m.ts || 0;
      if (t && lastTs && (new Date(t).toDateString() !== new Date(lastTs).toDateString() || t - lastTs > 10 * 60 * 1000)) {
        html.push(`<div class="chat-time">${chatTimeLabel(t)}</div>`);
      }
      if (t) lastTs = t;
      if (m.marker === '系统') {
        // 系统消息图标化（21）：按内容匹配图标
        const text = m.text || '';
        const icon = (text.indexOf('狼') >= 0 || text.indexOf('刀') >= 0 || text.indexOf('杀') >= 0) ? '🐺'
          : text.indexOf('枪') >= 0 ? '🔫' : text.indexOf('毒') >= 0 ? '🧪' : text.indexOf('放逐') >= 0 ? '⚖️'
          : text.indexOf('警') >= 0 ? '👮' : text.indexOf('盗') >= 0 ? '🃏' : text.indexOf('殉情') >= 0 ? '💔'
          : (text.indexOf('情侣') >= 0 || text.indexOf('丘比特') >= 0 || text.indexOf('魅') >= 0) ? '💘'
        : text.indexOf('解除') >= 0 ? '💔'
        : '🛎️';
        html.push(`<div class="chat-sys" title="${escapeHtml(chatShortTime(t))}">${icon} ${escapeHtml(m.text)}</div>`);
        continue;
      }
      const mine = !!(m.from && m.from === me);
      const chCls = m.ch === 'wolf' ? 'ch-wolf' : m.ch === 'lover' ? 'ch-lover' : '';
      const lwCls = m.marker === '遗言' ? 'marker-lastword' : '';
      const sender = view.players.find(p => p.id === m.from);
      const deadCls = sender && !sender.alive ? ' dead' : '';
      const av = sender ? avatarOf(sender) : '👤';
      const seatHtml = sender && sender.seat ? ` <span class="cm-seat">#${sender.seat}</span>` : '';
      const deadMark = sender && !sender.alive ? ' 💀' : '';
      const textHtml = highlightChatMentions(escapeHtml(m.text));
      const mentioned = !!(m.text && view.my && view.my.name && m.text.indexOf('@' + view.my.name) !== -1);
      const mentionCls = mentioned ? ' mentioned' : '';
      if (mentioned && !mine && !document.body.classList.contains('chat-open') && Date.now() - lastMentionAlert > 5000) {
        lastMentionAlert = Date.now();
        if (typeof vibrate === 'function') vibrate(80);
        toast('💬 ' + (m.name || '有人') + ' 提到了你');
      }
      html.push(`<div class="chat-msg ${chCls} ${mine ? 'mine' : ''} ${lwCls}${deadCls}${mentionCls}" title="${escapeHtml(chatShortTime(t))}">
        ${mine ? '' : `<span class="cm-avatar">${av}</span>`}
        ${m.marker && m.marker !== '遗言' ? `<span class="cm-marker">${escapeHtml(m.marker)}</span>` : ''}
        <span class="cm-name" data-mention="${escapeHtml(m.name)}">${escapeHtml(m.name)}${seatHtml}${deadMark}</span><span class="cm-text">${textHtml}</span>
        <span class="cm-actions">
          <button class="cm-act" data-chatact="copy" data-copy="${escapeHtml(m.text)}" title="复制消息" aria-label="复制消息">📋</button>
          <button class="cm-act" data-chatact="reply" data-name="${escapeHtml(m.name)}" title="回复 ${escapeHtml(m.name)}" aria-label="回复 ${escapeHtml(m.name)}">💬</button>
        </span></div>`);
    }
    $('chat-msgs').innerHTML = html.join('');
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
      const inVote = view.phase === 'vote' || view.phase === 'pk_vote';
      const phrases = [];
      if (inVote) phrases.push(tgt ? '投 ' + tgt : '投', '弃票');
      if (view.phase === 'night') phrases.push('过', '晚上见');
      else phrases.push('我跳预言家', '过');
      if (tgt) phrases.push('踩 ' + tgt, '保 ' + tgt);
      const myRole = view.my && view.my.role;
      if (myRole === '预言家') phrases.unshift(tgt ? '查杀 ' + tgt : '查杀');
      else if (myRole === '女巫') phrases.unshift(tgt ? '我救了他' : '昨晚平安夜');
      else if (myRole === '猎人') phrases.unshift('我是猎人');
      else if (myRole === '狼人' || myRole === '狼美人') phrases.unshift('我是平民');
      phrases.push('哈哈哈');
      // B3：不拼 onclick 字符串——JSON.stringify 产出合法 JS 字符串字面量 + escapeHtml 防属性逃逸，玩家名/发言含恶意字符也安全
      const emojis = ['👍', '😂', '🔥', '🌙', '🐺', '💀'];
      qp.innerHTML = phrases.map(p => `<button data-qp="${escapeHtml(JSON.stringify(p))}">${escapeHtml(p)}</button>`).join('') +
        emojis.map(e => `<button class="cm-emoji" data-emoji="${e}" title="发送表情">${e}</button>`).join('');
    } else qp.classList.add('hidden');
  }
}

function quickPhrase(txt) {
  const ci = $('chat-text');
  if (!ci || ci.disabled) return;
  ci.value = (ci.value ? ci.value + ' ' : '') + txt;
  ci.focus();
}

/* A2-6 增强：输入 @ 时弹出存活玩家名自动补全 */
function updateChatMentionPop() {
  const ci = $('chat-text');
  const pop = $('chat-mention-pop');
  if (!ci || !pop) return;
  const val = ci.value;
  const pos = ci.selectionStart || val.length;
  const before = val.slice(0, pos);
  const at = before.lastIndexOf('@');
  if (at < 0 || before.slice(at + 1).indexOf(' ') !== -1) { pop.classList.add('hidden'); return; }
  const q = before.slice(at + 1).toLowerCase();
  const names = (view.players || [])
    .filter(p => p.alive && p.id !== view.my.id)
    .map(p => p.name).filter(Boolean)
    .filter(n => n.toLowerCase().indexOf(q) !== -1)
    .slice(0, 8);
  if (!names.length) { pop.classList.add('hidden'); return; }
  pop.innerHTML = names.map(n => `<button class="cm-mention-item" data-mention-item="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
  pop.classList.remove('hidden');
}

function insertChatMention(name) {
  const ci = $('chat-text');
  const pop = $('chat-mention-pop');
  if (!ci || !pop) return;
  const val = ci.value;
  const pos = ci.selectionStart || val.length;
  const before = val.slice(0, pos);
  const at = before.lastIndexOf('@');
  ci.value = val.slice(0, at) + '@' + name + ' ' + val.slice(pos);
  ci.focus();
  const np = at + name.length + 2;
  ci.setSelectionRange(np, np);
  pop.classList.add('hidden');
}

function hideChatMentionPop() {
  const pop = $('chat-mention-pop');
  if (pop) pop.classList.add('hidden');
}
