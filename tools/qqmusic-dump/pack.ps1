# ============================================================================
# pack.ps1 —— QQ音乐录音工具一键打包（2026-10-28）
# 输出: 桌面\QQ音乐录音工具包-YYYYMMDD.zip（含 exe + 全部源码 + 使用说明）
# 用法: powershell -ExecutionPolicy Bypass -File tools\qqmusic-dump\pack.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot) -Parent
$src = Join-Path $root 'tools\qqmusic-dump'
$stage = Join-Path $env:TEMP 'qqmusic-tools-pack'
$date = Get-Date -Format 'yyyyMMdd'
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) ("QQ音乐录音工具包-$date.zip")

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage 'qqmusic-dump') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'music-tools') -Force | Out-Null

# 录音工具
foreach ($f in @('qqmusic-recorder.py', '_hook.py', '_hook_js.txt', 'recorder-gui.py', 'recorder.ps1', 'README.md')) {
    $p = Join-Path $src $f
    if (Test-Path $p) { Copy-Item $p (Join-Path $stage 'qqmusic-dump\') -Force }
}
$exe = Join-Path $src 'dist\qqmusic-recorder.exe'
if (Test-Path $exe) { Copy-Item $exe (Join-Path $stage 'qqmusic-dump\qqmusic-recorder.exe') -Force }
else { Write-Warning 'exe 不存在——先运行 pyinstaller 打包' }

# 音乐工具三件套
$mt = Join-Path $root 'tools'
Copy-Item (Join-Path $mt 'music\convert-wav.js') (Join-Path $stage 'music-tools\') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $mt 'music\inject-xing.js') (Join-Path $stage 'music-tools\') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $mt 'qmc-decode.js') (Join-Path $stage 'music-tools\') -Force -ErrorAction SilentlyContinue

# 使用说明（内嵌——保证包里总有）
$readme = Join-Path $stage '使用说明.txt'
@'
================================================================
 QQ音乐录音工具包（Frida hook 版）
================================================================

【快速开始】
  1. 双击 qqmusic-dump\qqmusic-recorder.exe
  2. 打开 QQ音乐客户端（保持运行），播放任意歌曲（在线/离线均可）
  3. 点「检测QQ音乐」→「● 开始录音」
  4. 播完点「■ 停止并保存」→ D:/Music/qqmusic-dump/wav/auto_NN.wav
  5. 点「转 BGM」→ game/public/music/bgm-NN.wav（24kHz 单声道）

【环境】
  · exe 自带 Python，开箱即用
  · 源码版: Python 3.13 (D:\Python\python.exe) + frida
      D:\Python\python.exe -m pip install frida frida-tools

【文件】
  qqmusic-dump\qqmusic-recorder.exe   GUI 成品
  qqmusic-dump\qqmusic-recorder.py    GUI 源码
  qqmusic-dump\_hook.py               CLI 录音
  qqmusic-dump\_hook_js.txt           Frida hook 脚本（核心）
  qqmusic-dump\recorder.ps1           备用录音器（WASAPI，零依赖）
  music-tools\convert-wav.js          wav → 游戏 BGM
  music-tools\inject-xing.js          mp3 Xing 头注入
  music-tools\qmc-decode.js           QMCv1 解密（酷狗/酷我/咪咕）

【原理】
  hook qmp_ogg.dll!qmp_ov_read_float（libvorbis 解码输出）
  float32 PCM → int16（×0.85 防削波）→ WAV
  在线播放缓存为 OGG 后走同一解码器（支持）；FLAC 无损流需扩展

【常见问题】
  录到 0 字节: 确认在播放、非静音
  未找到 QQ音乐: 先启动客户端
  切歌变速: 停→换歌→重新开始
  杀毒误报: PyInstaller 打包的 exe 常见，加白名单
================================================================
'@ | Set-Content -Path $readme -Encoding UTF8

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$f = Get-Item $zip
Write-Host ("打包完成: " + $f.FullName + "  " + [math]::Round($f.Length / 1MB, 1) + "MB")
