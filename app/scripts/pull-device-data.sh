#!/usr/bin/env bash
# Copies what the app keeps on the phone to a folder on the PC, after a test on a device:
# the app's log lines from logcat, its settings and measurement records, a list of its
# files and - only with --captures - the room scans themselves (100-300 MB each).
#
#   bash scripts/pull-device-data.sh <output folder> [--captures]
#
# Run it in Git Bash (PowerShell damages binary output of adb). The phone must be connected
# with USB debugging on and the installed build must be a debug build (`run-as`).
# Nothing on the phone is changed or deleted.
#
# The same log lines and measurement records also reach the server while the phone is
# connected to it (work/device-logs/<device id>.jsonl on the server PC); this script is for
# what the server did not get, and for the files.
set -u

PKG=hr.fesb.arportal
OUT=${1:?usage: pull-device-data.sh <output folder> [--captures]}
CAPTURES=${2:-}
STAMP=$(date +%H%M%S)

mkdir -p "$OUT/phone" || exit 1

if ! adb get-state >/dev/null 2>&1; then
  echo "no phone: 'adb devices' shows no device ready for commands" >&2
  exit 1
fi

# 1. The app's log lines ("[portal] ...") and crashes, as far back as the phone's buffer goes.
adb logcat -d -v threadtime ReactNativeJS:V AndroidRuntime:E '*:S' > "$OUT/logcat-$STAMP.txt"
echo "logcat: $(grep -c '\[portal\]' "$OUT/logcat-$STAMP.txt") app lines -> $OUT/logcat-$STAMP.txt"

# 2. What the app keeps, as a list (names, sizes, times).
adb exec-out run-as "$PKG" sh -c 'cd files 2>/dev/null && ls -laR . 2>/dev/null' > "$OUT/files-$STAMP.txt"
echo "file list -> $OUT/files-$STAMP.txt"

# 3. Small files: settings and measurement records. Each on its own, so that a missing one
#    does not stop the rest.
for item in measurements app-prefs.json server-connection.json measure-settings.json; do
  if adb exec-out run-as "$PKG" sh -c "test -e files/$item && echo yes" | grep -q yes; then
    adb exec-out run-as "$PKG" tar -cf - -C files "$item" | tar -xf - -C "$OUT/phone" && echo "copied files/$item"
  else
    echo "not on the phone: files/$item"
  fi
done

# 4. The scans, on request.
if [ "$CAPTURES" = "--captures" ]; then
  if adb exec-out run-as "$PKG" sh -c 'test -e files/captures && echo yes' | grep -q yes; then
    adb exec-out run-as "$PKG" tar -cf - -C files captures | tar -xf - -C "$OUT/phone" && echo "copied files/captures"
  else
    echo "not on the phone: files/captures"
  fi
fi

echo "done: $OUT"
