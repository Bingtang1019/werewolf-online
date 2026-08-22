// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

function lessMotion() { return document.body.classList.contains('less-motion'); }

function toggleLessMotion(on) {
  document.body.classList.toggle('less-motion', !!on);
  try { localStorage.ww_less_motion = on ? '1' : '0'; } catch (e) {}
}

function applyHighContrast() {
  const on = localStorage.lwContrast === '1';
  document.body.classList.toggle('high-contrast', on);
}

function toggleHighContrast() {
  const on = !document.body.classList.contains('high-contrast');
  document.body.classList.toggle('high-contrast', on);
  try { localStorage.lwContrast = on ? '1' : '0'; } catch (e) {}
  toast(on ? '🔆 高对比度已开启' : '🔆 高对比度已关闭');
}

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

function showNetBanner() { const b = $('net-banner'); if (b) b.classList.remove('hidden'); }

function hideNetBanner() { const b = $('net-banner'); if (b) b.classList.add('hidden'); }

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

const timeline = [];
let lastTimelineVoteKey = '';

function collectStats(v) {
  if (!v) return;
  // 夜晚死亡（morning 阶段下发）
  if (v.phase === 'morning' && v.morningDeaths && v.morningDeaths.length) {
    const key = v.nightNum + ':m';
    if (!statSeen[key]) {
      statSeen[key] = true;
      stat.deaths.push({ night: v.nightNum, names: v.morningDeaths.map(d => d.name) });
      timeline.push({ type: 'death', night: '第' + v.nightNum + '夜', text: v.morningDeaths.map(d => d.name).join('、') });
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
      timeline.push({ type: 'exile', night: '第' + v.dayNum + '天', text: v.dayDeaths.map(d => d.name).join('、') + ' 出局' });
    }
  }
  // 投票结果时间线
  if (v.lastVoteResult && v.lastVoteResult.result) {
    const lv = v.lastVoteResult;
    const key = JSON.stringify({ r: lv.result, e: lv.exiled, t: lv.tied, k: lv.kind });
    if (key !== lastTimelineVoteKey) {
      lastTimelineVoteKey = key;
      const txt = lv.result === 'exile' ? (lv.exiled ? nameOf(lv.exiled) + ' 被放逐' : '有人被放逐') : lv.result === 'elected' ? (lv.exiled ? nameOf(lv.exiled) + ' 当选警长' : '警长当选') : lv.result === 'tie' ? '平票' : '无人出局';
      timeline.push({ type: 'vote', night: '第' + v.dayNum + '天', text: txt });
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
  timeline.length = 0; lastTimelineVoteKey = '';
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

function ambientFx() {
  if (!view || view.phase === 'lobby' || view.phase === 'reveal' || view.phase === 'ended') return;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (view.phase === 'night') {
    spawnFx('☄️', 'fx-meteor', { left: vw * (0.5 + Math.random() * 0.45), top: vh * (0.05 + Math.random() * 0.25), '--fx': `translate(${-vw * 0.45}px, ${vh * 0.32}px)` });
  } else {
    spawnFx('✨', 'fx-sun', { left: vw * (0.1 + Math.random() * 0.8), top: vh * 0.7, '--fx': `translate(0, ${-vh * 0.35}px)` });
  }
}

function setFontScale(k) {
  const scale = [0.9, 1, 1.12][k] || 1;
  document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
  try { localStorage.ww_font = String(k); } catch (e) {}
}

function setBotLevel(lv) {
  if (lv !== 'idle' && lv !== 'easy' && lv !== 'smart' && lv !== 'simulate') return;
  botLevelChoice = lv;
  renderPanel();
}

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

function sheriffPop(id) {
  const mark = document.querySelector(`.player[data-id="${id}"] .sheriff-mark`);
  if (mark && mark.animate && !lessMotion()) mark.animate(
    [{ transform: 'scale(0)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }],
    { duration: 480, easing: 'ease-out' }
  );
}

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

function lockButton(b) {
  if (b.dataset.busyLock) return;
  b.dataset.busyLock = '1';
  const orig = b.disabled;
  b.disabled = true;
  setTimeout(() => { if (b.isConnected) b.disabled = orig; delete b.dataset.busyLock; }, 650);
}

function ensureAudio() { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC && AC.state === 'suspended') AC.resume(); } catch (e) {} }

function setTTS(on) {
  ttsOn = !!on;
  try { localStorage.ww_tts = ttsOn ? '1' : '0'; } catch (e) {}
  if (!ttsOn && 'speechSynthesis' in window) { try { window.speechSynthesis.cancel(); } catch (e) {} }
  if (typeof renderSoundPop === 'function') renderSoundPop(); // v1.6.3：同步声音面板勾选状态
}

function speak(text) {
  if (!ttsOn || !text || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = 0.95; u.pitch = 0.9;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

function askNotify() {
  if (notifyAsked) return;
  notifyAsked = true;
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
}

function notifyTurn(body) {
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('🐺 轮到你行动了', { body: body || '请查看你的回合' }); } catch (e) {}
}

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

function sfxWolf() { if (!sfxFlags.wolf) return; ensureAudio(); tone(150, 1.0, 'sawtooth', 0.16, 0, 65); tone(152, 1.0, 'sawtooth', 0.10, 0.16, 68); }

function sfxMorning() { if (!sfxFlags.morning) return; ensureAudio(); [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.9, 'sine', 0.08, i * 0.12)); }

function sfxTick() { if (!sfxFlags.tick) return; ensureAudio(); tone(1250, 0.06, 'square', 0.06, 0, 700); }

function sfxHeavy() { if (!sfxFlags.heavy) return; ensureAudio(); tone(130, 0.5, 'sine', 0.28, 0, 55); noiseBurst(0.24, 0.15, 520, 0); }

function sfxFlip() { if (!sfxFlags.flip) return; ensureAudio(); noiseBurst(0.14, 0.12, 2400, 0); }

function sfxEnter() { if (!sfxFlags.enter) return; tone(660, .12, 'sine', .05, 0); tone(990, .16, 'sine', .05, .09); }

function setSfxMaster(on) {
  sfxOn = !!on;
  try { localStorage.ww_sfx = sfxOn ? '1' : '0'; } catch (e) {}
  document.querySelectorAll('.js-sound-btn').forEach(el => { el.textContent = sfxOn ? '🔊' : '🔇'; }); // v1.7.17：首页/顶栏双入口同步
  if (sfxOn) { ensureAudio(); sfxTick(); }
  renderSoundPop();
}

function setSfxFlag(key, on) {
  if (!(key in sfxFlags)) return;
  sfxFlags[key] = !!on;
  try { localStorage.ww_sfx_flags = JSON.stringify(sfxFlags); } catch (e) {}
  renderSoundPop();
}

function renderSoundPop() {
  const ids = { 'sp-master': sfxOn, 'sp-wolf': sfxFlags.wolf, 'sp-morning': sfxFlags.morning, 'sp-tick': sfxFlags.tick, 'sp-heavy': sfxFlags.heavy, 'sp-flip': sfxFlags.flip, 'sp-enter': sfxFlags.enter, 'sp-tts': ttsOn };
  for (const id of Object.keys(ids)) { const el = $(id); if (el) el.checked = ids[id]; }
}

function toggleSoundPop() {
  const pop = $('sound-pop');
  if (!pop) return;
  if (pop.classList.contains('hidden')) { renderSoundPop(); pop.classList.remove('hidden'); }
  else pop.classList.add('hidden');
}
