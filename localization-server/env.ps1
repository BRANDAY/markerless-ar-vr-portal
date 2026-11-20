# Dot-source this file in every new PowerShell window before using uv:
#     . .\env.ps1
#
# It keeps everything large (virtual environment, package cache, model weights,
# datasets) off the system drive. Change $LocRoot if you have no E: drive.
$LocRoot = if ($env:LOCSERVER_ROOT) { $env:LOCSERVER_ROOT } else { "E:\VR-FESB" }

$env:UV_CACHE_DIR           = "$LocRoot\uv-cache"   # uv download/build cache
$env:UV_PROJECT_ENVIRONMENT = "$LocRoot\venv"       # the virtual environment
$env:UV_LINK_MODE           = "hardlink"            # cache and venv share a drive
$env:TORCH_HOME             = "$LocRoot\torch"      # ALIKED / LightGlue weights (torch.hub)
$env:HF_HOME                = "$LocRoot\hf"         # Hugging Face cache (unused by default)
$env:LOCSERVER_DATASETS     = "$LocRoot\datasets"   # public test data
$env:LOCSERVER_WORK         = "$LocRoot\work"       # evaluation scratch output
$env:PYTHONUTF8             = "1"

foreach ($d in @($env:UV_CACHE_DIR, $env:TORCH_HOME, $env:HF_HOME, $env:LOCSERVER_DATASETS, $env:LOCSERVER_WORK)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
}
