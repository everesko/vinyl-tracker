$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Write-Host "🔄 Проверка изменений в репозитории..." -ForegroundColor Cyan

$status = git status --porcelain
if (-not $status) {
    Write-Host "✓ Нет новых изменений для коммита." -ForegroundColor Green
    exit 0
}

Write-Host "📦 Добавление файлов в коммит..." -ForegroundColor Yellow
git add -A

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$commitMsg = if ($args.Count -gt 0) { $args -join " " } else { "Update: $timestamp" }

git commit -m $commitMsg
Write-Host "🚀 Отправка изменений в GitHub (main)..." -ForegroundColor Yellow

git push origin main
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Все изменения успешно отправлены в GitHub!" -ForegroundColor Green
} else {
    Write-Host "❌ Ошибка при отправке в GitHub. Проверьте токен доступа или права." -ForegroundColor Red
}
