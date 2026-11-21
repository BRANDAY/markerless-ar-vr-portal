/**
 * Second way to keep the doorway in place: a cloud anchor of a ready-made service
 * (Google ARCore Cloud Anchors through ViroReact's own calls). The self-hosted server
 * stays the main way; this provider needs internet instead of a PC in the venue.
 *
 * What it does in a session: reads the record saved on this phone (`doorRecordStore.ts`),
 * asks the service to find the anchor from the camera view (`resolveCloudAnchor`) and
 * emits the doorway that was written down relative to that anchor. The service only
 * returns the anchor; where the door opening is was decided when the doorway was saved
 * (`saveDoorToCloud.ts`), by the self-hosted server or by hand.
 *
 * Needs a build of the app made with a cloud provider (`provider="arcore"` on
 * `ViroARSceneNavigator`, see `docs/cloud/cloud-connection.md`). In a build without one
 * the status says so and nothing is placed.
 *
 * All rules live in `core/resolveSession.ts` (unit-tested); this class only connects
 * them to the app.
 */
import { BaseProvider } from '../BaseProvider';
import type { LocalizationContext, ProviderId, Unsubscribe } from '../types';
import { cloudAnchorApiFrom } from './core/cloudAnchorApi';
import type { CloudDoorRecord } from './core/doorRecord';
import { type ResolveOptions, ResolveSession } from './core/resolveSession';
import { loadDoorRecord } from './doorRecordStore';

export interface CloudAnchorDoorOptions extends Partial<ResolveOptions> {
  /** Where the record comes from; the phone's own file by default. */
  loadRecord?: () => Promise<CloudDoorRecord | null>;
}

export class CloudAnchorDoorProvider extends BaseProvider {
  readonly id: ProviderId = 'arcore-cloud-anchor';
  readonly displayName = 'Cloud anchor (Google ARCore)';

  private session: ResolveSession | null = null;
  private unsubscribeTracking: Unsubscribe | null = null;
  /** Changes at every start and stop, so a record that arrives late is dropped. */
  private run = 0;

  constructor(private readonly options: CloudAnchorDoorOptions = {}) {
    super();
  }

  protected onStart(context: LocalizationContext): void {
    const run = ++this.run;
    const { loadRecord = loadDoorRecord, ...resolveOptions } = this.options;
    const session = new ResolveSession(
      {
        getApi: () => cloudAnchorApiFrom(context.getArSceneNavigator()),
        now: () => Date.now(),
        schedule: (fn, delayMs) => {
          const timer = setTimeout(fn, delayMs);
          return () => clearTimeout(timer);
        },
        log: (message) => context.log(message),
        getTracking: () => context.getTrackingState(),
        onStatus: (status, detail, meta) => this.setStatus(status, detail, meta),
        onDoor: (update) =>
          this.emitPose({
            pose: update.pose,
            opening: update.opening,
            automatic: update.automatic,
            quality: { note: update.note },
          }),
        onReport: (report) => context.reportLocalization(report),
      },
      resolveOptions,
    );
    this.session = session;
    this.setStatus('connected', 'reading the saved doorway');
    this.unsubscribeTracking = context.onTrackingState((state) => session.onTracking(state));
    void loadRecord()
      .catch(() => null)
      .then((record) => {
        if (run === this.run) {
          session.start(record);
        }
      });
  }

  protected onStop(): void {
    this.run++;
    this.unsubscribeTracking?.();
    this.unsubscribeTracking = null;
    this.session?.stop();
    this.session = null;
  }

  relocalize(): void {
    this.session?.relocalize();
  }
}
