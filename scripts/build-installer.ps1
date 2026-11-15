param(
  [switch]$Sign,
  [string]$Output = "D:/build-output/omcp",
  [string]$ElectronDist = "D:/build-output/electron-dist"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# electron-builder 在本机解包 Electron 时会卡在 extractArchive（对 win-unpacked.tmp 加锁重试），
# 这里先手工解包，再通过 -c.electronDist 让 builder 直接拷贝。
$electronVersion = (Get-Content "apps/desktop/package.json" -Raw | ConvertFrom-Json).devDependencies.electron
if ($electronVersion -match '^[^\d]*') { $electronVersion = $electronVersion -replace '^[^\d]*', '' }
if (-not (Test-Path (Join-Path $ElectronDist "electron.exe"))) {
  $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $zip) { throw "找不到 electron-v$electronVersion-win32-x64.zip，请先跑一次 pnpm build 让 electron 下载完成" }
  Write-Host "[1/6] 解包 Electron 到 $ElectronDist"
  New-Item -ItemType Directory -Force -Path $ElectronDist | Out-Null
  Expand-Archive -Path $zip.FullName -DestinationPath $ElectronDist -Force
} else {
  Write-Host "[1/6] 复用已解包的 Electron：$ElectronDist"
}

Write-Host "[2/6] 准备内置 pi（vendor/pi → vendor/pi-bundle）"
node scripts/fetch-pi.mjs
if ($LASTEXITCODE -ne 0) { throw "fetch-pi failed" }
node scripts/prepare-pi-bundle.mjs
if ($LASTEXITCODE -ne 0) { throw "prepare-pi-bundle failed" }
node scripts/license-scan.mjs --write
if ($LASTEXITCODE -ne 0) { throw "license-scan failed" }

# 安装包会把 provider-catalog.json 原样复制进 resources；这里只校验不重写，
# 避免打包出一份“仓库里看不到”的目录。数据升了就得重新生成并提交。
node scripts/build-provider-catalog.mjs --check
if ($LASTEXITCODE -ne 0) { throw "provider-catalog 与 pi 数据不一致：先跑 node scripts/build-provider-catalog.mjs 并提交" }

Write-Host "[3/6] 构建应用（vite）"
Push-Location apps/desktop
pnpm exec electron-vite build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "electron-vite build failed" }

Write-Host "[4/6] 打包 NSIS 安装包 → $Output"
& node_modules/.bin/electron-builder.cmd --win nsis "-c.directories.output=$Output" "-c.electronDist=$ElectronDist"
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "electron-builder failed" }
Pop-Location

$installer = Get-ChildItem $Output -Filter "oh my coding pi Setup *.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "没有找到安装包" }
Write-Host ("[5/6] 安装包：{0}（{1:N0} 字节）" -f $installer.FullName, $installer.Length)

if ($Sign) {
  & "$root\scripts\sign.ps1" -File $installer.FullName
}

Write-Host ("INSTALLER=" + $installer.FullName)
Write-Host ("SIZE=" + $installer.Length)
