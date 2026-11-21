/**
 * The saved cloud doorway of this phone, in `cloud-door.json` in the app's private
 * documents directory (next to `app-prefs.json`; official `expo-file-system`). The file
 * holds one record: one room, one doorway. It contains no key and no secret.
 */
import { File, Paths } from 'expo-file-system';

import { type CloudDoorRecord, parseRecord } from './core/doorRecord';

const FILE_NAME = 'cloud-door.json';

/** The saved record, or null when there is none or the file is broken. Never throws. */
export async function loadDoorRecord(): Promise<CloudDoorRecord | null> {
  try {
    const file = new File(Paths.document, FILE_NAME);
    if (!file.exists) {
      return null;
    }
    return parseRecord(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

/** Replaces the saved record. Returns false when the file could not be written. */
export async function storeDoorRecord(record: CloudDoorRecord): Promise<boolean> {
  try {
    const file = new File(Paths.document, FILE_NAME);
    if (!file.exists) {
      file.create();
    }
    await file.write(JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Forgets the saved record (the anchor itself stays in the service until it expires). */
export function clearDoorRecord(): void {
  try {
    const file = new File(Paths.document, FILE_NAME);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Nothing to forget.
  }
}
