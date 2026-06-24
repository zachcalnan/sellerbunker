param(
  [Parameter(Mandatory = $true)]
  [string]$Message,
  [string]$TargetBranch = 'main'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

$sourceBranch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Host "Deploy: $sourceBranch -> $TargetBranch" -ForegroundColor Cyan

& "$PSScriptRoot\git-push.ps1" -Message $Message
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($sourceBranch -eq $TargetBranch) {
  Write-Host "Already on $TargetBranch. Render will pick up the push if auto-deploy is on." -ForegroundColor Green
  Write-Host "Otherwise use Render dashboard: backend + frontend -> Manual Deploy" -ForegroundColor Yellow
  exit 0
}

git fetch origin $TargetBranch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git checkout $TargetBranch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git pull origin $TargetBranch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git merge $sourceBranch -m "Merge branch $sourceBranch (deploy)"
if ($LASTEXITCODE -ne 0) {
  Write-Host "Merge failed. Fix conflicts, then push main yourself." -ForegroundColor Red
  exit $LASTEXITCODE
}

git push origin $TargetBranch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

git checkout $sourceBranch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Live branch $TargetBranch updated. Render deploys from this branch." -ForegroundColor Green
Write-Host "If auto-deploy is off: Render -> backend + frontend -> Manual Deploy" -ForegroundColor Yellow
