# -*- coding: utf-8 -*-
# QQ音乐 mgg 录音器 GUI 版（v22 核心 + UI 开关）
# 用法：python qqmusic-recorder-gui.py
# 功能：自动查找 QQMusic 进程 → hook qmp_ov_read_float → 全自动批量转 WAV
# 说明：本地自用工具，不进 git 仓库。
import sys, os, time, struct, threading, queue
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

OUT = 'D:/Music/qqmusic-dump'
WAVDIR = os.path.join(OUT, 'wav')
os.makedirs(WAVDIR, exist_ok=True)

# ---------- frida 核心（v22 逻辑） ----------
JS = r'''
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
send({ type: 'log', msg: '核心就绪 rf=' + rfAddr + ' seek=' + seekAddr });
'''

# ---------- 录音器（frida 会话管理） ----------
class Recorder:
    def __init__(self, ui_q):
        self.ui_q = ui_q          # 线程安全队列 -> UI
        self.session = None
        self.script = None
        self.running = False
        self.lock = threading.Lock()

    def find_qqmusic(self):
        import frida
        dev = frida.get_local_device()
        for p in dev.enumerate_processes():
            if 'QQMusic' in p.name:
                return p.pid
        return None

    def on_msg(self, m, dd):
        try:
            if m.get('type') != 'send':
                return
            p = m['payload']
            t = p.get('type')
            if t == 'log':
                self.ui_q.put(('log', '[JS] ' + p.get('msg', '')))
            elif t == 'song-start':
                self.ui_q.put(('song', p.get('idx'), p.get('ch'), p.get('rate')))
            elif t == 'seek':
                self.ui_q.put(('log', '  [SEEK] ret=' + str(p.get('ret'))))
            elif t == 'step':
                self.ui_q.put(('log', '  [STEP] ' + str(p.get('s', ''))))
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
                self.ui_q.put(('saved', idx, samples, sec))
            elif t == 'err':
                self.ui_q.put(('log', '[ERR] #' + str(p.get('idx')) + ' ' + str(p.get('msg'))))
        except Exception as e:
            self.ui_q.put(('log', '[MSG-ERR] ' + repr(e)))

    def start(self):
        import frida
        with self.lock:
            if self.running:
                return
            pid = self.find_qqmusic()
            if pid is None:
                raise RuntimeError('未找到 QQMusic 进程（请先打开 QQ音乐）')
            self.session = frida.attach(pid)
            self.script = self.session.create_script(JS)
            self.script.on('message', self.on_msg)
            self.script.load()
            self.running = True
        self.ui_q.put(('log', '已连接 QQMusic (PID %d)。播放 mgg 即自动批量转换。' % pid))

    def stop(self):
        with self.lock:
            if not self.running:
                return
            try:
                if self.script:
                    self.script.unload()
                if self.session:
                    self.session.detach()
            except Exception as e:
                self.ui_q.put(('log', '[STOP-ERR] ' + repr(e)))
            self.script = None
            self.session = None
            self.running = False
        self.ui_q.put(('log', '已停止录音'))

# ---------- UI ----------
import tkinter as tk
from tkinter import scrolledtext

class App:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.rec = Recorder(self.q)
        self.saved_count = 0
        self.current_idx = 0

        root.title('QQ音乐 mgg 录音器 (v22-GUI)')
        root.resizable(False, False)

        # 状态行
        self.status = tk.StringVar(value='● 未运行')
        frm_top = tk.Frame(root, padx=10, pady=8)
        frm_top.pack(fill='x')
        tk.Label(frm_top, textvariable=self.status, font=('Microsoft YaHei', 11)).pack(side='left')

        self.btn = tk.Button(frm_top, text='▶ 开始录音', width=12, command=self.toggle,
                             font=('Microsoft YaHei', 10))
        self.btn.pack(side='right')

        # 统计行
        frm_stat = tk.Frame(root, padx=10)
        frm_stat.pack(fill='x')
        self.stat = tk.StringVar(value='已保存: 0 首 | 当前: - | 输出: ' + WAVDIR)
        tk.Label(frm_stat, textvariable=self.stat, fg='#555', font=('Microsoft YaHei', 9)).pack(anchor='w')

        # 日志区
        frm_log = tk.Frame(root, padx=10, pady=8)
        frm_log.pack(fill='both', expand=True)
        self.logbox = scrolledtext.ScrolledText(frm_log, width=72, height=16, state='disabled',
                                                font=('Consolas', 9))
        self.logbox.pack()

        root.protocol('WM_DELETE_WINDOW', self.on_close)
        self.root.after(100, self.poll)

    def log(self, msg):
        self.logbox.configure(state='normal')
        self.logbox.insert('end', time.strftime('%H:%M:%S ') + msg + '\n')
        self.logbox.see('end')
        self.logbox.configure(state='disabled')

    def poll(self):
        try:
            while True:
                item = self.q.get_nowait()
                t = item[0]
                if t == 'log':
                    self.log(item[1])
                elif t == 'song':
                    self.current_idx = item[1]
                    self.log('>> 开始转换第 %d 首 (ch=%s rate=%s)' % (item[1], item[2], item[3]))
                elif t == 'saved':
                    self.saved_count += 1
                    self.log('>> 已保存 auto_%02d.wav (样本=%d, %.1fs)' % (item[1], item[2], item[3]))
        except queue.Empty:
            pass
        self.stat.set('已保存: %d 首 | 当前: 第 %d 首 | 输出: %s' % (self.saved_count, self.current_idx, WAVDIR))
        self.root.after(100, self.poll)

    def toggle(self):
        if self.rec.running:
            self.btn.config(text='▶ 开始录音')
            self.status.set('● 已停止')
            threading.Thread(target=self.rec.stop, daemon=True).start()
        else:
            self.btn.config(text='■ 停止')
            self.status.set('● 连接中...')
            def _start():
                try:
                    self.rec.start()
                    self.root.after(0, lambda: self.status.set('● 录音中（播放 mgg 自动转换）'))
                except Exception as e:
                    self.root.after(0, lambda: self.status.set('● 启动失败'))
                    self.root.after(0, lambda: self.log('[启动失败] ' + repr(e)))
                    self.root.after(0, lambda: self.btn.config(text='▶ 开始录音'))
            threading.Thread(target=_start, daemon=True).start()

    def on_close(self):
        try:
            threading.Thread(target=self.rec.stop, daemon=True).start()
            time.sleep(0.3)
        except Exception:
            pass
        self.root.destroy()

if __name__ == '__main__':
    root = tk.Tk()
    App(root)
    root.mainloop()
