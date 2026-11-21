import { ViroVPS } from '@reactvision/react-viro';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { vpsBridge } from '../localization/vpsBridge';

type ViroVpsProps = React.ComponentProps<typeof ViroVPS>;

/**
 * The library's `<ViroVPS>` for the ReactVision provider: it downloads the map of the
 * location the provider asks for, matches the camera against it and reports its state and
 * the camera's pose in that map. Nothing is drawn here - the door is placed by the
 * provider through the same path as every other door, not inside `<ViroVPSAnchor>`, which
 * would move it every frame, also while somebody is walking through it.
 *
 * The location is always named: `startTracking("auto")` starts from GPS, which the app
 * neither uses nor asks permission for.
 *
 * NOT RUN: neither on a device nor against the service.
 */
export function VpsLayer({ arSceneNavigator }: { arSceneNavigator: unknown }) {
  const request = useSyncExternalStore(vpsBridge.subscribeRequest, vpsBridge.getRequest, vpsBridge.getRequest);
  const vps = useRef<ViroVPS>(null);
  const locationId = request?.locationId ?? null;
  const nonce = request?.nonce ?? 0;
  const mode = request?.mode ?? 'device';

  useEffect(() => {
    const tracker = vps.current;
    if (!locationId || !tracker) {
      return undefined;
    }
    let live = true;
    tracker.startTracking(locationId).then(
      (result) => {
        if (live) {
          vpsBridge.report({
            kind: 'started',
            nonce,
            success: result.success,
            code: result.errorDetail?.code ?? '',
            message: result.error ?? '',
          });
        }
      },
      (error: unknown) => {
        if (live) {
          vpsBridge.report({ kind: 'started', nonce, success: false, code: 'UNKNOWN', message: String(error) });
        }
      },
    );
    return () => {
      live = false;
      tracker.stopTracking();
    };
  }, [locationId, nonce, mode]);

  return (
    <ViroVPS
      ref={vps}
      arSceneNavigator={arSceneNavigator as ViroVpsProps['arSceneNavigator']}
      localization={mode}
      onTrackingState={(event) =>
        vpsBridge.report({ kind: 'state', state: event.state, code: event.errorDetail?.code ?? '', message: event.error ?? '' })
      }
      onLocalized={(event) =>
        vpsBridge.report({ kind: 'localized', renderPose: event.renderPose, inliers: event.lastHitInliers ?? null })
      }
    />
  );
}
