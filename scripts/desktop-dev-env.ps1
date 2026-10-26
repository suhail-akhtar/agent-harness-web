# Starts the desktop app in development with the keys from .env in its environment
# (the app's engine reads keys from the environment, not from .env).
#   powershell -File scripts/desktop-dev-env.ps1
Set-Location (Split-Path $PSScriptRoot -Parent)
if (Test-Path .env) {
  Get-Content .env | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$k" -Value $v.Trim('"')
  }
}
npm run desktop:dev
