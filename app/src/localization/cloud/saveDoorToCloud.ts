/**
 * "Save this doorway to the cloud": what the staff's button calls while a doorway is on
 * screen (found by the self-hosted server, or placed by hand). Uploads a cloud anchor
 * under the doorway and stores the record `CloudAnchorDoorProvider` reads in later
 * sessions. The steps and their rules are in `core/saveDoor.ts`.
 */
import { cloudAnchorApiFrom } from './core/cloudAnchorApi';
import type { CloudService } from './core/doorRecord';
import type { LocalAnchorSource } from './core/localAnchor';
import { saveDoor, type SaveDoorInput, type SaveDoorOptions, type SaveDoorResult, type SaveStep } from './core/saveDoor';
import { storeDoorRecord } from './doorRecordStore';

/** Longest lifetime the service gives (with keyless authorisation). */
export const DEFAULT_TTL_DAYS = 365;

export interface SaveDoorToCloudArgs extends Omit<SaveDoorInput, 'service' | 'ttlDays'> {
  /** ViroReact's `arSceneNavigator` (`LocalizationContext.getArSceneNavigator()`). */
  navigator: unknown;
  /** Where the local anchor comes from (`core/localAnchor.ts`); provided by the AR scene. */
  anchors: LocalAnchorSource;
  /** Which service this build talks to; must match the `provider` of the AR view. */
  service?: CloudService;
  ttlDays?: number;
  log?(message: string): void;
  onStep?(step: SaveStep): void;
  options?: Partial<SaveDoorOptions>;
}

/**
 * Never throws. On success the record is already stored on the phone; when only the
 * storing failed, the result is a failure of step 'checking' with the anchor id set.
 */
export async function saveDoorToCloud(args: SaveDoorToCloudArgs): Promise<SaveDoorResult> {
  const log = args.log ?? (() => {});
  const api = cloudAnchorApiFrom(args.navigator);
  if (!api) {
    return {
      ok: false,
      step: 'anchoring',
      state: 'ErrorNotSupported',
      cloudAnchorId: null,
      failure: { reason: 'not-supported', retry: false, text: 'cloud anchors are not available in this build' },
    };
  }
  const result = await saveDoor(
    {
      api,
      anchors: args.anchors,
      now: () => Date.now(),
      schedule: (fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        return () => clearTimeout(timer);
      },
      log,
      onStep: args.onStep,
    },
    {
      service: args.service ?? 'arcore',
      door: args.door,
      opening: args.opening,
      doorSource: args.doorSource,
      roomId: args.roomId,
      ttlDays: args.ttlDays ?? DEFAULT_TTL_DAYS,
    },
    args.options,
  );
  if (result.ok && !(await storeDoorRecord(result.record))) {
    log('cloud: the anchor was hosted, but the record could not be written to the phone');
    return {
      ok: false,
      step: 'checking',
      state: 'StoreFailed',
      cloudAnchorId: result.record.cloudAnchorId,
      failure: { reason: 'unknown', retry: true, text: 'the doorway was uploaded, but could not be saved on the phone' },
    };
  }
  return result;
}
