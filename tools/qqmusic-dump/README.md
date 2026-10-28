# qqmusic-dump —— QQ音乐录音工具（Frida hook，无损 PCM）

## 背景

QQ音乐新版加密（QMCv2）无法用 `tools/qmc-decode.js` 解密（后者只支持 QMCv1——酷狗/酷我/咪咕）。
本工具用 **Frida hook** 在 QQ音乐进程内抓取解码后的 PCM——**无损、不经系统混音**。

## 方案（主：Frida hook / 备：WASAPI 录音）

| 方案 | 文件 | 原理 | 音质 | 依赖 |
|---|---|---|---|---|
| **主：Frida hook** | `_hook.py` / `recorder-gui.py` + `_hook_js.txt` | hook `qmp_ogg.dll!qmp_ov_read_float`（libvorbis 解码输出） | **无损 PCM** | Python + frida |
| 备：WASAPI loopback | `recorder.ps1` | 录系统播放输出 | 重编码 | 零依赖（PS + .NET） |

**环境**（Frida 方案）：
- Python：`D:\Python\python.exe`（3.13）
- frida：`D:\Python\python.exe -m pip install frida frida-tools`（已装 17.24.3）

## 用法

### GUI（推荐）

```powershell
D:\Python\python.exe tools\qqmusic-dump\recorder-gui.py
```

1. 打开 QQ音乐（保持运行）
2. 点「● 开始录音」→ 播放歌曲
3. 点「■ 停止并保存」→ 生成 `D:/Music/qqmusic-dump/wav/auto_NN.wav`
4. 点「转 BGM」→ 调用 `tools/music/convert-wav.js` 生成 `public/music/bgm-NN.wav`

### CLI

```powershell
D:\Python\python.exe tools\qqmusic-dump\_hook.py                # 回车停止
D:\Python\python.exe tools\qqmusic-dump\_hook.py --seconds 120  # 录 120 秒
```

### 备用（无 Frida 环境时）

```powershell
powershell -ExecutionPolicy Bypass -File tools\qqmusic-dump\recorder.ps1        # GUI
powershell -ExecutionPolicy Bypass -File tools\qqmusic-dump\recorder.ps1 -Cli 120  # CLI
```

## 输出

- 文件名：`auto_NN.wav`（自动递增，与 `tools/music/convert-wav.js` 的 `auto_*` 扫描兼容）
- 格式：PCM 16bit / 双声道 / 源采样率（44.1k 或 48k，由 `qmp_ov_info` 读取）
- 转 BGM：`node tools/music/convert-wav.js` → 24kHz 单声道（浏览器原生播放）

## 技术细节（Frida hook）

```
hook 点：qmp_ogg.dll!qmp_ov_read_float
  签名：long qmp_ov_read_float(vorbis_dsp_state *vf, float ***pcm_channels, int samples, int *bitstream)
  时机：onLeave（解码完成）—— pcm_channels 为输出（float** 每声道指针数组）
  格式：qmp_ov_info(vf, -1) 返回 vorbis_info* {version, channels, rate, ...}
  转换：float32 → int16（×0.85 防削波——QQ音乐输出常近满幅）
```

**已验证**：
- QQMusic 32 位进程（ia32），Frida 17 x64 可跨架构 attach
- 播放 OGG（.mgg）时 `qmp_ov_read_float` 稳定触发（5 分钟 ~22k 次调用）
- 10 秒录音 = 1.8MB WAV（44100×2ch×2bytes×10.5s 精确匹配），非零率 100%
- FLAC（.mflac）走 `qmp_flac.dll!DecodeFlac`（当前未接——如需支持可扩展）

## 已知限制

- **仅 OGG 格式（.mgg）**——FLAC（.mflac）需另 hook `qmp_flac.dll`
- 录制中切换歌曲不会自动分段（一次录一首，或手动停止后再录）
- QQ音乐版本升级可能改变 `qmp_ogg.dll` 的导出（届时需重新探测）
- 录音文件不入库（`.gitignore`: `tools/qqmusic-dump/*.wav|*.pcm`）

## GUI（exe 版）

```
tools/qqmusic-dump/dist/qqmusic-recorder.exe   # 双击运行（67MB，含 frida 运行时）
```

- 界面样式参考 SuzerainGUI：顶部工具栏（输出目录/刷新/检测/高级模式）→ 左侧树导航 + 右侧卡片（状态/录音信息/输出文件/日志）→ 底部按钮栏（开始/停止/转BGM/打开目录）
- 首次运行需 QQ音乐已启动；「检测QQ音乐」确认 pid
- 重新打包：
  ```powershell
  cd tools/qqmusic-dump
  D:\Python\Scripts\pyinstaller.exe --onefile --windowed --name qqmusic-recorder ^
    --add-data "C:\Users\dell\Desktop\狼人杀在线版 1.0.0\tools\qqmusic-dump\_hook_js.txt;." ^
    --distpath dist --workpath build --specpath build qqmusic-recorder.py
  ```
- 打包产物（dist/ build/ *.spec）不入库（.gitignore）

## 在线 / 离线播放

**两种都支持，无需区分**（2026-10-28 实测）：

| 场景 | 解码路径 | 实测 |
|---|---|---|
| 离线（本地 .mgg） | qmp_ogg.dll!qmp_ov_read_float | ✅ 10s 录音 1.8MB，非零 100% |
| **在线（流媒体）** | **同一路径**（QQ音乐缓存为 OGG 后解码） | ✅ **15s 录音 2.6MB，非零 100%** |

- 6 分钟多格式探测：ogg 31,744 次调用 / flac 0 / MP3-AAC 未加载 —— 在线流统一走 OGG 解码
- 切歌时若采样率变化会提示（WAV 头按首帧格式写——建议单曲录制：停→换歌→再开始）
- FLAC 无损在线流（SQ/Hi-Res）若走 qmp_flac.dll 则当前不支持（需扩展 DecodeFlac hook）