import {
  ViroAmbientLight,
  ViroARScene,
  ViroARTrackingReasonConstants,
  ViroBox,
  ViroDirectionalLight,
  ViroSphere,
  ViroTrackingStateConstants,
} from '@reactvision/react-viro';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { createProvider } from '../localization';
import { formatVec3 } from '../localization/math';
import type {
  CameraPose,
  LocalizationContext,
  LocalizationProvider,
  TrackingState,
  Vec3,
} from '../localization/types';
import { appActions, useAppState } from '../state/appStore';
import { DoorPortal } from './DoorPortal';
import { LIGHT_MASK_AR } from './doorGeometry';
import './materials';

/** The overlay shows the camera position at most this often. */
const CAMERA_PUBLISH_INTERVAL_MS = 250;

const TRACKING_STATE_NAMES: Record<number, TrackingState> = {
  [ViroTrackingStateConstants.TRACKING_UNAVAILABLE]: 'unavailable',
  [ViroTrackingStateConstants.TRACKING_LIMITED]: 'limited',
  [ViroTrackingStateConstants.TRACKING_NORMAL]: 'normal',
};

const TRACKING_REASON_NAMES: Record<number, string> = {
  [ViroARTrackingReasonConstants.TRACKING_REASON_NONE]: '',
  [ViroARTrackingReasonConstants.TRACKING_REASON_EXCESSIVE_MOTION]: 'excessive motion',
  [ViroARTrackingReasonConstants.TRACKING_REASON_INSUFFICIENT_FEATURES]: 'insufficient features',
  [ViroARTrackingReasonConstants.TRACKING_REASON_INSUFFICIENT_LIGHT]: 'insufficient light',
};

interface PlaneAnchor {
  anchorId: string;
  type?: string;
  alignment?: string;
  position?: number[];
}

interface SceneProps {
  /** Injected by ViroARSceneNavigator. */
  arSceneNavigator?: unknown;
}

/**
 * The single AR scene of the app.
 *  - Task 1: camera feed (drawn by ViroARScene itself) + a few primitives in front of the user.
 *  - Feeds tracking state, camera pose and detected floor height into the store / the
 *    localization provider.
 *  - Mounts the doorway portal at the pose delivered by the active provider.
 */
export function PortalARScene(props: SceneProps) {
  const providerId = useAppState((s) => s.providerId);
  const relocalizeNonce = useAppState((s) => s.relocalizeNonce);
  const door = useAppState((s) => s.door);
  const attachMode = useAppState((s) => s.attachMode);

  const cameraRef = useRef<CameraPose | null>(null);
  const lastCameraPublishRef = useRef(0);
  const trackingRef = useRef<TrackingState>('unavailable');
  const trackingListenersRef = useRef(new Set<(state: TrackingState) => void>());
  /** anchorId -> world Y of every horizontal plane ARCore currently reports. */
  const planesRef = useRef(new Map<string, number>());
  const floorYRef = useRef<number | null>(null);
  const navigatorRef = useRef<unknown>(props.arSceneNavigator);
  navigatorRef.current = props.arSceneNavigator;
  const sceneRef = useRef<ViroARScene>(null);

  /**
   * Asks the native side for the camera pose right now. `onCameraTransformUpdate` is the
   * normal source, but it may not have fired yet (or not recently) when a provider needs
   * the pose, e.g. at the moment tracking becomes NORMAL or when "Re-place" is pressed.
   */
  const refreshCameraPose = useCallback(async () => {
    try {
      const result = await sceneRef.current?.getCameraOrientationAsync();
      if (result?.position?.length === 3 && result?.forward?.length === 3) {
        cameraRef.current = {
          position: result.position as Vec3,
          rotation: result.rotation as Vec3,
          forward: result.forward as Vec3,
          up: result.up as Vec3,
        };
      }
    } catch (error) {
      appActions.log(`camera pose query failed: ${String(error)}`);
    }
  }, []);

  // ---- what providers may ask from the AR session -------------------------------------
  const context = useMemo<LocalizationContext>(
    () => ({
      getCameraPose: () => cameraRef.current,
      getTrackingState: () => trackingRef.current,
      onTrackingState: (listener) => {
        trackingListenersRef.current.add(listener);
        return () => {
          trackingListenersRef.current.delete(listener);
        };
      },
      getFloorY: () => floorYRef.current,
      getArSceneNavigator: () => navigatorRef.current,
      log: appActions.log,
    }),
    [],
  );

  // ---- provider life cycle ------------------------------------------------------------
  const providerRef = useRef<LocalizationProvider | null>(null);

  useEffect(() => {
    const provider = createProvider(providerId);
    providerRef.current = provider;
    const offPose = provider.onPose((update) => {
      // The one and only place where a provider result moves the portal.
      appActions.setDoorPose(update);
      appActions.log(
        `door pose from ${update.source}: pos ${formatVec3(update.pose.position)} ` +
          `yaw ${update.pose.rotation[1].toFixed(1)}` +
          (update.quality?.note ? ` (${update.quality.note})` : ''),
      );
    });
    const offStatus = provider.onStatus((status, detail) => {
      appActions.setProviderStatus(status, detail);
      appActions.log(`provider ${provider.id}: ${status}${detail ? ` - ${detail}` : ''}`);
    });
    appActions.log(`provider selected: ${provider.displayName}`);
    provider.start(context);
    return () => {
      offPose();
      offStatus();
      provider.stop();
      providerRef.current = null;
    };
  }, [providerId, context]);

  useEffect(() => {
    if (relocalizeNonce > 0) {
      appActions.log('re-place / re-localize requested');
      refreshCameraPose().finally(() => providerRef.current?.relocalize());
    }
  }, [relocalizeNonce, refreshCameraPose]);

  // ---- AR session callbacks -----------------------------------------------------------
  const onTrackingUpdated = useCallback(
    (state: number, reason: number) => {
      const name = TRACKING_STATE_NAMES[state] ?? 'unavailable';
      const reasonName = TRACKING_REASON_NAMES[reason] ?? '';
      const changed = name !== trackingRef.current;
      trackingRef.current = name;
      appActions.setTracking(name, reasonName);
      if (!changed) {
        return;
      }
      appActions.log(`tracking: ${name.toUpperCase()}${reasonName ? ` (${reasonName})` : ''}`);
      const notify = () => {
        // Skip if the state changed again while the camera pose was being fetched.
        if (trackingRef.current === name) {
          trackingListenersRef.current.forEach((listener) => listener(name));
        }
      };
      if (name === 'normal' && !cameraRef.current) {
        refreshCameraPose().finally(notify);
      } else {
        notify();
      }
    },
    [refreshCameraPose],
  );

  const onCameraTransformUpdate = useCallback(
    (transform: { position: number[]; rotation: number[]; forward: number[]; up: number[] }) => {
      cameraRef.current = {
        position: transform.position as Vec3,
        rotation: transform.rotation as Vec3,
        forward: transform.forward as Vec3,
        up: transform.up as Vec3,
      };
      const now = Date.now();
      if (now - lastCameraPublishRef.current >= CAMERA_PUBLISH_INTERVAL_MS) {
        lastCameraPublishRef.current = now;
        appActions.setCamera(cameraRef.current.position, cameraRef.current.forward);
      }
    },
    [],
  );

  const publishFloor = useCallback(() => {
    let lowest: number | null = null;
    planesRef.current.forEach((y) => {
      if (lowest === null || y < lowest) {
        lowest = y;
      }
    });
    if (lowest !== floorYRef.current) {
      const first = floorYRef.current === null && lowest !== null;
      floorYRef.current = lowest;
      appActions.setFloorY(lowest);
      if (first) {
        appActions.log(`first horizontal plane at y=${Number(lowest).toFixed(2)}`);
      }
    }
  }, []);

  const onPlaneAnchor = useCallback(
    (anchor: PlaneAnchor) => {
      if (!anchor || anchor.type !== 'plane' || !anchor.position) {
        return;
      }
      // "Horizontal" (ARCore upward facing), "HorizontalUpward"; ceilings are skipped.
      const alignment = anchor.alignment ?? '';
      if (!alignment.startsWith('Horizontal') || alignment === 'HorizontalDownward') {
        return;
      }
      planesRef.current.set(anchor.anchorId, anchor.position[1]);
      publishFloor();
    },
    [publishFloor],
  );

  const onAnchorRemoved = useCallback(
    (anchor?: PlaneAnchor) => {
      if (anchor?.anchorId && planesRef.current.delete(anchor.anchorId)) {
        publishFloor();
      }
    },
    [publishFloor],
  );

  return (
    <ViroARScene
      ref={sceneRef}
      onTrackingUpdated={onTrackingUpdated}
      onCameraTransformUpdate={onCameraTransformUpdate}
      onAnchorFound={onPlaneAnchor}
      onAnchorUpdated={onPlaneAnchor}
      onAnchorRemoved={onAnchorRemoved}
    >
      {/* Lights for the AR-side objects. */}
      <ViroAmbientLight color="#ffffff" intensity={350} influenceBitMask={LIGHT_MASK_AR} />
      <ViroDirectionalLight
        color="#ffffff"
        direction={[-0.4, -1, -0.6]}
        intensity={700}
        influenceBitMask={LIGHT_MASK_AR}
      />

      {/* Task 1: basic 3D objects in front of the user (session origin looks along -Z). */}
      <ViroBox
        position={[-0.35, -0.25, -1.2]}
        rotation={[0, 30, 0]}
        width={0.2}
        height={0.2}
        length={0.2}
        materials={['arBox']}
        lightReceivingBitMask={LIGHT_MASK_AR}
      />
      <ViroSphere
        position={[0.35, -0.25, -1.2]}
        radius={0.11}
        materials={['arSphere']}
        lightReceivingBitMask={LIGHT_MASK_AR}
      />

      {door ? (
        // `key` re-mounts the portal when the attach mode changes, so each mode starts clean.
        <DoorPortal key={attachMode} pose={door.pose} attachMode={attachMode} />
      ) : null}
    </ViroARScene>
  );
}
