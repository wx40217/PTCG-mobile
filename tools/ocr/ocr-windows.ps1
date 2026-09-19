# Bounded OCR helper for card-image evidence, using the OCR engine that ships
# with Windows (no installs). Must run under Windows PowerShell 5.1 because
# PowerShell 7 has no WinRT projection:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/ocr/ocr-windows.ps1 -Path <img> [-Lang zh-Hans-CN]
#
# Output: JSON {"path":..., "language":..., "text":...} on stdout.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Lang = "zh-Hans-CN",
  [string]$Out = ""
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $null = $netTask.Wait(-1)
  $netTask.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

$absolute = (Resolve-Path -LiteralPath $Path).Path
$language = New-Object Windows.Globalization.Language($Lang)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if ($null -eq $engine) { throw "no OCR engine for language $Lang" }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($absolute)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$payload = [ordered]@{
  path     = $absolute
  language = $Lang
  lines    = @($result.Lines | ForEach-Object { $_.Text })
  text     = $result.Text
}

# Write UTF-8 without a BOM. When -Out is given the JSON never passes through
# the console encoding (which mangles CJK on this machine).
$json = $payload | ConvertTo-Json -Depth 4
$utf8 = New-Object System.Text.UTF8Encoding($false)
if ($Out) {
  $resolved = [System.IO.Path]::GetFullPath($Out)
  [System.IO.File]::WriteAllText($resolved, $json, $utf8)
} else {
  [System.IO.File]::WriteAllText((Join-Path $env:TEMP "ocr-result.json"), $json, $utf8)
  Get-Content -LiteralPath (Join-Path $env:TEMP "ocr-result.json") -Raw -Encoding UTF8
}
