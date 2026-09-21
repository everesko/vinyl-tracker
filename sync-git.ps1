[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "Checking repository changes..." -ForegroundColor Cyan

$status = (git status --porcelain)
if (-not $status) {
    Write-Host "Repository is already clean. Nothing to commit or push." -ForegroundColor Green
    exit 0
}

Write-Host "Adding changes to git..." -ForegroundColor Yellow
git add -A

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$commitMsg = if ($args.Count -gt 0) { $args -join " " } else { "Auto-sync: $timestamp" }

git commit -m $commitMsg

Write-Host "Pushing to GitHub (main)..." -ForegroundColor Yellow
git push origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "Successfully synced with GitHub!" -ForegroundColor Green
} else {
    Write-Host "Push failed." -ForegroundColor Red
}
