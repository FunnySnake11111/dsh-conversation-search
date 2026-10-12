# rollback-conversation-search.ps1 — 回滚 dsh-conversation-search 安装
# 前置条件：DSH 桌面进程完全停止。策略：从 bundles/dependencies 移除登记并 pnpm remove；
# 若 pnpm remove 失败，按最近的 .bak-csearch-* 备份还原 package.json + cordis.patch.yml + lock。

$ErrorActionPreference = "Stop"

$Cli = "D:\Deepseek Harness Desktop\resources\runtime\cli\bin\dsh.cmd"
$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$PkgName = "dsh-conversation-search"

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "D:\Deepseek Harness Desktop*" }
if ($running) {
	Write-Host "检测到 DSH 桌面进程仍在运行，请先完全退出再回滚。" -ForegroundColor Red
	$running | Select-Object Id, ProcessName, Path | Format-Table -AutoSize | Out-String | Write-Host
	exit 1
}

Push-Location $ProfileDir
Write-Host "=== dsh-conversation-search 回滚 ===" -ForegroundColor Cyan

# 1) bundles 移除（0.2.10 审查修复：改用 ConvertFrom-Json 结构化移除——
#    旧正则在「bundles 只剩本插件一项」时不命中，登记残留；
#    写回用 WriteAllText 无 BOM——PS5.1 的 Set-Content -Encoding UTF8 必写 BOM，
#    宿主严格 JSON.parse 会拒启动（10-10 BOM 事故同款，install 有自愈而 rollback 没有）。
$pkgPath = Join-Path $ProfileDir "package.json"
$json = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$bundleBefore = @($json.dsh.bundle).Count
$json.dsh.bundle = @($json.dsh.bundle | Where-Object { $_ -ne $PkgName })
if (@($json.dsh.bundle).Count -lt $bundleBefore) {
	[IO.File]::WriteAllText($pkgPath, ($json | ConvertTo-Json -Depth 100), (New-Object Text.UTF8Encoding($false)))
	Write-Host "已从 bundles 移除登记（无 BOM 写回）。"
}

# 2) pnpm remove
$env:pnpm_config_minimum_release_age = "0"
& $Cli plugin --profile desktop remove $PkgName 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
	Write-Host "pnpm remove 失败，按备份还原 ..." -ForegroundColor Yellow
	$latestBak = Get-ChildItem "$ProfileDir\package.json.bak-csearch-*" | Sort-Object Name -Descending | Select-Object -First 1
	if ($latestBak) {
		$stamp = $latestBak.Name -replace '^package\.json\.bak-csearch-', ''
		Copy-Item "$ProfileDir\package.json.bak-csearch-$stamp" "$ProfileDir\package.json" -Force
		if (Test-Path "$ProfileDir\cordis.patch.yml.bak-csearch-$stamp") { Copy-Item "$ProfileDir\cordis.patch.yml.bak-csearch-$stamp" "$ProfileDir\cordis.patch.yml" -Force }
		if (Test-Path "$ProfileDir\pnpm-lock.yaml.bak-csearch-$stamp") { Copy-Item "$ProfileDir\pnpm-lock.yaml.bak-csearch-$stamp" "$ProfileDir\pnpm-lock.yaml" -Force }
		# 0.2.10：不再裸依赖 PATH 上的 pnpm；缺失时给出明确手工指引（审查 P3）。
		$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
		if ($pnpmCmd) {
			& pnpm install --dir $ProfileDir 2>&1 | Select-Object -Last 15 | Out-Host
		} else {
			Write-Host "PATH 上没有 pnpm——请手工执行: pnpm install --dir `"$ProfileDir`"" -ForegroundColor Yellow
		}
		Write-Host "已按备份 $stamp 还原。" -ForegroundColor Green
	} else {
		Write-Host "未找到 .bak-csearch-* 备份，请手工检查 profile。" -ForegroundColor Red
	}
}

$left = Test-Path "$ProfileDir\node_modules\$PkgName"
Write-Host "回滚完成。node_modules 残留链接存在=$left（pnpm remove 后应为 False）。" -ForegroundColor $(if (-not $left) { "Green" } else { "Yellow" })
Write-Host "请重启 DeepSeek Harness Desktop。"
Pop-Location
