<#
.SYNOPSIS
  在全局 Windows 命名互斥锁 PTCGMobileDeviceValidation 下运行设备验证命令。

.DESCRIPTION
  MuMu 模拟器实例是共享资源：T15（#16）与并行进行的卡组票（#6）必须互斥使用。
  调用方在发起任何设备动作（adb install、am 启动、CDP 连接等）之前先运行本脚本；
  脚本取得全局命名互斥锁后才执行命令，命令结束或异常时在 finally 中释放。

  另一个持有者仍在运行时，脚本立即（默认 5 秒超时）以退出码 75 返回并打印
  DEVICE_MUTEX_BUSY；不会轮询等待，也不会杀死任何进程。调用方应完成所有非设备
  工作后报告“设备阶段待续”，交还管理器在锁空闲时恢复。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/device-validation/invoke-with-device-mutex.ps1 `
    -WorkingDirectory . -CommandLine "node .toolchain/issue16-run/device/device-image-cache-acceptance.mjs"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandLine,

  [string]$WorkingDirectory = (Get-Location).Path,

  [int]$TimeoutSeconds = 5,

  [string]$MutexName = 'Global\PTCGMobileDeviceValidation'
)

$ErrorActionPreference = 'Stop'

$mutex = $null
$acquired = $false
try {
  $mutex = New-Object System.Threading.Mutex($false, $MutexName)
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
  }
  catch [System.Threading.AbandonedMutexException] {
    # 上一个持有者异常退出，系统把锁判给我们；继续执行即可。
    Write-Output "DEVICE_MUTEX_ACQUIRED name=$MutexName pid=$PID (previous holder abandoned)"
    $acquired = $true
  }

  if (-not $acquired) {
    Write-Output "DEVICE_MUTEX_BUSY name=$MutexName; another device stage holds the lock. No device action was performed."
    exit 75
  }

  if ($acquired) {
    Write-Output "DEVICE_MUTEX_ACQUIRED name=$MutexName pid=$PID"
  }

  Push-Location -LiteralPath $WorkingDirectory
  try {
    & cmd.exe /d /s /c $CommandLine
    $exitCode = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }

  Write-Output "DEVICE_STAGE_EXIT=$exitCode"
  exit $exitCode
}
finally {
  if ($acquired -and $null -ne $mutex) {
    try {
      $mutex.ReleaseMutex()
    }
    catch {
      Write-Output "DEVICE_MUTEX_RELEASE_WARNING=$($_.Exception.Message)"
    }
  }
  if ($null -ne $mutex) {
    $mutex.Dispose()
  }
}
