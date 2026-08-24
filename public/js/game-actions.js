// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

function alivePlayers() { return view.players.filter(p => p.alive); }

function focusPrimaryAction() {
  setTimeout(() => {
    const btn = document.querySelector('#panel .btn-row .primary:not([disabled])');
    if (btn) btn.focus({ preventScroll: false });
  }, 30);
}

function playerOf(id) { return view.players.find(p => p.id === id); }

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
  const data = { ids: [draft.target, draft.target2] };
  if (view.lover && view.lover.loverMode === 'v2') { // v2：权能槽二选一（必选）
    if (!draft.power) return toast('请先选择权能（守护/复仇）');
    data.power = draft.power;
  }
  return act('cupid_pick', data);
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
function onThirdWinMode(v) { act('settings', { thirdWinMode: v }); }

function onTieRule(v) { act('settings', { tieRule: v }); }

function onThief(v) { act('settings', { thief: v }); }

function kick(id) { api('api/kick', { room: roomId, token, target: id }).then(r => { if (r.error) toast(r.error); else { applyView(r.view); resetPollTimer(); render(); } }); }

function markCodeInvalid(msg) {
  const el = $('in-code');
  if (el) {
    el.classList.remove('valid');
    el.classList.add('invalid');
    setTimeout(() => el.classList.remove('invalid'), 500);
  }
  if (msg) toast(msg, 'err');
}

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

function diffPlayers() {
  const ids = new Set(view.players.map(p => p.id));
  if (prevPlayerIds) {
    for (const pid of prevPlayerIds) if (!ids.has(pid)) { const n = prevPlayerNames[pid]; if (n) toast(`🚪 ${n} 离开了房间`, 'sys'); }
    for (const p of view.players) if (!prevPlayerIds.has(p.id)) toast(`🟢 ${p.name} 加入了房间`, 'sys');
  }
  prevPlayerIds = ids;
  view.players.forEach(p => { prevPlayerNames[p.id] = p.name; });
}

function openRolePop() {
  const pop = $('role-pop');
  if (!pop || !view.my.role) return;
  $('rp-emoji').innerHTML = roleIconHtml(view.my.role) || '🎭';
  $('rp-name').textContent = view.my.role;
  $('rp-desc').textContent = SKILL_TEXT[view.my.roleKey] || '（暂无技能说明）'; // B1：my 无 desc 字段，改用全局技能文案
  const card = pop.querySelector('.rp-card');
  card.className = 'rp-card ' + (ROLE_CAMP_TEXT[view.my.role] || '');
  pop.classList.remove('hidden');
}

function closeRolePop() { const pop = $('role-pop'); if (pop) pop.classList.add('hidden'); }

function buildRulesList() {
  const el = $('rules-list'); if (!el) return;
  el.innerHTML = Object.keys(ROLE_NAMES).map(k =>
    `<div class="rules-item ${ROLE_CAMP[k] || ''}"><span class="ri-camp"></span><span>${roleIconHtml(k)} ${ROLE_NAMES[k]}：${SKILL_TEXT[k] || ''}</span></div>`
  ).join('');
  const rv = $('rules-view'); if (rv) rv.classList.remove('hidden');
}
