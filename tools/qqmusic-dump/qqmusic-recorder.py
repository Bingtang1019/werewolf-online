#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qqmusic-recorder.py —— QQ音乐录音器 GUI（Frida hook，样式参考 SuzerainGUI）
================================================================
布局：顶部工具栏（输出目录/检测/高级）→ 左侧导航（录音控制/文件列表）+ 右侧卡片（状态/信息/输出）
      底部按钮栏（开始/停止/转BGM/打开目录）
依赖：frida（pip install frida frida-tools）
打包：pyinstaller --onefile --windowed --add-data "_hook_js.txt;." qqmusic-recorder.py
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
from tkinter import ttk, messagebox, filedialog

try:
    import frida
except ImportError:
    import tkinter.messagebox as mb
    root = tk.Tk(); root.withdraw()
    mb.showerror('缺少 frida', '请先安装:\nD:\\Python\\python.exe -m pip install frida frida-tools')
    sys.exit(1)

APP_VER = 'v1.0'
# 资源路径（打包后 sys._MEIPASS）
def res_path(name):
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_OUT = 'D:/Music/qqmusic-dump/wav'
JS = open(res_path('_hook_js.txt'), 'r', encoding='utf-8').read()

# ---------- 风格常量（参考 SuzerainGUI：浅色 WinForms） ----------
C_BG = '#F0F0F0'
C_CARD = '#FFFFFF'
C_BORDER = '#D0D0D0'
C_TEXT = '#1F1F1F'
C_SUB = '#666666'
C_BLUE = '#1E6FD9'
C_RED = '#C82828'
F_UI = ('Segoe UI', 9)
F_TITLE = ('Segoe UI', 10, 'bold')
F_BIG = ('Consolas', 20)
F_MONO = ('Consolas', 9)


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


def card(parent, title):
    """卡片：标题 + 白底内容框（SuzerainGUI 风格）"""
    outer = tk.Frame(parent, bg=C_BG)
    tk.Label(outer, text=title, bg=C_BG, fg=C_TEXT, font=F_TITLE, anchor='w').pack(fill='x', pady=(0, 4))
    body = tk.Frame(outer, bg=C_CARD, highlightbackground=C_BORDER, highlightthickness=1)
    body.pack(fill='x')
    return outer, body


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
        self.connected = False
        self.pid = None
        self.out_dir = DEFAULT_OUT

        root.title('QQ音乐录音器 %s（Frida hook）' % APP_VER)
        root.geometry('760x480')
        root.configure(bg=C_BG)
        root.minsize(700, 440)

        self._build_toolbar()
        self._build_body()
        self._build_bottom()
        self.refresh_file_list()
        self.update_loop()

    # ---------- 顶部工具栏 ----------
    def _build_toolbar(self):
        bar = tk.Frame(self.root, bg=C_BG)
        bar.pack(fill='x', padx=10, pady=(8, 4))
        tk.Label(bar, text='输出目录', bg=C_BG, font=F_UI).pack(side='left')
        self.var_out = tk.StringVar(value=self.out_dir)
        tk.Entry(bar, textvariable=self.var_out, font=F_UI, width=44).pack(side='left', padx=6)
        tk.Button(bar, text='…', font=F_UI, width=3, command=self.pick_out).pack(side='left')
        tk.Button(bar, text='刷新列表', font=F_UI, command=self.refresh_file_list).pack(side='left', padx=(8, 0))
        tk.Button(bar, text='检测QQ音乐', font=F_UI, command=self.detect).pack(side='left', padx=4)
        self.var_adv = tk.BooleanVar(value=False)
        tk.Checkbutton(bar, text='高级模式', variable=self.var_adv, bg=C_BG, font=F_UI,
                       command=self.toggle_adv).pack(side='left', padx=4)

    # ---------- 主体：左导航 + 右卡片 ----------
    def _build_body(self):
        body = tk.Frame(self.root, bg=C_BG)
        body.pack(fill='both', expand=True, padx=10, pady=4)

        # 左：树形导航
        left = tk.Frame(body, bg=C_CARD, highlightbackground=C_BORDER, highlightthickness=1)
        left.pack(side='left', fill='y', padx=(0, 8))
        self.tree = ttk.Treeview(left, show='tree', height=18)
        self.tree.pack(fill='both', expand=True, padx=2, pady=2)
        r1 = self.tree.insert('', 'end', text='录音控制', open=True)
        self.tree.insert(r1, 'end', text='连接状态')
        self.tree.insert(r1, 'end', text='开始 / 停止')
        r2 = self.tree.insert('', 'end', text='文件列表', open=True)
        self.file_root = r2
        r3 = self.tree.insert('', 'end', text='转码', open=True)
        self.tree.insert(r3, 'end', text='转 BGM（24kHz 单声道）')
        r4 = self.tree.insert('', 'end', text='帮助', open=True)
        self.tree.insert(r4, 'end', text='QQ音乐需保持运行')
        self.tree.insert(r4, 'end', text='仅支持 OGG（.mgg）')
        self.tree.bind('<<TreeviewSelect>>', self.on_tree_select)

        # 右：卡片区
        right = tk.Frame(body, bg=C_BG)
        right.pack(side='left', fill='both', expand=True)

        o1, b1 = card(right, '当前状态')
        o1.pack(fill='x', pady=(0, 8))
        self.lbl_conn = tk.Label(b1, text='未连接——点击「检测QQ音乐」或「开始录音」自动连接',
                                 bg=C_CARD, fg=C_SUB, font=F_UI, anchor='w', justify='left')
        self.lbl_conn.pack(fill='x', padx=10, pady=8)

        o2, b2 = card(right, '录音信息')
        o2.pack(fill='x', pady=(0, 8))
        self.lbl_timer = tk.Label(b2, text='00:00', bg=C_CARD, fg=C_TEXT, font=F_BIG, anchor='w')
        self.lbl_timer.pack(fill='x', padx=10, pady=(8, 0))
        self.lbl_meta = tk.Label(b2, text='未开始录音', bg=C_CARD, fg=C_SUB, font=F_UI, anchor='w')
        self.lbl_meta.pack(fill='x', padx=10, pady=(0, 8))

        o3, b3 = card(right, '输出文件')
        o3.pack(fill='x', pady=(0, 8))
        self.lbl_file = tk.Label(b3, text='（尚未生成）', bg=C_CARD, fg=C_SUB, font=F_MONO, anchor='w', justify='left')
        self.lbl_file.pack(fill='x', padx=10, pady=8)

        o4, b4 = card(right, '日志')
        o4.pack(fill='both', expand=True)
        self.log = tk.Text(b4, height=6, font=F_MONO, bg=C_CARD, fg=C_TEXT, relief='flat', borderwidth=0)
        self.log.pack(fill='both', expand=True, padx=6, pady=6)
        self.log.configure(state='disabled')

    # ---------- 底部按钮栏 ----------
    def _build_bottom(self):
        bar = tk.Frame(self.root, bg=C_BG)
        bar.pack(fill='x', padx=10, pady=(4, 10))
        self.btn_start = tk.Button(bar, text='● 开始录音', bg=C_BLUE, fg='white', font=('Segoe UI', 10, 'bold'),
                                   width=14, relief='flat', command=self.start)
        self.btn_start.pack(side='left')
        self.btn_stop = tk.Button(bar, text='■ 停止并保存', font=('Segoe UI', 10), width=14, state='disabled',
                                  relief='flat', command=self.stop)
        self.btn_stop.pack(side='left', padx=6)
        self.btn_conv = tk.Button(bar, text='转 BGM', font=('Segoe UI', 10), width=10, state='disabled',
                                  relief='flat', command=self.convert)
        self.btn_conv.pack(side='left', padx=(0, 6))
        tk.Button(bar, text='打开输出目录', font=('Segoe UI', 10), width=12, relief='flat',
                  command=self.open_dir).pack(side='left')

    # ---------- 事件 ----------
    def pick_out(self):
        d = filedialog.askdirectory(initialdir=self.out_dir)
        if d:
            self.out_dir = d.replace('\\', '/')
            self.var_out.set(self.out_dir)
            self.refresh_file_list()

    def toggle_adv(self):
        self.logmsg('高级模式: ' + ('开' if self.var_adv.get() else '关') + '（{ "channels", "rate", "calls" 调试日志}）')

    def detect(self):
        try:
            dev = frida.get_local_device()
            ts = [p for p in dev.enumerate_processes() if 'qqmusic' in p.name.lower()]
            if ts:
                self.pid = ts[0].pid
                self.lbl_conn.configure(text='✅ 已检测到 QQMusic.exe  pid=%d' % self.pid, fg='#1B7A1B')
                self.logmsg('QQMusic pid=%d' % self.pid)
            else:
                self.lbl_conn.configure(text='❌ 未检测到 QQMusic.exe——请先打开 QQ音乐', fg=C_RED)
        except Exception as e:
            self.lbl_conn.configure(text='❌ frida 错误: ' + str(e)[:80], fg=C_RED)

    def on_tree_select(self, ev):
        sel = self.tree.selection()
        if sel:
            txt = self.tree.item(sel[0], 'text')
            if txt.startswith('auto_'):
                p = os.path.join(self.out_dir, txt)
                if os.path.exists(p):
                    self.lbl_file.configure(text=p)
                    self.last_path = p
                    self.btn_conv.configure(state='normal')

    def refresh_file_list(self):
        for it in self.tree.get_children(self.file_root):
            self.tree.delete(it)
        try:
            files = sorted(f for f in os.listdir(self.out_dir) if f.endswith('.wav'))
        except FileNotFoundError:
            files = []
        for f in files:
            self.tree.insert(self.file_root, 'end', text=f)
        self.logmsg('文件列表: %d 个 wav' % len(files))

    def logmsg(self, s):
        self.log.configure(state='normal')
        self.log.insert('end', s + '\n')
        self.log.see('end')
        self.log.configure(state='disabled')

    def update_loop(self):
        while True:
            try:
                kind, payload, data = self.msgq.get_nowait()
            except queue.Empty:
                break
            if kind == 'hook-ok':
                self.connected = True
                self.lbl_conn.configure(text='✅ hook 就绪（qmp_ogg.dll!qmp_ov_read_float）', fg='#1B7A1B')
                self.logmsg('hook 就绪')
            elif kind == 'info':
                self.ch = payload['channels']
                self.rate = payload['rate']
                self.lbl_meta.configure(text='格式: %dch @ %dHz  |  0.0 MB' % (self.ch, self.rate))
                self.logmsg('格式 %dch @ %dHz' % (self.ch, self.rate))
            elif kind == 'pcm' and data:
                with self.lock:
                    self.chunks.append(bytes(data))
            elif kind == 'call' and self.var_adv.get():
                self.logmsg('call #%d ret=%d' % (payload['n'], payload['ret']))
            elif kind == 'pcm-err':
                self.logmsg('[ERR] ' + str(payload.get('msg'))[:150])
            elif kind == 'err':
                self.logmsg('[frida] ' + str(payload)[:150])
        if self.recording and self.t0:
            el = int(time.time() - self.t0)
            with self.lock:
                mb = sum(len(c) for c in self.chunks) / 1048576
            self.lbl_timer.configure(text='%02d:%02d' % (el // 60, el % 60))
            self.lbl_meta.configure(text='格式: %dch @ %dHz  |  %.1f MB' % (self.ch, self.rate, mb))
        self.root.after(200, self.update_loop)

    def on_message(self, msg, data):
        if msg['type'] == 'send':
            p = msg['payload']
            if isinstance(p, dict):
                self.msgq.put((p.get('type'), p, data))
            else:
                self.msgq.put(('js', str(p), None))
        else:
            self.msgq.put(('err', msg.get('description', str(msg)), None))

    def ensure_attached(self):
        if self.session:
            return True
        dev = frida.get_local_device()
        ts = [p for p in dev.enumerate_processes() if 'qqmusic' in p.name.lower()]
        if not ts:
            messagebox.showerror('未找到 QQ音乐', '请先打开 QQ音乐客户端（保持运行）')
            return False
        self.pid = ts[0].pid
        self.session = frida.attach(self.pid)
        self.script = self.session.create_script(JS)
        self.script.on('message', self.on_message)
        self.script.load()
        self.lbl_conn.configure(text='✅ 已连接 QQMusic pid=%d' % self.pid, fg='#1B7A1B')
        time.sleep(0.3)
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
            self.lbl_meta.configure(text='录音中——请在 QQ音乐播放歌曲…')
            self.logmsg('--- 开始录音 ---')
        except Exception as e:
            messagebox.showerror('启动失败', str(e))
            self.btn_start.configure(state='normal')

    def stop(self):
        self.recording = False
        with self.lock:
            raw = b''.join(self.chunks)
        if not raw:
            self.logmsg('⚠ 没有数据（确认 QQ音乐正在播放 OGG 格式、音量非静音）')
            self.lbl_meta.configure(text='未录到数据')
            self.btn_start.configure(state='normal')
            self.btn_stop.configure(state='disabled')
            return
        path = next_wav_path(self.out_dir)
        write_wav(path, raw, self.ch, self.rate)
        dur = len(raw) / (self.ch * 2 * self.rate)
        self.last_path = path
        self.lbl_file.configure(text=path)
        self.lbl_meta.configure(text='✅ 已保存 %.1f 秒 / %.1f MB' % (dur, len(raw) / 1048576))
        self.logmsg('保存: %s (%.1fs)' % (path, dur))
        self.btn_start.configure(state='normal')
        self.btn_stop.configure(state='disabled')
        self.btn_conv.configure(state='normal')
        self.refresh_file_list()

    def convert(self):
        try:
            node = os.path.join(ROOT, 'node.exe')
            if not os.path.exists(node):
                node = 'node'
            script = os.path.join(ROOT, 'tools', 'music', 'convert-wav.js')
            out = subprocess.run([node, script], cwd=ROOT, capture_output=True, text=True, timeout=300)
            self.logmsg((out.stdout or '').strip()[:1500] or '(无输出)')
            if out.returncode != 0:
                self.logmsg('转码错误: ' + (out.stderr or '')[:400])
            messagebox.showinfo('转 BGM 完成', '见日志输出\n输出: public/music/bgm-NN.wav')
        except Exception as e:
            messagebox.showerror('转码失败', str(e))

    def open_dir(self):
        try:
            os.makedirs(self.out_dir, exist_ok=True)
            os.startfile(self.out_dir.replace('/', '\\'))
        except Exception as e:
            messagebox.showerror('打开失败', str(e))


if __name__ == '__main__':
    root = tk.Tk()
    App(root)
    root.mainloop()
