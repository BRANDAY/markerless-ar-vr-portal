# Dot-source this file to point the build caches at the E: drive FOR THE CURRENT
# POWERSHELL SESSION ONLY (nothing permanent is written, no system settings change):
#
#   . .\scripts\env.ps1
#
# Why: the C: drive of the development laptop is nearly full. The Gradle user home
# (downloaded Gradle distribution, Maven artifacts, build cache: several GB) and the
# npm download cache are kept on E: instead. Change the two paths below, or skip this
# file entirely, on a machine with enough space on the system drive.
$env:GRADLE_USER_HOME = 'E:\VR-FESB\gradle-home'
$env:npm_config_cache = 'E:\VR-FESB\npm-cache'

New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $env:npm_config_cache | Out-Null

Write-Host "GRADLE_USER_HOME = $env:GRADLE_USER_HOME"
Write-Host "npm cache        = $env:npm_config_cache"
Write-Host "JAVA_HOME        = $env:JAVA_HOME"
Write-Host "ANDROID_HOME     = $env:ANDROID_HOME"
