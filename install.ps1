# install-conversation-search.ps1 — 安装 dsh-conversation-search 到 desktop profile
# 前置条件：DSH 桌面进程必须完全停止（脚本检测到运行中会直接退出，不会自动杀进程）。
# 步骤：备份 profile 文件 → dsh plugin add link:（pnpm 本地链接）→ 校验登记结果。
# 回滚：rollback-conversation-search.ps1

$ErrorActionPreference = "Stop"

$Cli = "D:\Deepseek Harness Desktop\resources\runtime\cli\bin\dsh.cmd"
$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$PluginDir = $PSScriptRoot
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Test-DshRunning {
	Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "D:\Deepseek Harness Desktop*" }
}

Write-Host "=== dsh-conversation-search 安装 ===" -ForegroundColor Cyan

# 0) 源码自检
if (-not (Test-Path "$PluginDir\package.json")) { throw "插件源码不存在：$PluginDir" }
foreach ($f in @("lib\index.js", "lib\client.js", "lib\typert.host.js", "cordis.patch.yml", "locale\zh.json", "locale\en.json", "icon.svg")) {
	if (-not (Test-Path "$PluginDir\$f")) { throw "缺少插件文件：$f" }
}

# 1) 宿主必须停止（本机规则：宿主运行中对 profile 跑 pnpm 有热加载崩溃史）
$running = Test-DshRunning
if ($running) {
	Write-Host "检测到 DSH 桌面进程仍在运行：" -ForegroundColor Red
	$running | Select-Object Id, ProcessName, Path | Format-Table -AutoSize | Out-String | Write-Host
	Write-Host "请先完全退出 DeepSeek Harness Desktop（含托盘），然后重新运行本脚本。" -ForegroundColor Yellow
	exit 1
}
Write-Host "[1/4] 未检测到 DSH 进程，继续。" -ForegroundColor Green

# 2) 备份
Push-Location $ProfileDir
foreach ($f in @("package.json", "cordis.patch.yml", "pnpm-lock.yaml")) {
	if (Test-Path $f) { Copy-Item $f "$f.bak-csearch-$Stamp" -Force }
}
Write-Host "[2/4] profile 已备份（.bak-csearch-$Stamp）。" -ForegroundColor Green

# 3) pnpm 供应链时效策略放行（仅本进程；本地 link 安装原则上不走 registry）
$env:pnpm_config_minimum_release_age = "0"

# 4) 安装（CLI add link:）
Write-Host "[3/4] dsh plugin --profile desktop add link:$PluginDir ..." -ForegroundColor Cyan
& $Cli plugin --profile desktop add "link:$PluginDir" 2>&1 | Tee-Object -Variable addOutput | Out-Host
if ($LASTEXITCODE -ne 0) {
	Write-Host "CLI add 失败（输出见上）。可运行 rollback-conversation-search.ps1 还原备份。" -ForegroundColor Red
	exit 1
}

# 5) 修复 dsh plugin add 的已知破坏（v0.2.0-rc.2 实测 2026-10-10）：
#    CLI 会把 dsh.profile.bundles 重建为仅核心两项，并把用户的 cordis.patch.yml
#    覆盖为空数组。此处自动还原/补齐，不再只给手工提示。
# 5a) BOM 自愈：Windows PowerShell 5.1 的 Set-Content/Out-File -Encoding UTF8 重写
#     package.json 会带上 BOM，宿主 readProfileManifest 的 JSON.parse 直接拒绝
#     （2026-10-10 二次故障原因）。先剥掉再校验。
foreach ($f in @("$ProfileDir\package.json", "$ProfileDir\cordis.patch.yml")) {
	$bytes = [IO.File]::ReadAllBytes($f)
	if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
		[IO.File]::WriteAllBytes($f, $bytes[3..($bytes.Length - 1)])
		Write-Host "已去除 $f 的 UTF-8 BOM（宿主 JSON.parse 不接受 BOM）。" -ForegroundColor Yellow
	}
}
$PatchBackup = "$ProfileDir\cordis.patch.yml.bak-csearch-$Stamp"
if ((Test-Path $PatchBackup) -and ((Get-Content "$ProfileDir\cordis.patch.yml" -Raw) -ne (Get-Content $PatchBackup -Raw))) {
	Copy-Item $PatchBackup "$ProfileDir\cordis.patch.yml" -Force
	Write-Host "已还原被 CLI 覆盖的 cordis.patch.yml（用户 patch 配置）。" -ForegroundColor Yellow
}

$pkgPath = "$ProfileDir\package.json"
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$hasDep = ($pkg.dependencies.PSObject.Properties.Name) -contains "dsh-conversation-search"
$hasBundle = ($pkg.dsh.profile.bundles) -contains "dsh-conversation-search"
if (-not $hasBundle) {
	$pkg.dsh.profile.bundles += "dsh-conversation-search"
	$json = $pkg | ConvertTo-Json -Depth 64
	[IO.File]::WriteAllText($pkgPath, $json, (New-Object Text.UTF8Encoding($false)))
	$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
	$hasBundle = ($pkg.dsh.profile.bundles) -contains "dsh-conversation-search"
	Write-Host "已把 dsh-conversation-search 追加进 dsh.profile.bundles。" -ForegroundColor Yellow
}
$installed = Test-Path "$ProfileDir\node_modules\dsh-conversation-search\lib\index.js"

# 6) link: 协议不会安装插件自身的依赖（typert 加载 zod 失败的教训）：
#    插件目录缺 node_modules 依赖时就地 npm install，失败则明确退出。
$plugPkg = Get-Content "$PluginDir\package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$missingDeps = @($plugPkg.dependencies.PSObject.Properties.Name | Where-Object { -not (Test-Path "$PluginDir\node_modules\$_") })
if ($missingDeps.Count -gt 0) {
	Write-Host "插件目录缺少依赖：$($missingDeps -join ', ')，在插件目录执行 npm install ..." -ForegroundColor Yellow
	Push-Location $PluginDir
	npm install --no-audit --no-fund --omit=dev 2>&1 | Out-Host
	Pop-Location
	if ($LASTEXITCODE -ne 0) {
		Write-Host "npm install 失败：请在 $PluginDir 手动安装依赖后重试。" -ForegroundColor Red
		exit 1
	}
}

$patchApplied = (Test-Path "$ProfileDir\cordis.patch.yml") -and ((Get-Content "$ProfileDir\cordis.patch.yml" -Raw) -match "dsh-conversation-search")

Write-Host "[4/4] 校验：node_modules 链接=$installed · dependencies=$hasDep · bundles 登记=$hasBundle · patch 含插件行=$patchApplied（插件 patch 随 bundle 自带，profile patch 不需要含插件行）" -ForegroundColor $(if ($installed -and $hasDep -and $hasBundle) { "Green" } else { "Red" })

if (-not ($installed -and $hasDep -and $hasBundle)) {
	Write-Host "校验未全部通过，可运行 rollback-conversation-search.ps1 还原备份。" -ForegroundColor Red
	exit 1
}

Write-Host ""
Write-Host "安装结束。请启动 DeepSeek Harness Desktop 验证：" -ForegroundColor Green
Write-Host "  1. 对话页按 Ctrl+Shift+F 打开搜索面板"
Write-Host "  2. 输入历史消息中的词（如之前会话说过的插件名）回车"
Write-Host "  3. 点击结果：自动切换/滚动定位并高亮；面板展示前后上下文"
Write-Host "  4. DevTools console 应无 'slot entry crashed' 与本插件 warn"
Pop-Location
