import { BaseProvider } from './BaseProvider';
import { add, horizontalDirection, scale, yawFacing } from './math';
import type { LocalizationContext, ProviderId, TrackingState, Unsubscribe, Vec3 } from './types';

export interface ManualPlacementOptions {
  /** Horizontal distance from the camera to the doorway, metres. */
  distanceM: number;
  /**
   * Height of the phone above the floor assumed when ARCore has not detected a
   * horizontal plane yet, metres.
   */
  assumedCameraHeightM: number;
  /**
   * A detected plane is accepted as the floor only if it lies at least this far
   * below the camera (otherwise it is a table or a shelf), metres.
   */
  minFloorBelowCameraM: number;
}

const DEFAULT_OPTIONS: ManualPlacementOptions = {
  distanceM: 2,
  assumedCameraHeightM: 1.4,
  minFloorBelowCameraM: 0.8,
};

/**
 * TEMPORARY STAND-IN for real localization (stage 1).
 *
 * Puts the doorway `distanceM` in front of the camera, standing on the floor and
 * facing the user, the first time tracking becomes NORMAL. `relocalize()` repeats
 * the placement from the current camera pose (the "Re-place" button).
 *
 * The pose is NOT persistent: it depends on where the phone is when the session
 * starts, so it does not satisfy the assignment's "same place in every session"
 * requirement. That is the job of the other providers.
 */
export class ManualPlacementProvider extends BaseProvider {
  readonly id: ProviderId = 'manual';
  readonly displayName = 'Manual placement (stand-in)';

  private readonly options: ManualPlacementOptions;
  private unsubscribeTracking: Unsubscribe | null = null;
  private placed = false;

  constructor(options: Partial<ManualPlacementOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  protected onStart(context: LocalizationContext): void {
    this.placed = false;
    this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL');
    this.unsubscribeTracking = context.onTrackingState((state) => this.handleTracking(state));
    this.handleTracking(context.getTrackingState());
  }

  protected onStop(): void {
    this.unsubscribeTracking?.();
    this.unsubscribeTracking = null;
    this.placed = false;
  }

  relocalize(): void {
    if (!this.context) {
      return;
    }
    if (this.context.getTrackingState() !== 'normal') {
      this.context.log('manual: cannot re-place, tracking is not NORMAL');
      return;
    }
    this.place();
  }

  private handleTracking(state: TrackingState): void {
    if (state === 'normal' && !this.placed) {
      this.place();
    }
    // A manually placed doorway is kept through tracking loss on purpose: ARCore
    // usually recovers the same world frame, and "does it come back to the same
    // spot" is one of the things to observe on the device.
  }

  private place(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const camera = context.getCameraPose();
    if (!camera) {
      // Tracking is NORMAL but no camera transform has arrived yet: try again shortly.
      this.setStatus('localizing', 'waiting for the first camera pose');
      setTimeout(() => {
        if (this.context === context && !this.placed) {
          this.handleTracking(context.getTrackingState());
        }
      }, 250);
      return;
    }

    const heading = horizontalDirection(camera.forward);
    if (!heading) {
      this.setStatus('localizing', 'hold the phone upright to place the doorway');
      context.log('manual: camera points straight up/down, heading undefined');
      setTimeout(() => {
        if (this.context === context && !this.placed) {
          this.handleTracking(context.getTrackingState());
        }
      }, 500);
      return;
    }

    const detectedFloorY = context.getFloorY();
    const floorIsPlausible =
      detectedFloorY !== null &&
      camera.position[1] - detectedFloorY >= this.options.minFloorBelowCameraM;
    const floorY = floorIsPlausible
      ? (detectedFloorY as number)
      : camera.position[1] - this.options.assumedCameraHeightM;

    const ahead = add(camera.position, scale(heading, this.options.distanceM));
    const position: Vec3 = [ahead[0], floorY, ahead[2]];
    // The doorway's local +Z must look back at the user.
    const yaw = yawFacing(scale(heading, -1));

    this.placed = true;
    this.emitPose({
      pose: { position, rotation: [0, yaw, 0] },
      quality: {
        note: floorIsPlausible
          ? 'floor: detected horizontal plane'
          : `floor: assumed ${this.options.assumedCameraHeightM} m below the camera`,
      },
    });
    this.setStatus('localized', floorIsPlausible ? 'floor from plane' : 'floor assumed');
  }
}
