import { BaseProvider } from './BaseProvider';
import { INTERRUPTION_GRACE_MS, TrackingWatch } from './core/relocalization';
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
  private watch = new TrackingWatch();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: Partial<ManualPlacementOptions> = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  protected onStart(context: LocalizationContext): void {
    this.placed = false;
    this.watch = new TrackingWatch();
    this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL');
    this.unsubscribeTracking = context.onTrackingState((state) => this.handleTracking(state));
    this.handleTracking(context.getTrackingState());
  }

  protected onStop(): void {
    this.unsubscribeTracking?.();
    this.unsubscribeTracking = null;
    this.placed = false;
    this.clearGraceTimer();
  }

  private clearGraceTimer(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
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
    // A door placed by hand has nothing to be checked against: when tracking is
    // interrupted it stays where it is, and the status says that it may be off.
    const context = this.context;
    const event = this.watch.onState(state, Date.now());
    if (event?.kind === 'left-normal' && this.placed) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.context === context && this.placed && this.watch.isInterrupted(Date.now())) {
          context?.log('manual: tracking lost - the door stays where it was');
          this.setStatus(
            'lost',
            'tracking lost - the door stays where it was, but it may be off. Move the phone slowly over a part of the room with detail',
          );
        }
      }, INTERRUPTION_GRACE_MS + 50);
    } else if (event?.kind === 'hiccup') {
      this.clearGraceTimer();
    } else if (event?.kind === 'recovered') {
      this.clearGraceTimer();
      if (this.placed) {
        context?.log(`manual: tracking is back after ${(event.gapMs / 1000).toFixed(1)} s - the door was kept where it was`);
        this.setStatus(
          'localized',
          'tracking is back; the door was kept where it was - press "Re-place door" if it has moved',
        );
      }
    }
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
    context.reportLocalization({ event: 'placed', reason: 'by-hand', attempts: 0, elapsedMs: null, trusted: true });
  }
}
