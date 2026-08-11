"use strict";
/* BGM 转码脚本：QQ音乐录音 wav（D:/Music/qqmusic-dump/wav）→ public/music/（24000Hz 单声道 16bit，浏览器原生播放）
 * 用法: node tools/music/convert-wav.js [源目录] [输出目录]
 * 依赖: qqmusic-dump 录音工具（tools/qqmusic-dump/——frida hook qmp_ogg.dll 抓 PCM 转 WAV）
 * 说明: 音频文件（public/music/*.wav）不入库（体积+版权）——克隆仓库后运行本脚本生成
 */
const fs = require('fs'), path = require('path');
const src = process.argv[2] || 'D:/Music/qqmusic-dump/wav';
const dst = process.argv[3] || path.join(__dirname, '..', '..', 'public', 'music');
fs.mkdirSync(dst, { recursive: true });
function compressWav(inPath, outPath, targetRate = 24000) {
  const b = fs.readFileSync(inPath);
  if (b.toString('latin1', 0, 4) !== 'RIFF') throw new Error('非 WAV: ' + inPath);
  const ch = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  let off = 12;
  while (off < b.length - 8) { const id = b.toString('latin1', off, off + 4); const sz = b.readUInt32LE(off + 4); if (id === 'data') break; off += 8 + sz; }
  if (off >= b.length - 8) throw new Error('无 data 块');
  const dataSize = b.readUInt32LE(off + 4), dataStart = off + 8;
  const bytesPerSample = bits / 8, nSamples = Math.floor(dataSize / (bytesPerSample * ch));
  const ratio = rate / targetRate, outSamples = Math.floor(nSamples / ratio);
  const outBuf = Buffer.alloc(outSamples * 2);
  const sampleAt = i => { const pos = dataStart + i * bytesPerSample * ch; let v = 0; for (let c = 0; c < ch; c++) v += b.readInt16LE(pos + c * bytesPerSample); return v / ch; };
  for (let i = 0; i < outSamples; i++) outBuf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sampleAt(Math.floor(i * ratio))))), i * 2);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + outBuf.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(targetRate, 24); hdr.writeUInt32LE(targetRate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(outBuf.length, 40);
  fs.writeFileSync(outPath, Buffer.concat([hdr, outBuf]));
  return { inMB: +(b.length / 1048576).toFixed(1), outMB: +(outBuf.length / 1048576).toFixed(1) };
}
const files = fs.readdirSync(src).filter(f => f.endsWith('.wav') && f.startsWith('auto_')).sort();
files.forEach((f, i) => {
  try {
    const r = compressWav(path.join(src, f), path.join(dst, 'bgm-' + String(i + 1).padStart(2, '0') + '.wav'));
    console.log('bgm-' + String(i + 1).padStart(2, '0') + '  ' + f + '  ' + r.inMB + 'MB → ' + r.outMB + 'MB ✓');
  } catch (e) { console.log(f, '❌', e.message); }
});
const EN_MAP = {
 "Boogie! (摇摆！) - Yung Bae.mp3": "Boogie-Yung-Bae.mp3",
 "RUSH HOUR - 角松敏生.mp3": "Rush-Hour-Toshiki-Kadomatsu.mp3",
 "Sailing To The Future - 小清水亜美.mp3": "Sailing-To-The-Future-Ami-Koshimizu.mp3",
 "YOUR EYES - 山下達郎.mp3": "Your-Eyes-Tatsuro-Yamashita.mp3",
 "お久しぶりね (好久不见) - 小柳留美子.mp3": "Ohisashiburine-Rumiko-Koyanagi.mp3",
 "ひとり上手 (习惯孤独) - 中岛美雪 (中島みゆき).mp3": "Hitori-Uwate-Miyuki-Nakajima.mp3",
 "トキヲ・ファンカ (东京不夜城) - takamatt.mp3": "Tokio-Funka-takamatt.mp3",
 "モニカ (莫妮卡) - 吉川晃司 (きっかわ こうじ).mp3": "Monica-Koji-Kikkawa.mp3",
 "人生のメリーゴーランド (人生的旋转木马) (Jazz Ver_) - 織田浩司 _ シエナ・ウインド・オーケストラ _ 久石让.mp3": "Jinsei-no-Merry-Go-Round-Jazz-Ver.mp3",
 "四季の歌 (四季的歌) - 芹洋子 (せり ようこ;伊东洋子).mp3": "Shiki-no-Uta-Yoko-Seri.mp3",
 "恋人も濡れる街角 (恋人沾湿的街角) (恋人也在被淋湿的街角、恋人沾湿的街角、淋湿恋人的街角) - 中村雅俊.mp3": "Koibito-mo-Nureru-Machikado-Masatoshi-Nakamura.mp3",
 "悲しい気持ち - 桑田佳祐.mp3": "Kanashii-Kimochi-Keisuke-Kuwata.mp3",
 "時の過ぎゆくままに (任时间流逝) (任时间流逝) (Single Version) - 沢田研二.mp3": "Toki-no-Sugiyuku-Mama-ni-Kenji-Sawada.mp3",
 "最愛 (最爱) - 柏原芳恵.mp3": "Saiai-Yoshie-Kashiwabara.mp3",
 "淋しい热帯鱼 (寂寞热带鱼) - Wink.mp3": "Samishii-Nettaigyo-Wink.mp3",
 "異邦人 (你到底是谁啊) (你到底是谁啊) - 久保田早紀.mp3": "Ihojin-Saki-Kubota.mp3",
 "翼をください (请给我翅膀) - 赤い鳥.mp3": "Tsubasa-o-Kudasai-Akai-Tori.mp3",
 "青いスタスィオン - 河合その子.mp3": "Aoi-Station-Sonoko-Kawai.mp3"
};
const WAV_EN = ['Morning-Lounge', 'Midnight-Suspense', 'Daylight-Tension', 'Ambience-04', 'Ambience-05', 'Ambience-06', 'Ambience-07'];

/* ===== 官方歌单清单生成（英文命名）：7 wav + D:/Music mp3 → playlist.json ===== */
function buildPlaylist(dst) {
  const pl = [];
  WAV_EN.forEach((en, i) => {
    if (fs.existsSync(path.join(dst, en + '.wav'))) pl.push({ id: 'off' + (i + 1), name: en.replace(/-/g, ' '), url: '/music/' + en + '.wav', src: 'official' });
  });
  const mp3Src = process.argv[4] || 'D:/Music';
  let mp3s = [];
  try { mp3s = fs.readdirSync(mp3Src).filter(f => /\.mp3$/i.test(f)).sort(); } catch (e) {}
  let n = pl.length;
  for (const f of mp3s) {
    const safe = EN_MAP[f] || ('song-' + String(++n).padStart(2, '0') + '.mp3');
    try { fs.copyFileSync(path.join(mp3Src, f), path.join(dst, safe)); } catch (e) { continue; }
    const name = EN_MAP[f] ? safe.replace(/\.mp3$/i, '').replace(/-/g, ' ') : f.replace(/\.mp3$/i, '');
    pl.push({ id: 'off' + pl.length + 1, name, url: '/music/' + safe, src: 'official' });
  }
  fs.writeFileSync(path.join(dst, 'playlist.json'), JSON.stringify(pl, null, 1), 'utf8');
  console.log('playlist.json:', pl.length, '首');
}
buildPlaylist(dst);

