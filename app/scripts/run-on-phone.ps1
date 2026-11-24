# Builds the debug APK, installs it on the phone connected over USB and starts the app.
# Used by VS Code (Ctrl+Shift+B, Run and Debug, Terminal -> Run Task); from a PowerShell window in the app folder:
#
#   powershell -ExecutionPolicy Bypass -File scripts\run-on-phone.ps1 [-NoBuild] [-Emulator]
#
# Takes the phone on USB, or the Android emulator when no phone is connected (or with -Emulator).
# Needs JAVA_HOME (JDK 21) and ANDROID_HOME (the Android SDK); GRADLE_USER_HOME if the Gradle caches live elsewhere.
param([switch]$NoBuild, [switch]$Emulator)

# The build runs Node (the JavaScript bundle); started from the VS Code debugger it would attach to every one of them.
Remove-Item Env:NODE_OPTIONS, Env:VSCODE_INSPECTOR_OPTIONS -ErrorAction SilentlyContinue

$app = Split-Path -Parent $PSScriptRoot
function Say([string]$text, [string]$color = "Gray") { Write-Host $text -ForegroundColor $color }
function Fail([string]$text) { Say ""; Say "  $text" Red; Say ""; exit 1 }

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"
if (-not (Test-Path $adb)) { Fail "adb was not found in $sdk\platform-tools. Install 'Android SDK Platform-Tools' (Android Studio, SDK Manager) or set ANDROID_HOME." }
if (-not (Test-Path (Join-Path $app "android\gradlew.bat"))) { Fail "The Android project is not generated yet: run 'npm run prebuild' in the app folder first." }

# The phone first: a build of several minutes that ends in "no phone" is the worst way to find out.
# A real phone is preferred to a running emulator (AR needs the real room); -Emulator picks the emulator.
$lines = @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\S" })
$ready = @($lines | Where-Object { $_ -match "\tdevice$" } | ForEach-Object { ($_ -split "\t")[0] })
if (-not $ready) {
    if ($lines | Where-Object { $_ -match "unauthorized" }) { Fail "The phone is connected but has not allowed USB debugging: unlock it and tap Allow in the dialog on its screen." }
    Fail "No phone found. Connect it with a USB cable and turn on USB debugging (Settings, Developer options), or start the emulator (task 'Emulator: start')."
}
$phones = @($ready | Where-Object { $_ -notlike "emulator-*" })
$emulators = @($ready | Where-Object { $_ -like "emulator-*" })
$serial = if ($Emulator -and $emulators) { $emulators[0] } elseif ($phones) { $phones[0] } else { $emulators[0] }
$what = if ($serial -like "emulator-*") { "emulator" } else { "phone" }
Say "Device: $serial ($what)" Green
$adbArgs = @("-s", $serial)

if (-not $NoBuild) {
    Say "Building the debug APK (a few seconds when nothing changed, several minutes after a change) ..." Yellow
    Push-Location (Join-Path $app "android")
    try { & .\gradlew.bat assembleDebug --console=plain } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Fail "The build failed - the reason is in the lines above." }
}

$apk = Join-Path $app "android\app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $apk)) { Fail "No APK at $apk - build it first (run this script without -NoBuild)." }
Say "Installing on the $what ..." Yellow
& $adb @adbArgs install -r $apk
if ($LASTEXITCODE -ne 0) { Fail "Installing failed - the reason is in the lines above." }
& $adb @adbArgs shell monkey -p hr.fesb.arportal -c android.intent.category.LAUNCHER 1 | Out-Null
Say ""
Say "  The app is installed and started on the $what." Green
Say ""
