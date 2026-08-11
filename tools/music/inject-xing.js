const fs = require('fs');
const path = require('path');
// MP3 Xing/Info 头注入工具（v1.7.23）：给无 VBR 时长帧的 CBR mp3 注入 Xing 头——
// 浏览器 <audio> 播放大文件依赖时长元数据（无 Xing 需下载全量才能开始播放 = 等半分钟）
const BITRATES_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const SRATES = { 3: [44100,48000,32000], 2: [22050,24000,16000], 0: [11025,12000,8000] };
function injectXing(buf) {
  let off = 0;
  if (buf.slice(0, 3).toString() === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    off = 10 + size;
  }
  while (off + 4 < buf.length && (buf[off] !== 0xFF || (buf[off + 1] & 0xE0) !== 0xE0)) off++;
  if (off + 4 >= buf.length) return null;
  const hdr = buf.readUInt32BE(off);
  const version = (hdr >> 19) & 3, layer = (hdr >> 17) & 3, brIdx = (hdr >> 12) & 0xF, srIdx = (hdr >> 10) & 3, pad = (hdr >> 9) & 1;
  if (layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const kbps = BITRATES_L3[brIdx], sr = SRATES[version][srIdx];
  const sideInfo = version === 3 ? 32 : 17;
  const frameLen = Math.floor((version === 3 ? 144 : 72) * kbps * 1000 / sr) + pad;
  const dataStart = off + frameLen;
  let frames = 0, pos = dataStart, guard = 0;
  while (pos + 4 <= buf.length && guard < 100000) {
    if (buf[pos] === 0xFF && (buf[pos + 1] & 0xE0) === 0xE0) {
      const h2 = buf.readUInt32BE(pos), br2 = (h2 >> 12) & 0xF, pad2 = (h2 >> 9) & 1;
      if (br2 > 0 && br2 < 15) { const fl2 = Math.floor((version === 3 ? 144 : 72) * BITRATES_L3[br2] * 1000 / sr) + pad2; frames++; pos += fl2; guard++; continue; }
    }
    break;
  }
  if (frames === 0) frames = Math.floor((buf.length - dataStart) / frameLen);
  const xing = Buffer.alloc(120);
  xing.write('Xing', 0); xing.writeUInt32BE(0x3, 4);
  xing.writeUInt32BE(frames, 8); xing.writeUInt32BE(buf.length - off - 4, 12);
  const insertAt = off + sideInfo;
  return Buffer.concat([buf.slice(0, insertAt), xing, buf.slice(insertAt)]);
}
const dir = process.argv[2] || path.join(__dirname, '..', '..', 'public', 'music');
let done = 0, skip = 0, fail = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.mp3')) continue;
  const p = path.join(dir, f);
  const buf = fs.readFileSync(p);
  if (buf.includes('Xing') && buf.indexOf('Xing') > 10000) { skip++; continue; }
  const out = injectXing(buf);
  if (!out) { fail.push(f); continue; }
  fs.writeFileSync(p, out); done++;
}
console.log('✓ Xing 注入完成 | 成功:', done, '| 跳过:', skip, '| 失败:', fail.length);
if (fail.length) console.log('失败:', fail.join(', '));
