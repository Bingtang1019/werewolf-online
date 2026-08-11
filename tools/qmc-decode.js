"use strict";
/* QMC 解密工具（mgg/mflac → ogg/flac） 用法见文件头注释 */
const fs = require('fs');
const path = require('path');

function makeSeedGenV1() {
  let x = -1, y = 8, dx = 1, index = -1;
  const seedMap = [
    [0x4a,0xd6,0xca,0x90,0x67,0xf7,0x52],
    [0x5e,0x95,0x23,0x9f,0x13,0x11,0x7e],
    [0x47,0x74,0x3d,0x90,0xaa,0x3f,0x51],
    [0xc6,0x09,0xd5,0x9f,0xfa,0x66,0xf9],
    [0xf3,0xd6,0xa1,0x90,0xa0,0xf7,0xf0],
    [0x1d,0x95,0xde,0x9f,0x84,0x11,0xf4],
    [0x0e,0x74,0xbb,0x90,0xbc,0x3f,0x92],
    [0x00,0x09,0x5b,0x9f,0x62,0x66,0xa1]
  ];
  return function next() {
    let ret; index++;
    if (x < 0) { dx = 1; y = (8 - y) % 8; ret = 0xc3; }
    else if (x > 6) { dx = -1; y = 7 - y; ret = 0xd8; }
    else { ret = seedMap[y] && seedMap[y][x]; }
    x += dx;
    if ((index === 0x8000) || ((index > 0x8000) && ((index + 1) % 0x8000 === 0))) return next();
    return ret;
  };
}

function decodeQmc(inputPath) {
  const buf = fs.readFileSync(inputPath);
  const len = buf.length;
  const out = Buffer.alloc(len);
  const tryV1 = () => { const g = makeSeedGenV1(); for (let i = 0; i < len; i++) out[i] = buf[i] ^ g(); return out; };
  const isOgg = (b) => b.length > 4 && b[0]===0x4f && b[1]===0x47 && b[2]===0x67 && b[3]===0x53;
  const isFlac = (b) => b.length > 4 && b[0]===0x66 && b[1]===0x4c && b[2]===0x61 && b[3]===0x43;
  const isMp3 = (b) => b.length > 2 && b[0]===0x49 && b[1]===0x44 && b[2]===0x33;
  let o = tryV1();
  if (isOgg(o) || isFlac(o) || isMp3(o)) return { buf: o, version: 1 };
  return { buf: o, version: 1, unrecognized: true };
}

const args = process.argv.slice(2);
if (args.includes('--selfcheck')) {
  const g1 = makeSeedGenV1(); const raw = Buffer.alloc(0x10000);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + 13) & 0xff;
  const enc = Buffer.alloc(raw.length); for (let i = 0; i < raw.length; i++) enc[i] = raw[i] ^ g1();
  const g2 = makeSeedGenV1(); const dec = Buffer.alloc(raw.length); for (let i = 0; i < enc.length; i++) dec[i] = enc[i] ^ g2();
  let same = true; for (let i = 0; i < raw.length; i++) if (raw[i] !== dec[i]) { same = false; break; }
  console.log('QMCv1 往返一致性:', same ? 'PASS' : 'FAIL');
  process.exit(same ? 0 : 1);
}
if (args.includes('--probe')) {
  const f = args[args.indexOf('--probe') + 1];
  if (!f) { console.log('用法: --probe <文件.mgg>'); process.exit(1); }
  const b = fs.readFileSync(f);
  console.log('文件大小:', b.length);
  console.log('前16字节 hex:', b.slice(0, 16).toString('hex'));
  console.log('ASCII:', b.slice(0, 16).toString('latin1'));
  process.exit(0);
}
if (args.includes('--dir')) {
  const dir = args[args.indexOf('--dir') + 1];
  const files = fs.readdirSync(dir).filter(f => /\.(mgg|mflac)$/i.test(f));
  if (!files.length) { console.log('目录下无 .mgg/.mflac:', dir); process.exit(0); }
  for (const f of files) {
    const src = path.join(dir, f);
    const dst = path.join(dir, f.replace(/\.(mgg|mflac)$/i, '.ogg'));
    const r = decodeQmc(src);
    fs.writeFileSync(dst, r.buf);
    console.log((r.unrecognized ? 'WARN ' : 'OK ') + f, '->', path.basename(dst), '(v' + r.version + ')' + (r.unrecognized ? ' 魔数未识别' : ''));
  }
  console.log('完成'); process.exit(0);
}
const input = args[0];
if (!input) { console.log('用法: node tools/qmc-decode.js <输入.mgg|mflac> [输出]'); process.exit(1); }
const output = args[1] || input.replace(/\.(mgg|mflac)$/i, '.ogg');
const r = decodeQmc(input);
fs.writeFileSync(output, r.buf);
console.log((r.unrecognized ? 'WARN ' : 'OK ') + input, '->', output, '(QMCv' + r.version + ')' + (r.unrecognized ? ' 输出魔数未识别——用 --probe 看文件头' : ''));
