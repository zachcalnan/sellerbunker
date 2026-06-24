param(
  [Parameter(Mandatory = $true)]
  [string]$Message
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Host "Branch: $branch" -ForegroundColor Cyan

$status = git status --porcelain
if (-not $status) {
  Write-Host "Nothing to commit - working tree clean." -ForegroundColor Yellow
} else {
  git add -A
  git commit -m $Message
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

git push -u origin HEAD
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Pushed $branch to origin." -ForegroundColor Green
