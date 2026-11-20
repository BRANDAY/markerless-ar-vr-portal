"""Download the weights the room-plan stage needs (once; they are cached in HF_HOME).

    uv run python scripts/get_models.py

Only the safetensors weights and the small config/tokenizer files are fetched:
Depth Anything V2 Small (Apache-2.0, 95 MB) and Grounding DINO tiny (Apache-2.0, 657 MB).
The server downloads them by itself on first use; this script just makes that
step explicit (and retries on a flaky connection).
"""

from __future__ import annotations

import sys
import time

from locserver.roomnets import DEPTH_MODEL, DOOR_MODEL

PATTERNS = ["*.json", "*.txt", "model.safetensors"]


def main() -> int:
    from huggingface_hub import snapshot_download

    for repo in (DEPTH_MODEL, DOOR_MODEL):
        for attempt in range(1, 6):
            try:
                print(repo, "->", snapshot_download(repo, allow_patterns=PATTERNS), flush=True)
                break
            except Exception as e:  # network hiccups: retry, the download resumes
                print(f"{repo}: attempt {attempt} failed: {type(e).__name__}: {e}", flush=True)
                time.sleep(3 * attempt)
        else:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
