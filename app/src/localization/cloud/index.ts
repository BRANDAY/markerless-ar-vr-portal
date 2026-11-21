/**
 * Cloud anchors as a second way to keep the doorway in place. What the rest of the app
 * needs from this folder; the plan and the build settings are in
 * `docs/cloud/cloud-connection.md`.
 */
export { CloudAnchorDoorProvider, type CloudAnchorDoorOptions } from './CloudAnchorDoorProvider';
export { DEFAULT_TTL_DAYS, saveDoorToCloud, type SaveDoorToCloudArgs } from './saveDoorToCloud';
export { clearDoorRecord, loadDoorRecord, storeDoorRecord } from './doorRecordStore';
export {
  type CloudDoorRecord,
  type CloudService,
  daysLeft,
  expiryState,
  type ExpiryState,
  fromShareText,
  toShareText,
} from './core/doorRecord';
export {
  firstAnchorSource,
  hitTestAnchorSource,
  type KnownPlane,
  type LocalAnchor,
  type LocalAnchorSource,
  planeAnchorSource,
} from './core/localAnchor';
export type { SaveDoorResult, SaveStep } from './core/saveDoor';
export type { Failure, FailureReason } from './core/cloudAnchorApi';
