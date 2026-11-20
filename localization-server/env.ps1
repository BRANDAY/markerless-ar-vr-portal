# OPTIONAL. The project works without this file: `uv sync` then creates `.venv`
# in the project folder, uv and PyTorch use their normal per-user caches, and
# maps, test data and reports live under `data\`.
#
# Dot-source it only if you want the large files somewhere else (another drive):
#
#     . .\env.ps1 -Root D:\locserver-data      # this PowerShell window only
#
# or set LOCSERVER_ROOT once (e.g. in an untracked `env.local.ps1` next to this
# file, containing:  $env:LOCSERVER_ROOT = "D:\locserver-data"), then just
#
#     . .\env.ps1
#
# With a root set, these go there (about 10 GB with the GPU build of PyTorch):
#   venv\       the virtual environment        (UV_PROJECT_ENVIRONMENT)
#   uv-cache\   uv's download cache            (UV_CACHE_DIR)
#   torch\      model weights                  (TORCH_HOME)
#   hf\         Hugging Face cache, unused     (HF_HOME)
#   datasets\   public test data               (LOCSERVER_DATASETS)
#   work\       evaluation reports, uploads    (LOCSERVER_WORK)
param([string]$Root = "")

$local = Join-Path $PSScriptRoot "env.local.ps1"
if (-not $Root -and (Test-Path $local)) { . $local }
if (-not $Root) { $Root = $env:LOCSERVER_ROOT }

$env:PYTHONUTF8 = "1"
if (-not $Root) {
    Write-Host "locserver: no LOCSERVER_ROOT set - using the defaults (.venv and data\ inside the project)."
    return
}

$env:LOCSERVER_ROOT         = $Root
$env:UV_PROJECT_ENVIRONMENT = Join-Path $Root "venv"
$env:UV_CACHE_DIR           = Join-Path $Root "uv-cache"
$env:UV_LINK_MODE           = "hardlink"     # cache and venv share a drive
$env:TORCH_HOME             = Join-Path $Root "torch"
$env:HF_HOME                = Join-Path $Root "hf"
$env:LOCSERVER_DATASETS     = Join-Path $Root "datasets"
$env:LOCSERVER_WORK         = Join-Path $Root "work"
foreach ($d in @($env:UV_CACHE_DIR, $env:TORCH_HOME, $env:HF_HOME, $env:LOCSERVER_DATASETS, $env:LOCSERVER_WORK)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force $d | Out-Null }
}
Write-Host "locserver: large files under $Root"
