param()
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[1/9] pnpm install"
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

Write-Host "[2/9] typecheck"
pnpm typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

Write-Host "[3/9] policy + version unit tests"
node --test packages/shared/test/policy.test.ts packages/shared/test/version.test.ts apps/desktop/test/risk.test.ts apps/desktop/test/policy-risk.test.ts apps/renderer/test/context-meter.test.ts apps/desktop/test/model-probe.test.ts apps/desktop/test/browser-helpers.test.ts apps/desktop/test/updater.test.ts apps/desktop/test/plan-approval.test.ts apps/desktop/test/serial-queue.test.ts apps/desktop/test/model-env.test.ts apps/desktop/test/model-preflight.test.ts apps/desktop/test/model-registry-sync.test.ts apps/desktop/test/kernel-diagnose.test.ts apps/desktop/test/artifact-ledger.test.ts apps/desktop/test/session-title.test.ts apps/renderer/test/artifact-preview.test.ts apps/renderer/test/queue.test.ts apps/renderer/test/model-error.test.ts apps/renderer/test/ui-state.test.ts apps/renderer/test/tool-summary.test.ts
if ($LASTEXITCODE -ne 0) { throw "policy tests failed" }

Write-Host "[4/9] audit + grants checks"
node scripts/p40-checks.mjs
if ($LASTEXITCODE -ne 0) { throw "audit/grants checks failed" }

Write-Host "[5/9] diagnostics checks"
node scripts/p42-checks.mjs
if ($LASTEXITCODE -ne 0) { throw "diagnostics checks failed" }

Write-Host "[6/9] provider catalog 一致性"
node scripts/build-provider-catalog.mjs --check
if ($LASTEXITCODE -ne 0) { throw "provider-catalog 与 pi 数据不一致：跑 node scripts/build-provider-catalog.mjs 并提交" }

Write-Host "[7/9] contract schema"
python docs/check_contract.py
if ($LASTEXITCODE -ne 0) { throw "schema validation failed" }

Write-Host "[8/9] permission extension typecheck"
pnpm --filter @oh-my-coding-pi/desktop exec tsc -p ../../packages/permission-ext --noEmit
if ($LASTEXITCODE -ne 0) { throw "permission extension typecheck failed" }

Write-Host "[9/9] electron build"
pnpm build
if ($LASTEXITCODE -ne 0) { throw "electron build failed" }

# 内核验收（可选）：需要真解释器，所以不进默认流水线。
# 用法：$env:OMCP_ACCEPT_PYTHON="C:\Program Files\Python314\python.exe"
#       $env:OMCP_ACCEPT_R="C:\Program Files\R\R-4.6.2\bin\Rscript.exe"
if ($env:OMCP_ACCEPT_PYTHON) {
  Write-Host "[kernel] 内核验收（F1–F11）"
  node scripts/kernel-acceptance.mjs --driver $env:OMCP_ACCEPT_PYTHON --python $env:OMCP_ACCEPT_PYTHON --r "$env:OMCP_ACCEPT_R"
  if ($LASTEXITCODE -ne 0) { throw "kernel acceptance failed" }
} else {
  Write-Host "[kernel] 跳过验收（未设 OMCP_ACCEPT_PYTHON）"
}

Write-Host "CI OK"
