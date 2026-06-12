# Live E2E verification for Mint Wealth Navigator
# Usage: .\scripts\verify-live-e2e.ps1 [-BaseUrl http://localhost:3000]

param(
  [string]$BaseUrl = "http://localhost:3000"
)

$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "=== Mint Wealth Navigator - Live E2E Verify ===" -ForegroundColor Cyan
Write-Host "Base URL: $BaseUrl"
Write-Host ""

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# 1. Login
Write-Host "[1/3] POST /api/auth/login (admin/admin)..." -ForegroundColor Yellow
$loginOk = $false
try {
  $loginBody = '{"username":"admin","password":"admin"}'
  $login = Invoke-WebRequest -Uri "$BaseUrl/api/auth/login" -Method POST `
    -ContentType "application/json" -Body $loginBody -WebSession $session -UseBasicParsing
  $loginOk = $true
  Write-Host "  OK ($($login.StatusCode))" -ForegroundColor Green
} catch {
  Write-Host "  FAIL: $($_.Exception.Message)" -ForegroundColor Red
}

# 2. Health
Write-Host "[2/3] GET /api/iress/health..." -ForegroundColor Yellow
$healthOk = $false
$healthDetail = ""
try {
  $health = Invoke-WebRequest -Uri "$BaseUrl/api/iress/health" -WebSession $session -UseBasicParsing
  $healthBody = $health.Content | ConvertFrom-Json
  $healthOk = [bool]$healthBody.ok
  $healthDetail = "mode=$($healthBody.mode) sessionStarted=$($healthBody.sessionStarted)"
  if ($healthBody.error) { $healthDetail = $healthBody.error }
  if ($healthOk) {
    Write-Host "  OK - $healthDetail" -ForegroundColor Green
  } else {
    Write-Host "  WARN - $healthDetail" -ForegroundColor DarkYellow
  }
} catch {
  $healthDetail = $_.Exception.Message
  Write-Host "  FAIL: $healthDetail" -ForegroundColor Red
}

# 3. Quotes
Write-Host "[3/3] GET /api/iress/quotes?symbols=NPN..." -ForegroundColor Yellow
$quotesOk = $false
$quotesDetail = ""
try {
  $quotes = Invoke-WebRequest -Uri "$BaseUrl/api/iress/quotes?symbols=NPN" -WebSession $session -UseBasicParsing
  $quotesBody = $quotes.Content | ConvertFrom-Json
  $src = $quotesBody.quotes[0].source
  $last = $quotesBody.quotes[0].quote.last
  $quotesOk = $true
  $quotesDetail = "source=$src last=$last live=$($quotesBody.liveCount) fallback=$($quotesBody.fallbackCount)"
  Write-Host "  OK - $quotesDetail" -ForegroundColor Green
} catch {
  $quotesDetail = $_.Exception.Message
  Write-Host "  FAIL: $quotesDetail" -ForegroundColor Red
}

# Summary
Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
Write-Host ("{0,-12} {1,-6} {2}" -f "Step", "Status", "Detail")
Write-Host ("{0,-12} {1,-6} {2}" -f "Login", $(if ($loginOk) { "OK" } else { "FAIL" }), "mint-auth cookie")
Write-Host ("{0,-12} {1,-6} {2}" -f "Health", $(if ($healthOk) { "OK" } else { "FAIL" }), $healthDetail)
Write-Host ("{0,-12} {1,-6} {2}" -f "Quotes NPN", $(if ($quotesOk) { "OK" } else { "FAIL" }), $quotesDetail)
Write-Host ""
Write-Host "Open $BaseUrl/oems and look for LIVE/HYBRID badges on Movers and Security."
Write-Host ""

if (-not $loginOk) { exit 1 }
