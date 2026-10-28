# ============================================================================
# qqmusic-dump / recorder.ps1 —— QQ音乐 loopback 录音器（WASAPI，零第三方依赖）
# ----------------------------------------------------------------------------
# 背景：QQ音乐新版加密（QMCv2）无法用 qmc-decode.js 解密——改用"录播放声音"
#       方案：WASAPI loopback 抓系统播放流（QQ音乐输出）→ 16bit PCM WAV
# 兼容：输出 auto_NN.wav 到 D:/Music/qqmusic-dump/wav/ —— 与 tools/music/convert-wav.js 对接
# 依赖：Windows PowerShell 5.1 + .NET Framework（系统内置，无需安装）
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools/qqmusic-dump/recorder.ps1           # GUI
#   powershell -ExecutionPolicy Bypass -File tools/qqmusic-dump/recorder.ps1 -Cli 120  # 命令行录 120 秒
# ============================================================================
param(
  [switch]$Cli,
  [int]$Seconds = 0,
  [string]$OutDir = 'D:/Music/qqmusic-dump/wav'
)

$ErrorActionPreference = 'Stop'

# ---------- C# WASAPI loopback 录音核心 ----------
$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.IO;

public class WasapiLoopbackRecorder
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int stgmAccess, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        int GetBufferSize(out uint bufferFrames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint currentPadding);
        int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
        int GetMixFormat(out IntPtr ppDeviceFormat);
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr pData, out uint numFrames, out uint flags, out long devPosition, out ulong qpcPosition);
        int ReleaseBuffer(uint numFrames);
        int GetNextPacketSize(out uint numFrames);
    }

    private IAudioClient _client;
    private IAudioCaptureClient _capture;
    private Thread _thread;
    private volatile bool _running;
    private FileStream _raw;
    private int _channels;
    private int _sampleRate;
    private int _bitsPerSample;
    private bool _isFloat;
    private long _writtenBytes;
    private volatile string _status = "idle";

    public string Status { get { return _status; } }
    public long WrittenBytes { get { return Interlocked.Read(ref _writtenBytes); } }
    public int Channels { get { return _channels; } }
    public int SampleRate { get { return _sampleRate; } }

    public void Start(string rawPath)
    {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device); // eRender, eConsole
        if (hr != 0) throw new COMException("GetDefaultAudioEndpoint failed", hr);

        Guid iid = typeof(IAudioClient).GUID;
        object obj;
        hr = device.Activate(ref iid, 0x17, IntPtr.Zero, out obj); // CLSCTX_ALL = 0x17
        if (hr != 0) throw new COMException("Activate failed", hr);
        _client = (IAudioClient)obj;

        IntPtr pFormat;
        hr = _client.GetMixFormat(out pFormat);
        if (hr != 0) throw new COMException("GetMixFormat failed", hr);
        WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(pFormat, typeof(WAVEFORMATEX));
        _channels = fmt.nChannels;
        _sampleRate = (int)fmt.nSamplesPerSec;
        _bitsPerSample = fmt.wBitsPerSample;
        _isFloat = (fmt.wFormatTag == 3); // WAVE_FORMAT_IEEE_FLOAT
        if (fmt.wFormatTag == 0xFFFE && fmt.cbSize >= 22)
        {
            // WAVE_FORMAT_EXTENSIBLE：读 SubFormat GUID 判断是否 float
            IntPtr sub = IntPtr.Add(pFormat, 24); // WAVEFORMATEXTENSIBLE.SubFormat 偏移
            byte[] g = new byte[16];
            Marshal.Copy(sub, g, 0, 16);
            // IEEE_FLOAT GUID: 00000003-0000-0010-8000-00aa00389b71 (little endian 前4字节=03 00 00 00)
            if (g[0] == 0x03 && g[1] == 0x00 && g[2] == 0x00 && g[3] == 0x00) _isFloat = true;
        }

        // AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
        hr = _client.Initialize(0, 0x00020000, 10000000, 0, pFormat, IntPtr.Zero);
        if (hr != 0) throw new COMException("Initialize failed", hr);
        Marshal.FreeCoTaskMem(pFormat);

        Guid capIid = typeof(IAudioCaptureClient).GUID;
        object capObj;
        hr = _client.GetService(ref capIid, out capObj);
        if (hr != 0) throw new COMException("GetService failed", hr);
        _capture = (IAudioCaptureClient)capObj;

        _raw = new FileStream(rawPath, FileMode.Create, FileAccess.Write);
        _running = true;
        _status = "recording";
        hr = _client.Start();
        if (hr != 0) throw new COMException("Start failed", hr);

        _thread = new Thread(CaptureLoop);
        _thread.IsBackground = true;
        _thread.Start();
    }

    private void CaptureLoop()
    {
        byte[] conv = new byte[65536];
        while (_running)
        {
            uint packetSize;
            _capture.GetNextPacketSize(out packetSize);
            while (packetSize > 0)
            {
                IntPtr pData;
                uint numFrames;
                uint flags;
                long devPos;
                ulong qpcPos;
                _capture.GetBuffer(out pData, out numFrames, out flags, out devPos, out qpcPos);
                if (numFrames > 0)
                {
                    int bytesPerSample = _bitsPerSample / 8;
                    int total = (int)numFrames * _channels * bytesPerSample;
                    if (conv.Length < total) conv = new byte[total];
                    Marshal.Copy(pData, conv, 0, total);
                    if (_isFloat)
                    {
                        // float32 -> int16
                        int n = (int)numFrames * _channels;
                        byte[] outb = new byte[n * 2];
                        for (int i = 0; i < n; i++)
                        {
                            float f = BitConverter.ToSingle(conv, i * 4);
                            int v = (int)(f * 32767f);
                            if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
                            short s = (short)v;
                            outb[i * 2] = (byte)(s & 0xFF);
                            outb[i * 2 + 1] = (byte)((s >> 8) & 0xFF);
                        }
                        _raw.Write(outb, 0, outb.Length);
                        Interlocked.Add(ref _writtenBytes, outb.Length);
                    }
                    else
                    {
                        _raw.Write(conv, 0, total);
                        Interlocked.Add(ref _writtenBytes, total);
                    }
                }
                _capture.ReleaseBuffer(numFrames);
                _capture.GetNextPacketSize(out packetSize);
            }
            Thread.Sleep(10);
        }
    }

    public void Stop()
    {
        _running = false;
        if (_thread != null) { _thread.Join(2000); _thread = null; }
        try { if (_client != null) _client.Stop(); } catch (Exception) { }
        if (_raw != null) { _raw.Flush(); _raw.Close(); _raw = null; }
        _status = "stopped";
    }
}

public static class WavUtil
{
    public static void WriteWavHeader(string wavPath, string rawPcmPath, int channels, int sampleRate)
    {
        long dataSize = new FileInfo(rawPcmPath).Length;
        using (var w = new BinaryWriter(File.Create(wavPath)))
        {
            w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
            w.Write((uint)(36 + dataSize));
            w.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
            w.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
            w.Write((uint)16);
            w.Write((ushort)1);              // PCM
            w.Write((ushort)channels);
            w.Write((uint)sampleRate);
            w.Write((uint)(sampleRate * channels * 2));
            w.Write((ushort)(channels * 2)); // block align
            w.Write((ushort)16);             // bits
            w.Write(System.Text.Encoding.ASCII.GetBytes("data"));
            w.Write((uint)dataSize);
        }
        using (var w = new FileStream(wavPath, FileMode.Append, FileAccess.Write))
        using (var r = new FileStream(rawPcmPath, FileMode.Open, FileAccess.Read))
        {
            r.CopyTo(w);
        }
        File.Delete(rawPcmPath);
    }
}
'@

Write-Host '编译 WASAPI 录音类…'
Add-Type -TypeDefinition $cs -ReferencedAssemblies 'System.dll' -ErrorAction Stop
Write-Host '编译完成'

# ---------- 辅助：下一个 auto_NN.wav ----------
function Get-NextWavPath {
    param([string]$dir)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $max = 0
    Get-ChildItem -LiteralPath $dir -Filter 'auto_*.wav' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.BaseName -match '^auto_(\d+)$') { $n = [int]$Matches[1]; if ($n -gt $max) { $max = $n } }
    }
    $next = $max + 1
    return (Join-Path $dir ('auto_' + $next.ToString('00') + '.wav'))
}

if ($Cli) {
    # ---------- 命令行模式 ----------
    $wav = Get-NextWavPath $OutDir
    $raw = [System.IO.Path]::ChangeExtension($wav, '.pcm')
    $rec = New-Object WasapiLoopbackRecorder
    $rec.Start($raw)
    Write-Host ("开始录音: " + $wav + "  (设备 " + $rec.Channels + "ch @ " + $rec.SampleRate + "Hz)")
    $limit = if ($Seconds -gt 0) { $Seconds } else { 0 }
    $t0 = Get-Date
    try {
        while ($true) {
            Start-Sleep -Milliseconds 500
            $el = [int]((Get-Date) - $t0).TotalSeconds
            $mb = [math]::Round($rec.WrittenBytes / 1048576, 1)
            Write-Host ("`r录音中 " + $el + "s  " + $mb + "MB   ") -NoNewline
            if ($limit -gt 0 -and $el -ge $limit) { break }
        }
    } finally {
        $rec.Stop()
        [WavUtil]::WriteWavHeader($wav, $raw, $rec.Channels, $rec.SampleRate)
        $size = [math]::Round((Get-Item $wav).Length / 1048576, 1)
        Write-Host ("`n完成: " + $wav + "  (" + $size + "MB)")
    }
    exit 0
}

# ---------- GUI 模式 ----------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'QQ音乐 Loopback 录音器（WASAPI）'
$form.Size = New-Object System.Drawing.Size(520, 300)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(20, 20)
$lblStatus.Size = New-Object System.Drawing.Size(460, 24)
$lblStatus.Font = New-Object System.Drawing.Font('Microsoft YaHei', 10, [System.Drawing.FontStyle]::Bold)
$lblStatus.Text = '就绪——点击「开始录音」，然后在 QQ音乐播放想录的歌'
$form.Controls.Add($lblStatus)

$lblTime = New-Object System.Windows.Forms.Label
$lblTime.Location = New-Object System.Drawing.Point(20, 55)
$lblTime.Size = New-Object System.Drawing.Size(460, 28)
$lblTime.Font = New-Object System.Drawing.Font('Consolas', 18)
$lblTime.Text = '00:00  |  0.0 MB'
$form.Controls.Add($lblTime)

$lblFile = New-Object System.Windows.Forms.Label
$lblFile.Location = New-Object System.Drawing.Point(20, 95)
$lblFile.Size = New-Object System.Drawing.Size(460, 40)
$lblFile.ForeColor = [System.Drawing.Color]::DimGray
$lblFile.Text = ''
$form.Controls.Add($lblFile)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Location = New-Object System.Drawing.Point(20, 150)
$btnStart.Size = New-Object System.Drawing.Size(150, 44)
$btnStart.Text = '● 开始录音'
$btnStart.Font = New-Object System.Drawing.Font('Microsoft YaHei', 11)
$btnStart.BackColor = [System.Drawing.Color]::FromArgb(200, 40, 40)
$btnStart.ForeColor = [System.Drawing.Color]::White
$btnStart.FlatStyle = 'Flat'
$form.Controls.Add($btnStart)

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Location = New-Object System.Drawing.Point(190, 150)
$btnStop.Size = New-Object System.Drawing.Size(150, 44)
$btnStop.Text = '■ 停止并保存'
$btnStop.Font = New-Object System.Drawing.Font('Microsoft YaHei', 11)
$btnStop.Enabled = $false
$form.Controls.Add($btnStop)

$btnConvert = New-Object System.Windows.Forms.Button
$btnConvert.Location = New-Object System.Drawing.Point(360, 150)
$btnConvert.Size = New-Object System.Drawing.Size(130, 44)
$btnConvert.Text = '转 BGM'
$btnConvert.Font = New-Object System.Drawing.Font('Microsoft YaHei', 10)
$btnConvert.Enabled = $false
$form.Controls.Add($btnConvert)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Location = New-Object System.Drawing.Point(20, 210)
$lblHint.Size = New-Object System.Drawing.Size(470, 40)
$lblHint.ForeColor = [System.Drawing.Color]::Gray
$lblHint.Text = ('输出目录: ' + $OutDir + "`n录音文件名 auto_NN.wav —— 与 tools/music/convert-wav.js 兼容")
$form.Controls.Add($lblHint)

# 状态
$script:rec = $null
$script:t0 = $null
$script:wav = $null
$script:raw = $null
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 200

$script:timer.Add_Tick({
    if ($script:rec -and $script:rec.Status -eq 'recording') {
        $el = [int]((Get-Date) - $script:t0).TotalSeconds
        $mm = [int]([math]::Floor($el / 60)).ToString('00')
        $ss = ($el % 60).ToString('00')
        $mb = [math]::Round($script:rec.WrittenBytes / 1048576, 1)
        $lblTime.Text = ($mm + ':' + $ss + '  |  ' + $mb + ' MB')
    }
})

$btnStart.Add_Click({
    try {
        $script:wav = Get-NextWavPath $OutDir
        $script:raw = [System.IO.Path]::ChangeExtension($script:wav, '.pcm')
        $script:rec = New-Object WasapiLoopbackRecorder
        $script:rec.Start($script:raw)
        $script:t0 = Get-Date
        $lblStatus.Text = '录音中…（在 QQ音乐播放你的歌）'
        $lblFile.Text = '输出: ' + $script:wav
        $btnStart.Enabled = $false
        $btnStop.Enabled = $true
        $btnConvert.Enabled = $false
        $script:timer.Start()
    } catch {
        [System.Windows.Forms.MessageBox]::Show('录音启动失败: ' + $_.Exception.Message)
        $btnStart.Enabled = $true
    }
})

$btnStop.Add_Click({
    try {
        $script:timer.Stop()
        $rec0 = $script:rec
        $rec0.Stop()
        [WavUtil]::WriteWavHeader($script:wav, $script:raw, $rec0.Channels, $rec0.SampleRate)
        $size = [math]::Round((Get-Item $script:wav).Length / 1048576, 1)
        $lblStatus.Text = ('已保存 (' + $size + ' MB) —— 可以继续录下一首')
        $lblFile.Text = '输出: ' + $script:wav
        $btnStart.Enabled = $true
        $btnStop.Enabled = $false
        $btnConvert.Enabled = $true
        $script:rec = $null
    } catch {
        [System.Windows.Forms.MessageBox]::Show('停止失败: ' + $_.Exception.Message)
    }
})

$btnConvert.Add_Click({
    # 调用 convert-wav.js 转码（node 在项目根）
    try {
        $root = Split-Path (Split-Path $PSScriptRoot) -Parent
        $node = Join-Path $root 'node.exe'
        if (-not (Test-Path $node)) { $node = 'node' }
        $convScript = Join-Path $root 'tools/music/convert-wav.js'
        Start-Process -FilePath $node -ArgumentList ('"' + $convScript + '"') -WorkingDirectory $root -NoNewWindow -Wait
        [System.Windows.Forms.MessageBox]::Show('转码完成（见控制台输出）')
    } catch {
        [System.Windows.Forms.MessageBox]::Show('转码失败: ' + $_.Exception.Message)
    }
})

$form.Add_Shown({ $lblStatus.Text = '就绪——点击「开始录音」，然后在 QQ音乐播放想录的歌' })
[void]$form.ShowDialog()
