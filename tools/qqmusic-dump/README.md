# qqmusic-dump —— QQ音乐录音工具（WASAPI loopback，零第三方依赖）

## 背景

QQ音乐新版加密（QMCv2）无法用 `tools/qmc-decode.js` 解密（后者只支持 QMCv1——酷狗/酷我/咪咕的 mgg/mflac）。
本工具改用**录播放声音**方案：WASAPI loopback 抓系统播放流（QQ音乐输出）→ 16bit PCM WAV。

## 文件

```
tools/qqmusic-dump/
  recorder.ps1   录音器（GUI + CLI）——PowerShell 5.1 + C# WASAPI（系统内置，无需安装）
  README.md      本文档
```

## 用法

### GUI（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File tools/qqmusic-dump/recorder.ps1
```

1. 点击「● 开始录音」
2. 在 QQ音乐播放想录的歌
3. 点击「■ 停止并保存」
4. （可选）点击「转 BGM」→ 调用 `tools/music/convert-wav.js` 转成 24kHz 单声道

### CLI

```powershell
powershell -ExecutionPolicy Bypass -File tools/qqmusic-dump/recorder.ps1 -Cli 120
# 录 120 秒；不传 -Cli 则开 GUI
```

### 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `-Cli` | 命令行模式 | GUI |
| `-Seconds <n>` | CLI 录音秒数（0=手动 Ctrl+C） | 0 |
| `-OutDir <path>` | 输出目录 | `D:/Music/qqmusic-dump/wav` |

## 输出

- 文件名：`auto_NN.wav`（NN 自动递增，与 `tools/music/convert-wav.js` 兼容——它按 `auto_*.wav` 扫描）
- 格式：PCM 16bit / 双声道 / 48kHz（系统混音格式）
- 转 BGM：`node tools/music/convert-wav.js` → `public/music/bgm-NN.wav`（24kHz 单声道）

## 技术说明

- **WASAPI loopback**：`IMMDeviceEnumerator.GetDefaultAudioEndpoint(eRender)` → `IAudioClient.Initialize(AUDCLNT_STREAMFLAGS_LOOPBACK)` → `IAudioCaptureClient.GetBuffer` 循环
- **格式转换**：GetMixFormat 返回 WAVE_FORMAT_EXTENSIBLE（float32 48kHz 2ch）→ 录制时转 int16 PCM
- **零依赖**：PowerShell 5.1 + .NET Framework 内置（Windows 7+）
- **注意**：脚本文件必须保存为 **UTF-8 with BOM**（PowerShell 5.1 对中文路径的 UTF-8 无 BOM 会按 ANSI 误解码导致语法错误）

## 录音质量提示

- loopback 录的是「系统混音输出」——QQ音乐的音量、音效（均衡器/环绕）都会影响录音结果
- 建议：QQ音乐音量 70-80%（避免削波）、关闭音效增强
- 录音期间不要播放其他声音（会混入）
- 单曲录完后立即停止（文件按暂停/切歌不会自动分段——需手动）

## 与旧版工具的差异

旧版（已丢失）为 Python + frida hook `qmp_ogg.dll` 抓 PCM——需要 Python 环境 + frida 依赖。
新版为 PowerShell + WASAPI 原生录音——**零依赖，任何 Windows 7+ 可用**——但录的是系统输出（非无损解码）。
