# Downloads the public test sequence (TUM RGB-D freiburg1_room, CC BY 4.0, 782 MB)
# and unpacks the colour images and the ground truth (depth is skipped).
#     .\scripts\get_test_data.ps1
$root = if ($env:LOCSERVER_DATASETS) { $env:LOCSERVER_DATASETS } else { Join-Path (Split-Path $PSScriptRoot -Parent) "data\datasets" }
$dir = Join-Path $root "tum_fr1_room"
$seq = Join-Path $dir "rgbd_dataset_freiburg1_room"
if (Test-Path (Join-Path $seq "rgb.txt")) { Write-Host "already there: $seq"; return }
New-Item -ItemType Directory -Force $dir | Out-Null
$tgz = Join-Path $dir "fr1_room.tgz"
curl.exe -L --retry 3 -o $tgz "https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_room.tgz"
if ($LASTEXITCODE -ne 0) { throw "download failed" }
tar.exe -xzf $tgz -C $dir --exclude "*/depth/*" --exclude "*/depth.txt"
if ($LASTEXITCODE -ne 0) { throw "unpacking failed" }
Remove-Item $tgz
Write-Host "test sequence: $seq"
