# scripts/install-windows-shortcut.ps1 — 修正 MusicDedup 的 Windows 任务栏身份
#
# 背景：Windows 任务栏右键菜单里的「名称 + 图标」来自「与进程 AUMID 匹配的快捷方式(.lnk)」，
#   而不是 exe 版本资源（Electron issue #4241 与 Microsoft AppUserModelID 文档均已证实）。
#   dev 下直接跑 electron.exe 时，若 Start Menu 里残留指向该 exe 的快捷方式（例如本机曾经
#   出现的 "Electron.lnk"），Windows 就拿它的名字当应用名 → 任务栏右键显示「Electron」。
# 做法：
#   1) 删除指向本项目 electron.exe 的垃圾 "Electron.lnk"（仅限目标为本项目 exe，避免误删）。
#   2) 在 Start Menu 创建 "MusicDedup.lnk"（用 Squirrel.Windows 同款方法：内存中建 IShellLink →
#      cast 成 IPropertyStore 写入 System.AppUserModel.ID → IPersistFile.Save 落盘）：
#        - 图标 = assets/icon.ico（与 favicon/托盘/打包 exe 同源）
#        - 目标 = scripts/launch-dev.cmd（会先删除 ELECTRON_RUN_AS_NODE 再启动，规避本机坑）
#        - System.AppUserModel.ID = com.geekieo.musicdedup（与应用内 app.setAppUserModelId 一致）
#     于是任务栏右键/固定/通知均以「MusicDedup」身份呈现。
# 幂等：可重复执行。打包版（electron-builder）在别台机器上无需此脚本（exe 元数据已正确）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-windows-shortcut.ps1
# 注意：本文件为 UTF-8 带 BOM（PowerShell 5.1 无 BOM 会按 GBK 误读中文导致语法错误）。

$ErrorActionPreference = 'Stop'

# 所有路径由脚本自身位置推导，避免硬编码中文路径
$project   = Split-Path -Parent $PSScriptRoot
$exe       = Join-Path $project 'node_modules\electron\dist\electron.exe'
$ico       = Join-Path $project 'assets\icon.ico'
$launcher  = Join-Path $project 'scripts\launch-dev.cmd'
$startMenu = [Environment]::GetFolderPath('Programs')
$rogue     = Join-Path $startMenu 'Electron.lnk'
$lnkPath   = Join-Path $startMenu 'MusicDedup.lnk'
$AUMID     = 'com.geekieo.musicdedup'

# ── 1) 清理垃圾快捷方式（仅删目标为本项目 electron.exe 的 Electron.lnk）────────────
if (Test-Path $rogue) {
  $sh = New-Object -ComObject WScript.Shell
  $r  = $sh.CreateShortcut($rogue)
  if ([string]::Equals($r.TargetPath, $exe, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item $rogue -Force
    Write-Host "[ok] 已删除垃圾快捷方式: $rogue"
  } else {
    Write-Host "[skip] Electron.lnk 目标不是本项目 electron.exe，未删除（目标: $($r.TargetPath)）"
  }
}

# ── 2) 前置检查 ────────────────────────────────────────────────────────────────
if (-not (Test-Path $exe))      { Write-Error "找不到 electron.exe: $exe"; exit 1 }
if (-not (Test-Path $ico))      { Write-Error "找不到图标: $ico（先运行 npm run icons）"; exit 1 }
if (-not (Test-Path $launcher)) { Write-Error "找不到启动器: $launcher"; exit 1 }

# ── 3) 创建 MusicDedup.lnk + 写入 AppUserModel.ID（Squirrel.Windows 同款）─────────
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class ShortcutCreator {

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct WIN32_FIND_DATAW {
    public uint dwFileAttributes;
    public long ftCreationTime, ftLastAccessTime, ftLastWriteTime;
    public uint nFileSizeHigh, nFileSizeLow, dwReserved0, dwReserved1;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt;
    public ushort wReserved1, wReserved2, wReserved3;
    public IntPtr ptrVal; // VT_LPWSTR 指针位于偏移 8
  }

  [ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile {
    void GetClassID(out Guid pClassID);
    int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PropVariant pv);
    int SetValue(ref PROPERTYKEY key, ref PropVariant pv);
    int Commit();
  }

  // IShellLinkW（IID {000214F9-...}）—— 方法顺序即 COM vtable 顺序，不可变
  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out(), MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, ref WIN32_FIND_DATAW pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out(), MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out(), MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out(), MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short pwHotkey);
    void GetShowCmd(out uint piShowCmd);
    void SetShowCmd(uint piShowCmd);
    void GetIconLocation([Out(), MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hWnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046"), ClassInterface(ClassInterfaceType.None)]
  class CShellLink { }

  public static void Create(string lnkPath, string target, string workDir, string iconPath, int iconIndex, string description, string aumid) {
    IShellLinkW link = (IShellLinkW)new CShellLink();
    link.SetPath(target);
    link.SetWorkingDirectory(workDir);
    link.SetArguments("");
    if (!string.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, iconIndex);
    if (description != null) link.SetDescription(description);

    // System.AppUserModel.ID（{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}，pid=5）
    PROPERTYKEY pkey = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PropVariant pv = new PropVariant { vt = 31 /*VT_LPWSTR*/, ptrVal = Marshal.StringToCoTaskMemUni(aumid) };
    IPropertyStore ps = (IPropertyStore)link;
    int hr = ps.SetValue(ref pkey, ref pv);
    if (hr != 0) throw new Exception("SetValue(AppUserModel.ID) failed hr=" + hr.ToString("X8"));
    hr = ps.Commit();
    if (hr != 0) throw new Exception("Commit failed hr=" + hr.ToString("X8"));
    Marshal.FreeCoTaskMem(pv.ptrVal);

    ((IPersistFile)link).Save(lnkPath, true);
    Marshal.ReleaseComObject(link);
  }
}
"@

[ShortcutCreator]::Create($lnkPath, $launcher, $project, $ico, 0, 'MusicDedup', $AUMID)
Write-Host "[ok] 已创建: $lnkPath（名称/图标/AppUserModel.ID=$AUMID）"
Write-Host "完成：任务栏右键应显示 MusicDedup。若应用正在运行请重启；若仍显示 Electron，"
Write-Host "      是 Windows 缓存了旧名称，清掉 MuiCache 里 electron.exe 条目或重启一次即可。"
