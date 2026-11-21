/**
 * STUB - NOT IMPLEMENTED.
 *
 * One of the planned localization back-ends (the self-hosted server and ReactVision
 * Advanced VPS have their own files: `SelfHostedServerProvider.ts`,
 * `ReactVisionVpsProvider.ts`). The class satisfies the `LocalizationProvider`
 * interface and reports status `error` / "not implemented". There is deliberately NO
 * network code, no API key handling and no SDK call in this file.
 *
 * Filling one in means: implement `onStart` (begin localizing), call
 * `emitPose({ pose, quality })` with the DOORWAY pose expressed in the AR-world
 * frame of the current session, keep `setStatus` up to date, implement
 * `relocalize` and clean up in `onStop`.
 */
import { BaseProvider } from './BaseProvider';
import type { LocalizationContext, ProviderId } from './types';

abstract class NotImplementedProvider extends BaseProvider {
  /** One line telling the reader what the real implementation will need. */
  protected abstract readonly plan: string;

  protected onStart(context: LocalizationContext): void {
    this.setStatus('error', 'not implemented (stage 2)');
    context.log(`${this.id}: STUB - ${this.plan}`);
  }

  protected onStop(): void {
    // Nothing to release.
  }

  relocalize(): void {
    this.context?.log(`${this.id}: STUB - relocalize() does nothing yet`);
  }
}

/**
 * STUB: Google ARCore Cloud Anchors through ViroReact.
 *
 * Plan: build with the config-plugin options `provider: "arcore"` and
 * `googleCloudApiKey`; "setup" mode hosts an anchor at the doorway pose and stores
 * the returned cloud-anchor id; every later session resolves that id (via the
 * `arSceneNavigator` handle from `context.getArSceneNavigator()`) and emits the
 * resolved anchor pose. Needs: a Google Cloud project with the ARCore API enabled.
 */
export class ArCoreCloudAnchorProvider extends NotImplementedProvider {
  readonly id: ProviderId = 'arcore-cloud-anchor';
  readonly displayName = 'ARCore Cloud Anchor (stub)';
  protected readonly plan = 'needs a Google Cloud API key and a hosted cloud-anchor id';
}
