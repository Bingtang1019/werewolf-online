// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

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

function applyTheme() {
  const body = document.body;
  if (!view) { body.classList.remove('theme-night', 'theme-day'); return; }
  const night = view.phase === 'night';
  const day = ['morning', 'lastword', 'handover', 'sheriff_campaign', 'sheriff_vote', 'discuss', 'vote', 'pk_speech', 'pk_vote', 'hunter_shot'].includes(view.phase);
  body.classList.toggle('theme-night', night);
  body.classList.toggle('theme-day', day);
}

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
      ? `<button class="mood-btn ${p.mood ? 'has' : ''}" data-ck="mood|" title="心情表情，点击切换">${p.mood || '🎭'}</button>`
      : (p.mood ? `<span class="mood-tag">${escapeHtml(p.mood)}</span>` : '');
    const role = p.role ? `<div class="prole ${ROLE_CAMP_TEXT[p.role] || ''}">${ROLE_EMOJI_TEXT[p.role] || ''} ${escapeHtml(p.role)}</div>` : '';
    const deadTxt = p.alive ? '' : `<div class="pdead">💀 ${DEATH_TEXT[p.deadBy] || p.deadBy}${p.deadNote ? '（' + escapeHtml(p.deadNote) + '）' : ''}</div>`;
    const dmark = p.alive ? '' : `<span class="dmark dm-${p.deadBy || 'left'}"></span>`; // v1.7.18 死亡标记（死因 SVG 图形）
    return `<div class="player ${p.isMe ? 'me' : ''} ${p.alive ? '' : 'dead'}${flashCls} ${draft.target === p.id || draft.target2 === p.id ? 'selected' : ''}" data-id="${p.id}">
      <div class="phead"><div class="avatar ${p.alive ? '' : 'dead'}">${avatarOf(p)}</div>
      <div class="pmeta"><div class="pname">${name}${moodHtml}<span class="pseat">#${p.seat}</span></div>${role}${deadTxt}</div></div>
      ${pickIc ? `<span class="pick-ic">${pickIc}</span>` : ''}
      ${dmark}
    </div>`;
  };
  // 座位排序 + 墓地分区（3 轻量版）：存活区按 seat 升序，墓地带分组头、死者保留座位号（hover 展开详情）
  $('players').innerHTML = alive.map(card).join('') +
    (dead.length ? `<div class="dead-title">💀 已出局（${dead.length}）</div>` + dead.map(card).join('') : '');
}

function renderInfo() {
  const info = $('info');
  let html = '';
  // 情侣信息（被指认的瞬间醒来彼此确认身份，之后随时可见）
  if (view.myLover) {
    html += `<div class="info-box" style="border-color:var(--third)">💞 你的情侣：<b>${escapeHtml(view.myLover.name)}</b>（身份：${escapeHtml(view.myLover.role)}）${view.myLover.cupidName ? '　指认者：' + escapeHtml(view.myLover.cupidName) : ''}</div>`;
  }
  // v1.7.6（丘比特规则补足）：丘比特知情侣身份（两人）——白天也可见
  if (view.myCouple) {
    const names = view.myCouple.map(c => `${escapeHtml(c.name)}（${escapeHtml(c.role)}）`).join(' 与 ');
    html += `<div class="info-box" style="border-color:var(--third)">💞 你指定的情侣：${names}</div>`;
  }
  // v2（M1/M4）：恋人机制（解绑按钮——丘比特死后点亮，恋人白天可发起，一次性；公告=身份公开代价）
  if (view.lover && view.lover.loverMode === 'v2' && view.lover.inLovers) {
    const powerTxt = view.lover.power === 'guard' ? '🛡️守护（每晚挡一次狼刀，挡刀时狼队获知）' : view.lover.power === 'vengeance' ? '💥复仇（殉情方临死宣言恋人身份）' : '';
    if (powerTxt) html += `<div class="info-box" style="border-color:var(--third)">恋人权能：${powerTxt}</div>`;
    html += `<div class="info-box" style="border-color:var(--third)">💞 恋人关系${view.lover.cupidDead ? '（丘比特已出局，可解除关系）' : '（丘比特在世，关系锁定中）'}
      ${view.lover.canUnbind ? `<button class="danger" data-pd="actData|lover_unbind|{}">解除情侣关系（身份公开）</button>` : ''}
      ${view.lover.unbindUsed ? '<span class="tip-text">本局已解除</span>' : ''}</div>`;
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

function renderPanel() {
  const panel = $('panel');
  panel.classList.remove('night-panel', 'wolf-panel');
  // 轮到我行动 → 面板呼吸光圈（“睁眼”高亮）+ 首次轮到我时短震（v1.3.0）
  const myTurn = view.phase !== 'lobby' && view.phase !== 'reveal' && view.phase !== 'ended' && needsFastPoll();
  if (myTurn && !prevMyTurn) { vibrate(60); notifyTurn(stepText[view.nightStep] || '请查看你的回合'); } // v1.6.0：后台通知
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
        const glow = { thief: 'rgba(232,182,76,.4)', cupid: 'rgba(255,122,200,.5)', lovers: 'rgba(255,122,200,.35)', guard: 'rgba(74,222,128,.4)', dreamer: 'rgba(106,216,208,.45)', wolf: 'rgba(224,96,96,.45)', seer: 'rgba(90,162,255,.5)', witch: 'rgba(176,106,240,.5)', hunter: 'rgba(255,140,90,.45)' }[nstep];
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

function renderLobby() {
  const isHost = view.my.isHost;
  let html = `<div class="panel-title">🏠 房间 ${view.roomId} <span class="badge">${view.players.length}/${view.playerCap} 人</span></div>`;
  html += `<div class="panel-desc">把房间号发给朋友，人满后由房主开局。</div>`;
  if (isHost) {
    html += `<div class="set-group"><div class="sg-title">人数（<span id="cap-title-num">${view.playerCap}</span> 人，4~18）</div>
      <input id="cap-slider" type="range" min="${Math.max(4, view.players.length)}" max="18" value="${view.playerCap}" data-cap="1" data-cap="1">
      <div class="tip-text" id="cap-tip">当前 ${view.playerCap} 人</div></div>`;
    html += `<div class="set-group"><div class="sg-title">职业配置（总数须等于人数）</div>` + roleCountsHtml() + `<div class="total-hint" id="count-hint"></div></div>`;
    html += `<div class="set-group"><div class="sg-title">规则</div>
      <div class="radio-row">
        <label><input type="checkbox" ${view.settings.sheriff ? 'checked' : ''} data-set="sheriff|checked"> 👮 警长选举（可关闭）</label>
        <label><input type="radio" name="winmode" value="edge" ${view.settings.winMode === 'edge' ? 'checked' : ''} data-winmode="edge"> 屠边</label>
        <label><input type="radio" name="winmode" value="city" ${view.settings.winMode === 'city' ? 'checked' : ''} data-winmode="city"> 屠城</label>
      </div>
      <div class="radio-row" style="margin-top:6px">
        <label><input type="radio" name="tie" value="pk" ${view.settings.tieRule === 'pk' ? 'checked' : ''} data-tierule="pk"> 平票PK</label>
        <label><input type="radio" name="tie" value="none" ${view.settings.tieRule === 'none' ? 'checked' : ''} data-tierule="none"> 平票无人出局</label>
      </div>
      <div class="radio-row" style="margin-top:6px">
        <label><input type="radio" name="thirdwin" value="majority" ${view.settings.thirdWinMode !== 'classic' ? 'checked' : ''} data-thirdwin="majority"> 神眷者多数存活</label>
        <label><input type="radio" name="thirdwin" value="classic" ${view.settings.thirdWinMode === 'classic' ? 'checked' : ''} data-thirdwin="classic"> 神眷者经典</label>
      </div>
      <div class="radio-row" style="margin-top:6px">
        <label><input type="checkbox" ${view.settings.thief ? 'checked' : ''} data-thief="1"> 🃏 盗贼玩法（身份牌总数须比人数多 1）</label>
      </div>
      <div class="tip-text">开启后：随机一名玩家为盗贼，从两张身份牌中择一（有狼必选狼），另一张作废。</div></div>`;
    html += `<div class="set-group"><div class="sg-title">🤖 人机调试</div>
      <div class="radio-row">
        <label><input type="radio" name="botmode" value="auto" ${view.settings.botMode !== 'passive' ? 'checked' : ''} data-set="botMode|auto">默认简单</label>
        <label><input type="radio" name="botmode" value="passive" ${view.settings.botMode === 'passive' ? 'checked' : ''} data-set="botMode|passive">默认挂机</label>
      </div>
      <div class="radio-row bot-level-row">
        <span class="tip-text" style="margin-right:4px">新加人机级别：</span>
        <button class="mini bot-level${botLevelChoice === 'idle' ? ' active' : ''}" data-ck="botLevel|idle">挂机</button>
        <button class="mini bot-level${botLevelChoice === 'easy' ? ' active' : ''}" data-ck="botLevel|easy">简单</button>
        <button class="mini bot-level${botLevelChoice === 'smart' ? ' active' : ''}" data-ck="botLevel|smart">智能</button>
 <button class="mini bot-level${botLevelChoice === 'simulate' ? ' active' : ''}" data-ck="botLevel|simulate">模拟</button>
      </div>
      <div class="btn-row">
        <button data-ck="actData|add_bot|{level:botLevelChoice}">＋ 添加人机</button>
        <button data-ck="actData|remove_bot|{}">－ 移除最后一个人机</button>
      </div>
      <div class="tip-text">人机自动执行本职业行动（夜晚决策/白天投票），用于缺人陪练与调试；「智能」会分析发言（跳预言家/查杀/金水）与投票记录做贝叶斯推理，狼人视角还会优先刀跳预言家的玩家。botMode 作为默认级别，单个 bot 级别在添加时固化。</div></div>`;
    const ready = view.players.length === view.playerCap;
    html += `<div class="btn-row"><button class="primary" id="btn-start" data-pd="act|start" ${ready ? '' : 'disabled'}>开始游戏</button></div>`;
    if (!ready) html += `<div class="tip-text">还需 ${view.playerCap - view.players.length} 人加入</div>`;
  } else {
    html += `<div class="waiting">等待房主配置并开始游戏…</div>`;
  }
  html += `<div class="set-group"><div class="sg-title">玩家列表（${view.players.length} 人）</div>` +
    view.players.map(p =>
      `<div class="count-row"><div class="cr-name">${escapeHtml(p.name)}${p.isBot ? ' <span class="badge bot-badge">🤖人机</span>' : ''}${p.id === view.host ? ' <span class="badge">房主</span>' : ''}</div>` +
      (isHost && p.id !== view.my.id ? `<div class="cr-ctrl"><button class="danger mini" data-ck="kick|${p.id}">踢出</button></div>` : '') + `</div>`
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
        <div class="cr-ctrl"><button data-ck="count|${k}|-1">−</button><span id="c-${k}">${n}</span><button data-ck="count|${k}|1">+</button></div></div>`;
    }
    return `<div class="count-row"><div class="cr-name ${ROLE_CAMP[k] || ''}">${ROLE_NAMES[k]}</div>
      <div class="cr-ctrl"><button data-ck="count|${k}|${n === 1 ? -1 : 1}">${n === 1 ? '移除' : '添加'}</button></div></div>`;
  }).join('');
}

function renderReveal() {
  const rv = view.reveal || {};
  let html = `<div class="panel-title">🃏 身份展示</div>`;
  // 房主选择期望职业（或随机分配）
  if (rv.canPick) {
    html += `<div class="panel-desc">由你决定本局职业（可选一种身份牌，或随机分配；之后随机指定盗贼——若开启）。</div>`;
    html += `<div class="role-cards">` + (rv.available || []).map((r, i) =>
      `<div class="role-card ${ROLE_CAMP[r.key] || ''}" style="--rc:${ROLE_GLOW_TEXT[r.name] || ''};animation-delay:${i * 60}ms" data-ck="host|${r.key}"><div class="rc-emoji">${ROLE_EMOJI[r.key] || ''}</div><div class="rc-name">${r.name}</div><div class="rc-desc">${escapeHtml(r.desc)}</div></div>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button data-ck="host|random">🎲 随机分配</button></div>`;
  } else if (rv.isThief && rv.thiefCards) {
    // 盗贼选牌（注意：非房主拿到的 stage 为 null，不能作为判断依据；isThief/thiefCards 已由服务端判定）
    html += `<div class="panel-desc">🃏 你是<b>盗贼</b>！从以下两张身份牌中选择一张作为你的身份（若有狼人牌则必须选狼人），另一张作废：</div>`;
    // 盗贼警示（24）：两张牌含狼时红框闪烁提示条
    const thiefHasWolf = (rv.thiefCards || []).some(r => r.key === 'wolf' || r.key === 'wolfBeauty');
    if (thiefHasWolf) html += `<div class="tip-text thief-warn">⚠️ <b>两张牌中有狼人牌，你必须选择狼人！</b></div>`;
    html += `<div class="role-cards">` + (rv.thiefCards || []).map((r, i) =>
      `<div class="role-card ${ROLE_CAMP[r.key] || ''} ${thiefHasWolf && (r.key === 'wolf' || r.key === 'wolfBeauty') ? 'thief-wolf' : ''} ${draft.thiefIdx === i ? 'chosen' : ''}" style="--rc:${ROLE_GLOW_TEXT[r.name] || ''};animation-delay:${i * 80}ms" data-pd="draftThiefIdx|${i}"><div class="rc-emoji">${ROLE_EMOJI[r.key] || ''}</div><div class="rc-name">${r.name}</div><div class="rc-desc">${escapeHtml(r.desc)}</div></div>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button class="primary" data-pd="doThiefPick|" ${draft.thiefIdx === undefined ? 'disabled' : ''}>确认选择</button></div>`;
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
      : `<div class="btn-row"><button class="primary" data-pd="act|confirm">确认身份</button></div>`;
    html += `<div class="tip-text">${rv.thiefTook ? '⏳ 盗贼结果展示中，5 秒后自动进入夜晚…' : '⏳ 全员确认或等待 5 秒后自动进入夜晚'}</div>`;
  }
  const done = (rv.confirmed || []).filter(c => c.ok).length;
  const need = (rv.confirmed || []).length;
  html += `<div class="tip-text" style="margin-top:12px">已确认 ${done}/${need}${view.my.isHost ? '　房主可点击右上角【强制继续】跳过等待' : ''}</div>`;
  return html;
}

function renderNight() {
  const n = view.night || {};
  const step = n.step;
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
          if (view.lover && view.lover.loverMode === 'v2') {
            html += `<div class="btn-row">
              <button class="${draft.power === 'guard' ? 'primary' : ''}" data-pd="draftPower|guard">🛡️ 守护</button>
              <button class="${draft.power === 'vengeance' ? 'primary' : ''}" data-pd="draftPower|vengeance">💥 复仇</button>
              <span class="tip-text">守护：每晚挡狼刀（暴露恋人）｜复仇：殉情方宣言恋人身份</span>
            </div>`;
          }
          html += pickTip;
          html += `<div class="btn-row"><button class="primary" data-pd="doCupidPick|" ${draft.target && draft.target2 ? '' : 'disabled'}>确定情侣</button></div>`;
          if (!draft.target || !draft.target2) html += `<div class="tip-text">在左侧玩家列表中点选两名玩家</div>`;
        } else {
          html += `<div class="panel-desc">上一对情侣已殉情，你可以重新指定两名玩家为情侣（阵营将随新情侣变化），也可以选择不再指定：</div>`;
          html += pickTip;
          html += `<div class="btn-row"><button class="primary" data-pd="doCupidPick|" ${draft.target && draft.target2 ? '' : 'disabled'}>重新指定情侣</button></div>`;
          html += `<div class="btn-row"><button data-pd="actData|cupid_pick|{ids:null}">本轮不指定（放弃重选）</button></div>`;
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
        html += `<div class="btn-row"><button class="primary" data-pd="act|lovers_ok">知道了</button></div>`;
      } else html += `<div class="waiting">等待情侣确认…</div>`;
      break;
    }
    case 'guard': {
      if (view.my.roleKey === 'guard') {
        const last = n.guard && n.guard.last;
        html += `<div class="panel-desc">守护一名玩家（可守自己，不能连续两晚守同一人）。上一晚守护：${last ? escapeHtml(nameOf(last)) : '无'}</div>`;
        html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
        html += `<div class="btn-row"><button class="primary" data-pd="doPick|guard_pick|guard" ${draft.target ? '' : 'disabled'}>确认守护</button></div>`;
        if (!draft.target) html += `<div class="tip-text">在左侧玩家列表中点选目标</div>`;
      } else html += `<div class="waiting">等待守卫行动…</div>`;
      break;
    }
    case 'dreamer': {
      if (view.my.roleKey === 'dreamer') {
        html += `<div class="panel-desc">选择一名玩家成为梦游者（不能梦自己；梦游者免疫夜间伤害）。</div>`;
        html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
        html += `<div class="btn-row"><button class="primary" data-pd="doPick|dreamer_pick|dreamer" ${draft.target ? '' : 'disabled'}>确认</button></div>`;
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
          <div class="btn-row">${alivePlayers().map(p => `<button class="mini" data-pd="setWolfKill|${p.id}">${escapeHtml(p.name)}</button>`).join('')}
          <button class="mini" data-pd="setWolfKill|none">空刀</button></div></div>`;
        if (hasWolfBeauty) {
          html += `<div class="set-group"><div class="sg-title">💘 魅惑目标：${escapeHtml(charmed)}</div>
            <div class="btn-row">${alivePlayers().filter(p => p.id !== view.my.id).map(p => `<button class="mini" data-pd="setWolfCharm|${p.id}">${escapeHtml(p.name)}</button>`).join('')}
            <button class="mini" data-pd="setWolfCharm|none">不魅惑</button></div></div>`;
        }
        const meActed = n.actors.find(a => a.id === view.my.id);
        html += `<div class="btn-row"><button class="primary" data-pd="doWolfConfirm|" ${meActed && meActed.acted ? 'disabled' : ''}>确认行动</button></div>`;
        if (meActed && meActed.acted) html += `<div class="tip-text">✅ 你已确认，等待其他狼人…</div>`;
      } else html += `<div class="waiting">等待狼人行动…</div>`;
      break;
    }
    case 'seer': {
      if (view.my.roleKey === 'seer') {
        html += `<div class="panel-desc">查验一名玩家是好人还是狼人。</div>`;
        html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
        html += `<div class="btn-row"><button class="primary" data-pd="doPick|seer_pick|seer" ${draft.target ? '' : 'disabled'}>查验</button></div>`;
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
          <div class="btn-row"><button class="primary" data-pd="witchSave|" ${!w.saveUsed && w.victim ? '' : 'disabled'}>使用解药救他</button></div></div>`;
        html += `<div class="set-group"><div class="sg-title">毒药 ${w.poisonUsed ? '（已使用）' : '（未使用）'}</div>
          <div class="tip-text">已选：${draft.poison ? escapeHtml(nameOf(draft.poison)) : '—'}</div>
          <div class="btn-row">${alivePlayers().filter(p => p.id !== view.my.id).map(p => `<button class="mini" data-pd="draftPoison|${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div></div>`;
        html += `<div class="btn-row"><button class="primary" data-pd="witchPoison|" ${draft.poison && !w.poisonUsed ? '' : 'disabled'}>毒杀他</button><button data-pd="actData|witch_act|{save:false}">跳过（本晚不用药）</button></div>`;
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
    const reason = h.context === 'exile' ? '你被投票放逐' : '你被狼人杀害'; // v1.6.2：区分夜晚/白天开枪场景
    return `<div class="panel-title" style="color:var(--accent)">🔫 ${reason}，可以开枪</div>
      <div class="panel-desc">选择一名玩家枪杀（不能开枪自杀），或选择放弃。</div>
      <div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>
      <div class="btn-row">${alivePlayers().filter(p => p.id !== view.my.id).map(p => `<button class="mini" data-pd="draftTarget|${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div>
      <div class="btn-row"><button class="primary" data-pd="hunterShoot|" ${draft.target ? '' : 'disabled'}>开枪</button><button data-pd="hunterShoot|" ${draft.target ? 'style="display:none"' : ''}>放弃开枪</button></div>`;
  }
  return `<div class="waiting">等待猎人开枪…</div>`;
}

function renderMorning() {
  let html = `<div class="panel-title">🌅 天亮了（第 ${view.dayNum} 天）</div>`;
  if (view.morningDeaths && view.morningDeaths.length === 0) html += `<div class="safe-night">昨夜平安无事</div>`;
  else if (view.morningDeaths) html += deathListHtml(view.morningDeaths, '昨夜死亡');
  html += `<div class="tip-text">请阅读公告。${view.morning.canContinue ? '点击继续进入白天流程。' : '等待房主继续…'}</div>`;
  if (view.morning.canContinue) html += `<div class="btn-row"><button class="primary" data-pd="doAdvance|">继续</button></div>`;
  return html;
}

function renderLastword() {
  const lw = view.lastword || {};
  let html = `<div class="panel-title">💬 遗言</div>`;
  const myEnt = lw.entitled && lw.entitled.find(e => e.id === view.my.id);
  if (myEnt && !myEnt.posted) {
    html += `<div class="panel-desc">你有一句遗言可以发表（仅一次）：</div>`;
    html += `<textarea id="lw-text" rows="3" placeholder="最后的遗言…" maxlength="200"></textarea>`;
    html += `<div class="btn-row"><button class="primary" data-pd="sendLastword|">发表遗言</button><button data-pd="act|skip">放弃遗言</button></div>`;
  } else {
    const wait = (lw.entitled || []).map(e => `${escapeHtml(e.name)}${e.posted ? ' ✅' : '…'}`).join('、');
    html += `<div class="waiting">等待遗言：${escapeHtml(wait)}</div>`;
  }
  if (lw.canAdvance) html += `<div class="btn-row"><button data-pd="doAdvance|">跳过遗言</button></div>`;
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
      `<button class="mini ${draft.target === p.id ? 'chosen' : ''}" data-pd="draftTarget|${p.id}">${escapeHtml(p.name)}</button>`
    ).join('') + `</div>`;
    html += `<div class="btn-row"><button class="primary" data-pd="handoverPick|" ${draft.target ? '' : 'disabled'}>移交警徽</button><button data-pd="actData|handover|{target:null}">撕毁警徽</button></div>`;
  } else {
    html += `<div class="waiting">${escapeHtml(h.fromName || '')} 正在处理警徽…</div>`;
  }
  if (h.canAdvance) html += `<div class="btn-row"><button data-pd="doAdvance|">跳过（撕毁）</button></div>`;
  return html;
}

function renderCampaign() {
  const c = view.campaign || {};
  let html = `<div class="panel-title">🗳️ 警长竞选 · 报名</div>`;
  html += `<div class="panel-desc">是否竞选警长？竞选者稍后接受全体投票（警长白天最后发言，投票计 1.5 票）。</div>`;
  if (!c.myDecided) {
    html += `<div class="btn-row"><button class="primary" data-pd="actData|campaign|{run:true}">我要竞选</button><button data-pd="actData|campaign|{run:false}">放弃</button></div>`;
  } else {
    html += `<div class="tip-text">✅ 你已做出选择</div>`;
  }
  html += `<div class="tip-text" style="margin-top:8px">报名进度：${c.progress}/${c.need}${c.candidates.length ? '　竞选者：' + c.candidates.map(x => escapeHtml(x.name)).join('、') : ''}</div>`;
  if (c.canAdvance) html += `<div class="btn-row"><button data-pd="doAdvance|">跳过报名</button></div>`;
  return html;
}

function renderSheriffVote() {
  const s = view.sheriffVote || {};
  let html = `<div class="panel-title">🗳️ 警长竞选 · 投票</div>`;
  html += `<div class="panel-desc">投给一名竞选者（或弃票）。</div>`;
  html += `<div class="tip-text">已选：${draft.target ? escapeHtml(nameOf(draft.target)) : '—'}</div>`;
  html += `<div class="btn-row">${s.candidates.map(p => `<button class="mini" data-pd="draftTarget|${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div>`;
  if (s.myVoted) html += `<div class="tip-text voted-ok">✅ 已投${s.myVote ? '：' + escapeHtml(nameOf(s.myVote)) : '（弃票）'}</div>`; // 投票确认条（15）
  else html += `<div class="btn-row"><button class="primary" data-pd="castVote|" ${draft.target ? '' : 'disabled'}>投票</button><button data-pd="castVoteLock|">弃票</button></div>`;
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
    html += `<div class="btn-row"><button class="primary" data-pd="act|startVote">进入放逐投票</button></div>`;
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
  html += `<div class="btn-row">${candidates.map(p => `<button class="mini" data-pd="draftTarget|${p.id}">${escapeHtml(p.name)}</button>`).join('')}</div>`;
  if (v.myVoted) html += `<div class="tip-text voted-ok">✅ 已投${v.myVote ? '：' + escapeHtml(nameOf(v.myVote)) : '（弃票）'}</div>`; // 投票确认条（15）
  else html += `<div class="btn-row"><button class="primary" data-pd="castVote|" ${draft.target ? '' : 'disabled'}>投票</button><button data-pd="castVoteLock|">弃票</button></div>`;
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
  if (p.canStartVote) html += `<div class="btn-row"><button class="primary" data-pd="act|startVote">开始 PK 投票</button></div>`;
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
  if (view.canRematch) html += `<div class="btn-row"><button id="btn-rematch" class="primary" data-pd="act|rematch">再来一局</button></div>`; // 脉冲（27）
  return html;
}

function campClass(c) {
  if (c === '好人') return 'good';
  if (c === '狼人') return 'wolf';
  if (c === '第三方' || c === '神眷者') return 'third';
  return '';
}
