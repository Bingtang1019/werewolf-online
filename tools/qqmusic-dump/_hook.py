#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_hook.py —— QQ音乐 PCM 抓取（Frida hook qmp_ov_read_float）—— CLI 版
================================================================
原理：QQ音乐播放 .mgg/.ogg（OGG Vorbis）时调用 qmp_ogg.dll!qmp_ov_read_float
      解码输出 float32 PCM——在此处拦截 → 转 int16 → 写 WAV（无损，不经系统混音）

用法：
  python _hook.py                 # 按 Enter 停止
  python _hook.py --seconds 120   # 录 120 秒
  python _hook.py --out D:/Music/qqmusic-dump/wav

输出：auto_NN.wav（16bit 双声道，采样率随源——44.1k/48k）
"""
import argparse
import io
import os
import struct
import sys
import time
import threading

try:
    import frida
except ImportError:
    print('缺少 frida：请运行  D:\\Python\\python.exe -m pip install frida frida-tools')
    sys.exit(1)

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

JS_HOOK = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '_hook_js.txt'), 'r', encoding='utf-8').read()


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


def write_wav(path, raw_pcm, channels, rate):
    data = raw_pcm
    hdr = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE'
    hdr += b'fmt ' + struct.pack('<IHHIIHH', 16, 1, channels, rate,
                                 rate * channels * 2, channels * 2, 16)
    hdr += b'data' + struct.pack('<I', len(data))
    with open(path, 'wb') as f:
        f.write(hdr)
        f.write(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seconds', type=int, default=0, help='录音秒数（0=回车停止）')
    ap.add_argument('--out', default='D:/Music/qqmusic-dump/wav', help='输出目录')
    args = ap.parse_args()

    # 找 QQMusic
    dev = frida.get_local_device()
    targets = [p for p in dev.enumerate_processes() if 'qqmusic' in p.name.lower()]
    if not targets:
        print('❌ QQMusic 未运行——请先打开 QQ音乐客户端')
        sys.exit(1)
    pid = targets[0].pid
    print('QQMusic pid=%d，attach…' % pid)
    session = frida.attach(pid)

    info = {'channels': 2, 'rate': 44100, 'hook': False}
    chunks = []
    lock = threading.Lock()
    done = threading.Event()

    def on_message(msg, data):
        if msg['type'] != 'send':
            return
        p = msg['payload']
        if isinstance(p, dict):
            t = p.get('type')
            if t == 'hook-ok':
                info['hook'] = True
                print('✅ hook 就绪——现在播放歌曲即可录音')
            elif t == 'info':
                info['channels'] = p['channels']
                info['rate'] = p['rate']
                print('格式: %dch @ %dHz' % (p['channels'], p['rate']))
            elif t == 'pcm' and data:
                with lock:
                    chunks.append(bytes(data))
            elif t == 'call':
                print('  [call #%d ret=%d]' % (p['n'], p['ret']), flush=True)
            elif t == 'pcm-err':
                print('  [PCM ERR] ' + str(p.get('msg'))[:200], flush=True)

    script = session.create_script(JS_HOOK)
    script.on('message', on_message)
    script.load()
    time.sleep(0.5)
    if not info['hook']:
        print('⚠ hook 未确认（可能模块未加载）——继续监听')

    t0 = time.time()
    print('\n🎙 录音中（播放歌曲）…  按 Enter 停止' if args.seconds == 0 else '\n🎙 录音中（%d 秒）…' % args.seconds)

    if args.seconds > 0:
        while time.time() - t0 < args.seconds:
            time.sleep(0.5)
            n = sum(len(c) for c in chunks)
            print('\r  %ds  %dKB' % (int(time.time() - t0), n // 1024), end='', flush=True)
    else:
        try:
            input()
        except EOFError:
            time.sleep(3)

    with lock:
        raw = b''.join(chunks)
    ch = info['channels']
    rate = info['rate']
    if not raw:
        print('\n⚠ 没有录到数据——确认 QQ音乐正在播放（OGG 格式）、音量非静音')
        session.detach()
        return 1
    out = next_wav_path(args.out)
    write_wav(out, raw, ch, rate)
    size = os.path.getsize(out) / 1048576
    dur = len(raw) / (ch * 2 * rate)
    print('\n✅ 已保存: %s  (%.1fMB, %.1fs)' % (out, size, dur))
    print('   转 BGM: node tools/music/convert-wav.js')
    session.detach()
    return 0


if __name__ == '__main__':
    sys.exit(main())
