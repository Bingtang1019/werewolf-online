// CSP 委托层（v1.7.29）：CSP script-src 'self' 阻止内联事件——动态渲染按钮全部改为 data-* 属性，
// 由 document 级事件委托统一处理（安全 + 可维护——事件逻辑集中一处）
// 注意：pointerdown 与 click 分别委托（原内联事件分 pointerdown/click 两种触发——保持语义一致，防双触发）

document.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-pd]');
  if (!el || el.disabled) return;
  const pd = el.dataset.pd;
  // data-pd 格式：act|kick|countChange|hostPick|mood|botLevel|capInput|capChange|setting|winmode|tierule|thief|thiefIdx|draftPower|draftTarget|draftPoison|draftThief
  const [kind, a, b] = pd.split('|');
  switch (kind) {
    case 'act': act(a); break;
    case 'actData': act(a, JSON.parse(b || '{}')); break;
    case 'kick': kick(a); break;
    case 'count': countChange(a, parseInt(b, 10)); break;
    case 'host': hostPick(a === 'random' ? 'random' : a); break;
    case 'mood': cycleMood(); break;
    case 'botLevel': setBotLevel(a); break;
    case 'setWolfKill': setWolfKill(a); break;
    case 'setWolfCharm': setWolfCharm(a); break;
    case 'doPick': doPick(a, b); break;
    case 'draftPower': draft.power = a; renderPanel(); break;
    case 'draftTarget': draft.target = a; renderPanel(); break;
    case 'draftPoison': draft.poison = a; renderPanel(); break;
    case 'draftThiefIdx': draft.thiefIdx = parseInt(a, 10); render(); break;
    case 'doThiefPick': doThiefPick(); break;
    case 'doCupidPick': doCupidPick(); break;
    case 'witchSave': witchSave(); break;
    case 'witchPoison': witchPoison(); break;
    case 'hunterShoot': hunterShoot(); break;
    case 'doAdvance': doAdvance(); break;
    case 'sendLastword': sendLastword(); break;
    case 'handoverPick': handoverPick(); break;
    case 'doWolfConfirm': doWolfConfirm(); break;
    case 'castVote': castVote(); break;
    case 'castVoteLock': castVote(true); break;
  }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-ck]');
  if (el && !el.disabled) {
    const ck = el.dataset.ck;
    const [kind, a, b] = ck.split('|');
    switch (kind) {
      case 'act': act(a); break;
      case 'actData': act(a, JSON.parse(b || '{}')); break;
      case 'count': countChange(a, parseInt(b, 10)); break;
      case 'kick': kick(a); break;
      case 'host': hostPick(a === 'random' ? 'random' : a); break;
      case 'mood': cycleMood(); break;
      case 'botLevel': setBotLevel(a); break;
    }
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) { chatTab = tab.dataset.tab; renderChat(); return; }
  const qp = e.target.closest('[data-qp]');
  if (qp) { quickPhrase(JSON.parse(qp.dataset.qp)); return; }
  const em = e.target.closest('[data-emoji]');
  if (em) { chatSend(chatTab, em.dataset.emoji); return; }
  const mi = e.target.closest('[data-mention-item]');
  if (mi) { insertChatMention(mi.dataset.mentionItem); return; }
  const ca = e.target.closest('[data-chatact]');
  if (ca) {
    const kind = ca.dataset.chatact;
    if (kind === 'copy') copyText(ca.dataset.copy || '', '📋 消息已复制');
    else if (kind === 'reply') chatMention(ca.dataset.name || '');
    return;
  }
  const fs = e.target.closest('[data-font]');
  if (fs) { setFontScale(parseInt(fs.dataset.font, 10)); return; }
  const tm = e.target.closest('.js-theme-btn');
  if (tm) { cycleUserTheme(); return; }
  const tchip = e.target.closest('[data-theme]');
  if (tchip) { applyUserTheme(tchip.dataset.theme); renderThemeChips(); return; }
  const hc = e.target.closest('.js-contrast-btn');
  if (hc) { toggleHighContrast(); return; }
  const cfb = e.target.closest('.js-cf-mode-btn');
  if (cfb) { cycleCfTunnelMode(); return; }
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-cap]');
  if (el) onCapInput(el.value);
  const ci = e.target.closest('#chat-text');
  if (ci) updateChatMentionPop();
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-cap]');
  if (el) { onCapChange(el.value); return; }
  const se = e.target.closest('[data-set]');
  if (se) {
    const [key, val] = se.dataset.set.split('|');
    onSetting(key, val === 'checked' ? se.checked : val);
    return;
  }
  const wm = e.target.closest('[data-winmode]');
  if (wm) { onWinMode(wm.dataset.winmode); return; }
  const tw = e.target.closest('[data-thirdwin]');
  if (tw) { onThirdWinMode(tw.dataset.thirdwin); return; }
  const tr = e.target.closest('[data-tierule]');
  if (tr) { onTieRule(tr.dataset.tierule); return; }
  const th = e.target.closest('[data-thief]');
  if (th) { onThief(th.checked); }
});
