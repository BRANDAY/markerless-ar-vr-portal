# Reproduces the tables of README "Measured numbers" on the public test sequence.
# Usage (from the project folder, after building the maps `tum_room` and `tum_room_sfm_only`):
#     . .\env.ps1 ; .\scripts\run_reference_evaluation.ps1
$seq = "$env:LOCSERVER_DATASETS\tum_fr1_room\rgbd_dataset_freiburg1_room"
$out = $env:LOCSERVER_WORK

# B: unseen frames vs. motion-capture ground truth; GPU and CPU, known and unknown intrinsics
uv run --no-sync locserver-evaluate --map-id tum_room --gt-capture $seq --device both --intrinsics both --out "$out\eval_B_base.json"
# B: robustness to degraded query images (known intrinsics)
uv run --no-sync locserver-evaluate --map-id tum_room --gt-capture $seq --intrinsics map --perturb all --out "$out\eval_B_perturb.json"
# A: held-out map images vs. SfM poses (the protocol that also works for a map without ground truth)
uv run --no-sync locserver-evaluate --map-id tum_room --intrinsics both --out "$out\eval_A.json"
# B on the map built without pose priors, to show the effect of SfM drift
uv run --no-sync locserver-evaluate --map-id tum_room_sfm_only --gt-capture $seq --intrinsics map --out "$out\eval_B_sfm_only.json"
