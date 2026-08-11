import frida, time, os, struct
d = frida.get_local_device()
s = d.attach(182420)
WAVDIR = 'D:/Music/qqmusic-dump/wav/'
os.makedirs(WAVDIR, exist_ok=True)
JS = '''
'use strict';
const WAVDIR = 'D:/Music/qqmusic-dump/wav/';
let ch = 2, rate = 44100;
let curVf = null, fdata = null, fbytes = 0, seg = 0, calls = 0;
function closeFile(){
  if (!fdata || fbytes === 0) { fdata = null; fbytes = 0; return; }
  const vfs = curVf ? curVf.slice(-6) : 'x';
  try {
    const all = new Uint8Array(fbytes);
    let off = 0;
    for (const chunk of fdata) { all.set(chunk, off); off += chunk.length; }
    send({ type: 'wav', name: 'rec_' + Date.now() + '_' + vfs + '_s' + (seg++) + '.wav' }, all.buffer);
  } catch(e){ send({ type: 'err', msg: e.message }); }
  fdata = null; fbytes = 0;
}
try {
  const m = Process.findModuleByName('qmp_ogg.dll');
  const rf = m.getExportByName('qmp_ov_read_float');
  Interceptor.attach(rf, {
    onEnter: function(args){ this.vf = args[0]; this.buf = args[1]; },
    onLeave: function(retval){
      const got = retval.toInt32();
      calls++;
      if (calls % 1000 === 1) send({ type: 'log', msg: 'calls=' + calls });
      if (got <= 0) return;
      try {
        const vfs = this.vf.toString();
        if (curVf !== vfs) { closeFile(); curVf = vfs; fdata = []; fbytes = 0; }
        if (!fdata) return;
        const ptrs = this.buf.readPointer();
        const n = got * 4;
        const out = new ArrayBuffer(got * ch * 2);
        const dv = new DataView(out);
        for (let c = 0; c < ch; c++) {
          const p = ptrs.add(c * 4).readPointer();
          const fl = new Float32Array(p.readByteArray(n));
          for (let i = 0; i < got; i++) {
            let v = fl[i];
            if (v > 1) v = 1; if (v < -1) v = -1;
            dv.setInt16((i * ch + c) * 2, Math.round(v * 32767), true);
          }
        }
        fdata.push(new Uint8Array(out));
        fbytes += out.byteLength;
      } catch(e){}
    }
  });
  setInterval(function(){ if (fdata && fbytes > 0) closeFile(); }, 10000);
  send({ type: 'ready', msg: 'recorder v15 ready: rf=' + rf });
} catch(e){ send({ type: 'err', msg: e.message }); }
'''
def on_msg(m, dd):
    if m['type'] == 'send':
        p = m['payload']
        if isinstance(p, dict):
            if p.get('type') == 'wav':
                data = bytes(dd)
                n = len(data)
                h = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36+n, b'WAVE', b'fmt ', 16, 1, 2, 44100, 44100*2*2, 2*2, 16, b'data', n)
                fn = WAVDIR + p['name']
                with open(fn, 'wb') as f: f.write(h + data)
                print('WAV:', p['name'], (n/1024/1024), 'MB dur', n/44100/4, 's', flush=True)
            elif p.get('type') == 'log': print('LOG:', p['msg'], flush=True)
            elif p.get('type') == 'ready': print('READY:', p['msg'], flush=True)
            else: print('MSG:', p, flush=True)
        else: print('MSG:', str(p)[:100], flush=True)
sc = s.create_script(JS)
sc.on('message', on_msg)
sc.load()
try:
    while True: time.sleep(1)
except KeyboardInterrupt: pass