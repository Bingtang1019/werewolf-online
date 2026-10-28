#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
recorder-gui.py —— QQ音乐录音 GUI（Frida hook qmp_ov_read_float）
================================================================
- 自动 attach QQMusic，hook OGG 解码输出（qmp_ogg.dll!qmp_ov_read_float）
- 播放即录（PCM 无损抓取，不经系统混音）
- 停止后存 auto_NN.wav → 一键转 BGM（tools/music/convert-wav.js）
用法：python recorder-gui.py
依赖：frida（pip install frida frida-tools）
"""
import io
import os
import queue
import struct
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, messagebox

try:
    import frida
except ImportError:
    print('缺少 frida：D:\\Python\\python.exe -m pip install frida frida-tools')
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = 'D:/Music/qqmusic-dump/wav'
JS = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_hook_js.txt'), 'r', encoding='utf-8').read()


def next_wav_path(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    mx = 0
    for f in os.listdir(out_dir):
        if f.startswith('auto_') and f.endswith('.wav'):
            try:
                mx = max(mx, int(f[5:-4]))
            except ValueError:
                pass
    return os.path.join(out_dir, 'auto_%02d.wav' % (mx + 1))


def write_wav(path, raw, ch, rate):
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + len(raw)) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, ch, rate, rate * ch * 2, ch * 2, 16))
        f.write(b'data' + struct.pack('<I', len(raw)))
        f.write(raw)


class App:
    def __init__(self, root):
        self.root = root
        self.session = None
        self.script = None
        self.chunks = []
        self.lock = threading.Lock()
        self.recording = False
        self.t0 = None
        self.ch = 2
        self.rate = 44100
        self.msgq = queue.Queue()
        self.last_path = None

        root.title('QQ音乐录音器（Frida hook）')
        root.geometry('560x340')
        root.resizable(False, False)

        self.status = tk.Label(root, text='就绪——点击「开始」后在 QQ音乐播放歌曲', font=('Microsoft YaHei', 10, 'bold'), anchor='w')
        self.status.pack(fill='x', padx=14, pady=(12, 4))

        self.timer_lbl = tk.Label(root, text='00:00  |  0.0 MB', font=('Consolas', 20), anchor='w')
        self.timer_lbl.pack(fill='x', padx=14, pady=2)

        self.file_lbl = tk.Label(root, text='', fg='gray', anchor='w')
        self.file_lbl.pack(fill='x', padx=14, pady=2)

        btns = tk.Frame(root)
        btns.pack(fill='x', padx=14, pady=12)
        self.btn_start = tk.Button(btns, text='● 开始录音', bg='#c82828', fg='white', font=('Microsoft YaHei', 11), width=12, command=self.start)
        self.btn_start.pack(side='left', padx=(0, 8))
        self.btn_stop = tk.Button(btns, text='■ 停止并保存', font=('Microsoft YaHei', 11), width=12, state='disabled', command=self.stop)
        self.btn_stop.pack(side='left', padx=(0, 8))
        self.btn_conv = tk.Button(btns, text='转 BGM', font=('Microsoft YaHei', 10), width=10, state='disabled', command=self.convert)
        self.btn_conv.pack(side='left')

        self.log = tk.Text(root, height=7, font=('Consolas', 9), state='disabled')
        self.log.pack(fill='both', expand=True, padx=14, pady=(0, 12))

        self.update_loop()

    def logmsg(self, s):
        self.log.configure(state='normal')
        self.log.insert('end', s + '\n')
        self.log.see('end')
        self.log.configure(state='disabled')

    def update_loop(self):
        # 处理 frida 消息
        while True:
            try:
                item = self.msgq.get_nowait()
            except queue.Empty:
                break
            kind, payload, data = item
            if kind == 'hook-ok':
                self.logmsg('✅ hook 就绪')
            elif kind == 'info':
                self.ch = payload['channels']
                self.rate = payload['rate']
                self.logmsg('格式: %dch @ %dHz' % (self.ch, self.rate))
            elif kind == 'pcm' and data:
                with self.lock:
                    self.chunks.append(bytes(data))
            elif kind == 'pcm-err':
                self.logmsg('[ERR] ' + str(payload.get('msg'))[:150])
            elif kind == 'err':
                self.logmsg('[frida] ' + str(payload)[:150])
        # 计时
        if self.recording and self.t0:
            el = int(time.time() - self.t0)
            with self.lock:
                mb = sum(len(c) for c in self.chunks) / 1048576
            self.timer_lbl.configure(text='%02d:%02d  |  %.1f MB' % (el // 60, el % 60, mb))
        self.root.after(200, self.update_loop)

    def on_message(self, msg, data):
        if msg['type'] == 'send':
            p = msg['payload']
            if isinstance(p, dict):
                self.msgq.put((p.get('type'), p, data))
            else:
                self.msgq.put(('js', p, None))
        else:
            self.msgq.put(('err', msg.get('description', msg), None))

    def ensure_attached(self):
        if self.session:
            return True
        dev = frida.get_local_device()
        targets = [p for p in dev.enumerate_processes() if 'qqmusic' in p.name.lower()]
        if not targets:
            messagebox.showerror('未找到 QQ音乐', '请先打开 QQ音乐客户端再点开始')
            return False
        self.session = frida.attach(targets[0].pid)
        self.script = self.session.create_script(JS)
        self.script.on('message', self.on_message)
        self.script.load()
        time.sleep(0.4)
        return True

    def start(self):
        try:
            if not self.ensure_attached():
                return
            with self.lock:
                self.chunks = []
            self.recording = True
            self.t0 = time.time()
            self.btn_start.configure(state='disabled')
            self.btn_stop.configure(state='normal')
            self.btn_conv.configure(state='disabled')
            self.status.configure(text='🔴 录音中——在 QQ音乐播放你的歌')
            self.logmsg('--- 开始录音 ---')
        except Exception as e:
            messagebox.showerror('启动失败', str(e))
            self.btn_start.configure(state='normal')

    def stop(self):
        self.recording = False
        with self.lock:
            raw = b''.join(self.chunks)
        if not raw:
            self.logmsg('⚠ 没有数据（确认播放中且为 OGG 格式）')
            self.status.configure(text='未录到数据')
            self.btn_start.configure(state='normal')
            self.btn_stop.configure(state='disabled')
            return
        path = next_wav_path(OUT_DIR)
        write_wav(path, raw, self.ch, self.rate)
        dur = len(raw) / (self.ch * 2 * self.rate)
        self.last_path = path
        self.file_lbl.configure(text='输出: ' + path)
        self.status.configure(text='✅ 已保存 %.1fs / %.1fMB' % (dur, len(raw) / 1048576))
        self.logmsg('保存: %s (%.1fs)' % (path, dur))
        self.btn_start.configure(state='normal')
        self.btn_stop.configure(state='disabled')
        self.btn_conv.configure(state='normal')

    def convert(self):
        try:
            node = os.path.join(ROOT, 'node.exe')
            if not os.path.exists(node):
                node = 'node'
            script = os.path.join(ROOT, 'tools', 'music', 'convert-wav.js')
            out = subprocess.run([node, script], cwd=ROOT, capture_output=True, text=True, timeout=300)
            self.logmsg(out.stdout.strip()[:1500] or '(无输出)')
            if out.returncode != 0:
                self.logmsg('转码错误: ' + (out.stderr or '')[:500])
            messagebox.showinfo('转码完成', '见日志输出')
        except Exception as e:
            messagebox.showerror('转码失败', str(e))


if __name__ == '__main__':
    root = tk.Tk()
    App(root)
    root.mainloop()
