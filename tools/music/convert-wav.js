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
console.log('完成 →', dst);
