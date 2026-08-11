# -*- coding: utf-8 -*-
# v20 全自动批量 v2：逐步日志定位 + const/let 修复
import sys, os, time, struct
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
OUT = 'D:/Music/qqmusic-dump'
LOG = os.path.join(OUT, 'hook22.log')
WAVDIR = os.path.join(OUT, 'wav')
os.makedirs(WAVDIR, exist_ok=True)
def log(msg):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(time.strftime('%H:%M:%S') + ' ' + msg + '\n')
    print(msg, flush=True)

PID = int('168880')
import frida

def on_msg(m, dd):
    try:
        if m.get('type') != 'send':
            return
        p = m['payload']
        t = p.get('type')
        if t == 'log':
            log('[JS] ' + p.get('msg', ''))
        elif t == 'song-start':
            log('[SONG] #' + str(p.get('idx')) + ' ch=' + str(p.get('ch')) + ' rate=' + str(p.get('rate')))
        elif t == 'seek':
            log('[SEEK] ' + str(p.get('ret')))
        elif t == 'step':
            log('[STEP] #' + str(p.get('idx')) + ' ' + p.get('s', ''))
        elif t == 'pcm':
            idx = p['idx']
            fn = os.path.join(WAVDIR, 'auto_%02d.pcm' % idx)
            with open(fn, 'ab') as f:
                f.write(dd)
        elif t == 'song-done':
            idx = p['idx']; samples = p['samples']; sec = p['sec']
            ch = p['ch']; rate = p['rate']
            pcm = os.path.join(WAVDIR, 'auto_%02d.pcm' % idx)
            wav = os.path.join(WAVDIR, 'auto_%02d.wav' % idx)
            if os.path.exists(pcm):
                data = open(pcm, 'rb').read()
                os.remove(pcm)
                n = len(data) // 2
                hdr = b'RIFF' + struct.pack('<I', 36 + n * 2) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, ch, rate, ch * rate * 2, 2, 16) + b'data' + struct.pack('<I', n * 2)
                open(wav, 'wb').write(hdr + data)
            log('[SAVED] auto_%02d.wav samples=%d (%.1fs) 耗时=%.2fs' % (idx, samples, samples / rate / ch, sec))
        elif t == 'err':
            log('[ERR] #' + str(p.get('idx')) + ' ' + str(p.get('msg')))
    except Exception as e:
        log('[MSG-ERR] ' + repr(e))

js = r'''
'use strict';
const rfAddr = Module.findExportByName('qmp_ogg.dll', 'qmp_ov_read_float');
const seekAddr = Module.findExportByName('qmp_ogg.dll', 'qmp_ov_time_seek');
let rf = null, seek = null;
try { rf = new NativeFunction(rfAddr, 'int', ['pointer', 'pointer', 'int', 'pointer']); } catch (e) { send({type:'err', msg:'rf构造: '+e}); }
try { seek = new NativeFunction(seekAddr, 'int', ['pointer', 'int64']); } catch (e) { send({type:'err', msg:'seek构造: '+e}); }
let curVf = null, busy = false, idx = 0;
let ch = 2, rate = 44100;
let pendBuf = null, pendLen = 0;
const SEND_EVERY = 100000;

function flush() {
  if (!pendBuf || pendLen === 0) return;
  const b = pendBuf.slice(0, pendLen);
  send({ type: 'pcm', idx: idx }, b.buffer);
  pendBuf = null; pendLen = 0;
}

function processSong(vf) {
  const t0 = Date.now();
  idx++;
  // 读 vorbis_info
  try {
    const vi = vf.add(0xAC).readPointer();
    const c2 = vi.add(4).readS32();
    const r2 = vi.add(8).readS32();
    if (c2 > 0 && c2 <= 8) ch = c2;
    if (r2 > 8000 && r2 < 192000) rate = r2;
  } catch (e) { send({type:'err', msg:'vi读取失败(用默认2/44100)'}); }
  send({ type: 'song-start', idx: idx, ch: ch, rate: rate });
  let sret = -99;
  try { sret = seek(vf, int64(0)); } catch (e) { send({type:'err', msg:'seek调用: '+e}); sret = -1; }
  send({ type: 'seek', ret: sret });
  if (sret !== 0) { send({ type: 'err', msg: 'seek失败, 放弃该曲' }); return; }
  const MAX = 4096;
  let pcmPtrs = null, ch0 = null, ch1 = null, bs = null;
  try {
    pcmPtrs = Memory.alloc(2 * 4);
    ch0 = Memory.alloc(MAX * 4);
    ch1 = Memory.alloc(MAX * 4);
    pcmPtrs.writePointer(ch0);
    pcmPtrs.add(4).writePointer(ch1);
    bs = Memory.alloc(4);
  } catch (e) { send({type:'err', msg:'alloc: '+e}); return; }
  send({ type: 'step', idx: idx, s: 'alloc-ok' });
  let total = 0;
  pendBuf = new Int16Array(SEND_EVERY * ch); pendLen = 0;
  let guard = 0;
  try {
    while (guard++ < 200000) {
      const got = rf(vf, pcmPtrs, MAX, bs);
      if (got <= 0) break;
      const a0 = new Float32Array(ch0.readByteArray(got * 4));
      const a1 = new Float32Array(ch1.readByteArray(got * 4));
      for (let i = 0; i < got; i++) {
        if (pendLen >= pendBuf.length) { flush(); pendBuf = new Int16Array(SEND_EVERY * ch); pendLen = 0; }
        let v = Math.max(-1, Math.min(1, a0[i]));
        pendBuf[pendLen++] = (v < 0) ? (v * 32768) | 0 : (v * 32767) | 0;
        if (ch > 1) {
          v = Math.max(-1, Math.min(1, a1[i]));
          pendBuf[pendLen++] = (v < 0) ? (v * 32768) | 0 : (v * 32767) | 0;
        }
      }
      total += got;
    }
  } catch (e) { send({type:'err', msg:'解码循环: '+e}); }
  flush();
  const sec = (Date.now() - t0) / 1000;
  send({ type: 'song-done', idx: idx, samples: total, sec: sec, ch: ch, rate: rate });
}

Interceptor.attach(rfAddr, {
  onEnter(args) {
    const vf = args[0];
    if (busy) { this.blocked = true; return; }
    if (curVf && vf.equals(curVf)) { this.blocked = false; return; }
    curVf = vf; busy = true; this.blocked = true;
    try { processSong(vf); } catch (e) { send({ type: 'err', msg: 'processSong: ' + e }); }
    busy = false;
  },
  onLeave(retval) {
    if (this.blocked) retval.replace(0);
  }
});
send({ type: 'log', msg: 'v22 ready rf=' + rfAddr + ' seek=' + seekAddr });
'''
try:
    session = frida.attach(PID)
    script = session.create_script(js)
    script.on('message', on_msg)
    script.load()
    log('READY attach=' + str(PID))
    import time as _t
    while True:
        _t.sleep(5)
except Exception as e:
    log('FATAL ' + repr(e))
