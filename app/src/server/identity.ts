/**
 * Who this app is to the localization server: an id of the installation (made once and
 * kept in the app's private documents directory), the phone's name, an id of the current
 * app run and the app version. The server's monitoring panel lists devices by these.
 */
import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import appConfig from '../../app.json';
import { type ClientIdentity, newDeviceId, sanitizeId } from './core/deviceLog';

const FILE_NAME = 'device-id.json';

/** One per app run: the AR world frame lives as long as the app does. */
export const SESSION_ID = `run-${Date.now().toString(36)}`;

/** Used until the saved id has been read; replaced by it (or saved as the new id). */
let deviceId = newDeviceId();

export function getDeviceId(): string {
  return deviceId;
}

/** "Xiaomi 24030PN60G": manufacturer and model as Android reports them. */
function deviceName(): string {
  const constants = Platform.constants as { Manufacturer?: string; Brand?: string; Model?: string };
  const maker = constants.Manufacturer ?? constants.Brand ?? '';
  const model = constants.Model ?? '';
  const name = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${maker} ${model}`;
  return name.trim() || Platform.OS;
}

/** Reads the installation id, or saves a new one. Never throws. */
export async function loadClientIdentity(log: (message: string) => void): Promise<ClientIdentity> {
  try {
    const file = new File(Paths.document, FILE_NAME);
    let saved: unknown;
    if (file.exists) {
      saved = (JSON.parse(await file.text()) as Record<string, unknown>).device_id;
    }
    if (typeof saved === 'string' && saved) {
      deviceId = sanitizeId(saved);
    } else {
      if (!file.exists) {
        file.create();
      }
      await file.write(JSON.stringify({ version: 1, device_id: deviceId }));
    }
  } catch (error) {
    log(`server: could not read or save the device id, using a temporary one (${String(error)})`);
  }
  return {
    deviceId,
    deviceName: deviceName(),
    sessionId: SESSION_ID,
    appVersion: appConfig.expo.version,
  };
}
