import type {
  LocalizationContext,
  LocalizationProvider,
  LocalizationStatus,
  PoseUpdate,
  ProviderId,
  StatusMeta,
  Unsubscribe,
} from './types';

type StatusListener = (status: LocalizationStatus, detail: string, meta: StatusMeta) => void;
type PoseListener = (update: PoseUpdate) => void;

/**
 * Listener bookkeeping shared by all providers. Subclasses implement
 * `onStart`, `onStop` and `relocalize`, and call `setStatus` / `emitPose`.
 */
export abstract class BaseProvider implements LocalizationProvider {
  abstract readonly id: ProviderId;
  abstract readonly displayName: string;

  protected context: LocalizationContext | null = null;

  private status: LocalizationStatus = 'idle';
  private statusDetail = '';
  private statusMeta: StatusMeta = {};
  private readonly statusListeners = new Set<StatusListener>();
  private readonly poseListeners = new Set<PoseListener>();

  start(context: LocalizationContext): void {
    if (this.context) {
      this.stop();
    }
    this.context = context;
    this.onStart(context);
  }

  stop(): void {
    if (!this.context) {
      return;
    }
    this.onStop();
    this.context = null;
    this.setStatus('idle', '');
  }

  getStatus(): LocalizationStatus {
    return this.status;
  }

  getStatusDetail(): string {
    return this.statusDetail;
  }

  onStatus(listener: StatusListener): Unsubscribe {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onPose(listener: PoseListener): Unsubscribe {
    this.poseListeners.add(listener);
    return () => {
      this.poseListeners.delete(listener);
    };
  }

  abstract relocalize(): void;

  protected abstract onStart(context: LocalizationContext): void;
  protected abstract onStop(): void;

  protected setStatus(status: LocalizationStatus, detail = '', meta: StatusMeta = {}): void {
    if (status === this.status && detail === this.statusDetail && JSON.stringify(meta) === JSON.stringify(this.statusMeta)) {
      return;
    }
    this.status = status;
    this.statusDetail = detail;
    this.statusMeta = meta;
    this.statusListeners.forEach((listener) => listener(status, detail, meta));
  }

  protected emitPose(update: Omit<PoseUpdate, 'source' | 'timestampMs'>): void {
    const full: PoseUpdate = { ...update, source: this.id, timestampMs: Date.now() };
    this.poseListeners.forEach((listener) => listener(full));
  }
}
