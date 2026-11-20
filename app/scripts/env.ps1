# OPTIONAL. Points the build caches at another drive/folder FOR THE CURRENT POWERSHELL
# SESSION ONLY (nothing permanent is written, no system settings change). Dot-source it
# with the folder to use, before `npm ci` / the Gradle build:
#
#   . .\scripts\env.ps1 -CacheRoot D:\build-caches
#
# Why: the Gradle user home (Gradle distribution, Maven artifacts, build cache) grows to
# about 4 GB and the npm download cache to about 0.5 GB; by default both live in the user
# profile on the system drive. Skip this script if there is enough space there.
param(
    [Parameter(Mandatory = $true)]
    [string]$CacheRoot
)

$env:GRADLE_USER_HOME = Join-Path $CacheRoot 'gradle-home'
$env:npm_config_cache = Join-Path $CacheRoot 'npm-cache'

New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $env:npm_config_cache | Out-Null

Write-Host "GRADLE_USER_HOME = $env:GRADLE_USER_HOME"
Write-Host "npm cache        = $env:npm_config_cache"
Write-Host "JAVA_HOME        = $env:JAVA_HOME"
Write-Host "ANDROID_HOME     = $env:ANDROID_HOME"
