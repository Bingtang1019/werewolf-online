// 自动生成（client.js 拆分——勿手改，重新运行 tools/split-client.js）
// 依赖：core.js 先行加载

function musicAudio() {
    if (!musicState.audio) {
      musicState.audio = new Audio();
      // 切歌/换 src 后数据就绪再播放（流式响应下 load+立即 play 可能被拒）
      musicState.audio.addEventListener('canplay', () => {
        if (musicState.playing) {
          musicState.audio.play().catch(() => {});
        }
      });
      musicState.audio.addEventListener('ended', () => {
        // v1.7.25（房间全局播放）：房主播放完 → 广播切歌（全员同步）；跟随端等待房主广播
        const isHost = !!(window.__wwView && window.__wwView.my && window.__wwView.my.isHost);
        if (isHost) mpNext();
      });
      // 兜底：timeupdate 检测到播完但 ended 未触发（流式中断）→ 手动切
      musicState.audio.addEventListener('timeupdate', () => {
        const a = musicState.audio;
        if (a && isFinite(a.duration) && a.duration > 0 && a.currentTime >= a.duration - 0.3 && musicState.playing) {
          const isHost = !!(window.__wwView && window.__wwView.my && window.__wwView.my.isHost);
          if (isHost) mpNext(); // 房主播完广播切歌；跟随端等广播
        }
      });
    }
    return musicState.audio;
  }

  function toggleMusicPop() {
    const pop = $('music-pop');
    if (!pop) return;
    if (pop.classList.contains('hidden')) { renderMusicPop(); pop.classList.remove('hidden'); }
    else pop.classList.add('hidden');
  }

  function renderMusicPop() {
    const isHost = !!(window.__wwView && window.__wwView.my && window.__wwView.my.isHost);
    // 官方歌单
    const off = $('mp-official');
    off.innerHTML = musicState.list.filter(s => s.src === 'official').map(s => mpItemHtml(s)).join('');
    // 官方歌单二
    const off2 = $('mp-official2');
    if (off2) off2.innerHTML = musicState.list.filter(s => s.src === 'official2').map(s => mpItemHtml(s)).join('');
    // 官方歌单三
    const off3 = $('mp-official3');
    if (off3) off3.innerHTML = musicState.list.filter(s => s.src === 'official3').map(s => mpItemHtml(s)).join('');
    // 成员歌单
    const mem = musicState.list.filter(s => s.src === 'member');
    $('mp-member-cnt').textContent = mem.length ? mem.length + ' 首' : '空';
    $('mp-member').innerHTML = mem.length ? mem.map(s => mpItemHtml(s)).join('') : '<div class="mp-item" style="color:#9aa3b5">暂无成员点歌——点下方提交申请</div>';
    // 审批区（仅房主）
    $('mp-review-sec').style.display = isHost && musicState.reviews.length ? 'flex' : 'none';
    $('mp-review-cnt').textContent = musicState.reviews.length;
    $('mp-review').innerHTML = musicState.reviews.map(r =>
      `<div class="mp-item"><span class="mi-name" title="${r.url}">📥 ${r.note || '申请歌曲'}</span><span class="mi-src">${r.by}</span><span class="mi-act" data-review="${r.id}" data-act="ok">✅</span><span class="mi-act" data-review="${r.id}" data-act="no">❌</span></div>`
    ).join('') || '';
    // 当前播放
    updateMusicNow();
  }

  function mpItemHtml(s) {
    return `<div class="mp-item${musicState.idx === musicState.list.indexOf(s) && musicState.playing ? ' playing' : ''}" data-song="${s.id}">` +
      `<span class="mi-name">${s.playing ? '🔊 ' : ''}${s.name}</span><span class="mi-src">${s.src === 'official' ? '官方' : '成员'}</span><span class="mi-act" data-song="${s.id}" data-act="del">🗑</span></div>`;
  }

  function updateMusicNow() {
    const cur = musicState.idx >= 0 ? musicState.list[musicState.idx] : null;
    const a = musicState.audio;
    const d = cur && a && isFinite(a.duration) ? a.duration : (cur ? cur.dur : 1);
    const t = cur && a && isFinite(a.currentTime) ? a.currentTime : 0;
    $('mp-now-name').textContent = cur ? (musicState.playing ? '🔊 ' : '⏸ ') + cur.name : '未播放';
    $('mp-play').textContent = musicState.playing ? '⏸' : '▶';
    $('mp-bar').style.width = cur ? (Math.min(1, t / d) * 100).toFixed(1) + '%' : '0%';
  }

  function postMusic(action, data) {
  // v1.7.25（房间全局播放）：控制操作走服务端（room.music）→ bump → view 回传 → musicSync 全员同步执行
  if (!roomId || !token) return Promise.resolve(null);
  return fetch('api/music', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomId, token, action, data: data || {} })
  }).then(r => r.json()).then(j => {
    if (j.error) { toast(j.error); return null; }
    return j.music;
  }).catch(() => null);
}

function musicSync(v) {
  // v1.7.25（房间全局播放）：view.music 变化 → 统一执行（房主/跟随端同路径）
  const m = v && v.music;
  if (!m) return;
  const key = (m.cur ? m.cur.url : '') + '|' + (m.playing ? 1 : 0) + '|' + m.mode + '|' + m.list.length + '|' + m.reviews.length;
  const changed = key !== lastMusicKey;
  lastMusicKey = key;
  if (changed) {
    musicState.list = musicState.list.filter(s => s.src !== 'member');
    for (const s of m.list) musicState.list.push({ id: 'srv' + s.url.slice(-8), name: s.name, url: s.url, src: s.src || 'member' });
    musicState.reviews = (m.reviews || []).map(r => ({ id: r.id, url: r.url, name: r.name, from: r.from }));
    musicState.mode = m.mode;
    renderMusicPop();
  }
  const cur = m.cur ? (musicState.list.find(s => s.url === m.cur.url) || null) : null;
  if (changed && cur) {
    musicState.idx = musicState.list.indexOf(cur);
    if (m.playing && !musicState.playing) {
      mpPlayLocal(cur.id);
    } else if (!m.playing && musicState.playing) {
      musicState.playing = false;
      const a = musicAudio();
      if (a) { try { a.pause(); } catch (e) {} }
      if (musicState.timer) { clearInterval(musicState.timer); musicState.timer = null; }
      renderMusicPop();
    }
  }
  if (m.playing && m.ts && musicState.audio && isFinite(musicState.audio.currentTime)) {
    const serverProg = m.prog + (Date.now() - m.ts) / 1000;
    const local = musicState.audio.currentTime;
    if (serverProg > 0 && Math.abs(local - serverProg) > 3) {
      try { musicState.audio.currentTime = serverProg; } catch (e) {}
    }
  }
}

function pickSong(dir) {
  // v1.7.26：按当前模式选下一首（顺序/随机/单曲）——房主前端计算（官方歌单在前端）
  const list = musicState.list;
  if (!list.length) return null;
  if (musicState.mode === 2) return list[Math.max(0, musicState.idx)]; // 单曲循环
  if (musicState.mode === 1) {
    if (list.length <= 1) return list[0];
    let r = Math.floor(Math.random() * list.length);
    if (r === musicState.idx) r = (r + 1) % list.length;
    return list[r];
  }
  const n = list.length;
  const idx = musicState.idx < 0 ? 0 : (musicState.idx + (dir > 0 ? 1 : -1) + n) % n;
  return list[idx];
}

function mpNext() {
  const s = pickSong(1);
  if (s && s.url) postMusic('playAt', { url: s.url, name: s.name, src: s.src });
}

function mpPrev() {
  const s = pickSong(-1);
  if (s && s.url) postMusic('playAt', { url: s.url, name: s.name, src: s.src });
}

function mpToggle() {
  // v1.7.26：房主控制走服务端广播；跟随端由 musicSync 执行
  if (musicState.idx < 0) { if (musicState.list.length) mpPlay(musicState.list[0].id); return; }
  postMusic(musicState.playing ? 'pause' : 'play', {});
}

function mpSetMode(mode) {
  postMusic('mode', { mode });
}

function mpModeBtn() {
  const MODE_ICONS = ['🔀', '🔁', '🔂'];
  const b = $('mp-mode');
  if (b) b.textContent = MODE_ICONS[musicState.mode || 0];
}

function mpPlayLocal(sid) {
  const i = musicState.list.findIndex(s => s.id === sid);
  if (i < 0) return;
  musicState.idx = i;
  musicState.playing = true;
  const s = musicState.list[i];
  if (!s.url) { toast('该歌曲没有可用链接'); musicState.playing = false; updateMusicNow(); return; }
  const a = musicAudio();
  a.volume = (musicState.vol || 40) / 100;
  a.preload = 'none'; // v1.7.29（带宽优化）：none——播放时才按需 Range 拉取（渐进播；不预载全量，隧道不再被后台预载吃满）
  try {
    const abs = new URL(s.url, location.origin).href;
    if (a.src !== abs) { a.src = abs; a.currentTime = 0; a.load(); }
    else { a.currentTime = 0; }
    const tryPlay = () => {
      a.play().then(() => { musicState.playing = true; }).catch(err => {
        musicState.playing = false;
        console.warn('[music] 播放失败:', err && err.name, err && err.message, s.url);
        if (err && err.name === 'NotAllowedError') toast('浏览器阻止自动播放——请再点一次播放');
      });
    };
    if (a.readyState >= 2) tryPlay(); else { musicState.playing = true; a.play().catch(() => {}); }
  } catch (e) { musicState.playing = false; console.warn('[music] 播放异常:', e); }
  if (musicState.timer) clearInterval(musicState.timer);
  musicState.timer = setInterval(updateMusicNow, 500);
  renderMusicPop();
}

function mpPlay(sid) {
  // v1.7.26（房间全局播放）：点击歌曲 → 服务端广播（全员同步播放）——官方歌单/成员歌统一
  const i = musicState.list.findIndex(s => s.id === sid);
  if (i < 0) return;
  const song = musicState.list[i];
  if (!song.url) { toast('该歌曲没有可用链接'); return; }
  postMusic('playAt', { url: song.url, name: song.name, src: song.src });
}
