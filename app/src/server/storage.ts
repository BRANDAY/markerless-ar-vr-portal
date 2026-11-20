/**
 * Remembers the last server address that worked, in a small JSON file in the app's
 * private documents directory (official `expo-file-system`, no extra native module).
 * Failures are logged and otherwise ignored: persistence is a convenience.
 */
import { File, Paths } from 'expo-file-system';

import { formatAddress, parseServerAddress, type ServerAddress } from './core/address';

const FILE_NAME = 'server-connection.json';

function settingsFile(): File {
  return new File(Paths.document, FILE_NAME);
}

export async function loadSavedAddress(log: (message: string) => void): Promise<ServerAddress | null> {
  try {
    const file = settingsFile();
    if (!file.exists) {
      return null;
    }
    const json: unknown = JSON.parse(await file.text());
    const text =
      json && typeof json === 'object' ? (json as Record<string, unknown>).address : undefined;
    if (typeof text !== 'string') {
      return null;
    }
    const parsed = parseServerAddress(text);
    return parsed.ok ? parsed.address : null;
  } catch (error) {
    log(`server: could not read the saved address (${String(error)})`);
    return null;
  }
}

export async function saveAddress(
  address: ServerAddress | null,
  log: (message: string) => void,
): Promise<void> {
  try {
    const file = settingsFile();
    if (address === null) {
      if (file.exists) {
        file.delete();
      }
      return;
    }
    if (!file.exists) {
      file.create();
    }
    await file.write(JSON.stringify({ version: 1, address: formatAddress(address) }));
  } catch (error) {
    log(`server: could not save the address (${String(error)})`);
  }
}
