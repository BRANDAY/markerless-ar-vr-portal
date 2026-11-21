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
  PoseUpdate,
  TrackingState,
  Vec3,
} from '../localization/types';
import { measureController } from '../measure/measureController';
import { toPlaneAnchorData } from '../room/roomGeometry';
import { roomActions } from '../room/roomStore';
import { scanController } from '../room/scanController';
import { appActions, getAppState, useAppState } from '../state/appStore';
import { usePrefs } from '../state/prefs';
import { DoorOutline } from './DoorOutline';
import { DoorPortal } from './DoorPortal';
import { LIGHT_MASK_AR } from './doorGeometry';
import { MeasureLayer } from './MeasureLayer';
import { RoomScanLayer } from './RoomScanLayer';
import { ServerRoomLayer } from './ServerRoomLayer';
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
  const environment = useAppState((s) => s.environment);
  const frame = useAppState((s) => s.frame);
  const mode = useAppState((s) => s.mode);
  /** The door is looked for only while the AR screen is shown (not while scanning, not when covered). */
  const active = useAppState((s) => s.screen === 'ar');
  /** A first pose that is still being checked is drawn as an outline, not as the door. */
  const pending = useAppState((s) => s.providerMeta.pending === true);
  const testObjects = usePrefs((s) => s.developerOptions && s.testObjects);

  const cameraRef = useRef<CameraPose | null>(null);
  const lastCameraPublishRef = useRef(0);
  const trackingRef = useRef<TrackingState>('unavailable');
  const trackingListenersRef = useRef(new Set<(state: TrackingState) => void>());
  /** anchorId -> world Y of every horizontal plane ARCore currently reports. */
  const planesRef = useRef(new Map<string, number>());
  const floorYRef = useRef<number | null>(null);
  const navigatorRef = useRef<unknown>(props.arSceneNavigator);
  navigatorRef.current = props.arSceneNavigator;
  useEffect(() => {
    scanController.attach(props.arSceneNavigator);
  }, [props.arSceneNavigator]);
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

  /** A correction of the doorway that arrived while the user was inside the virtual world. */
  const heldPoseRef = useRef<PoseUpdate | null>(null);

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
      reportLocalization: (report) => measureController.onLocalization(report, heldPoseRef.current !== null),
    }),
    [],
  );

  useEffect(() => measureController.attach(context), [context]);

  // ---- provider life cycle ------------------------------------------------------------
  const providerRef = useRef<LocalizationProvider | null>(null);

  const applyPose = useCallback((update: PoseUpdate) => {
    // The one and only place where a provider result moves the portal.
    appActions.setDoorPose(update);
    appActions.log(
      `door pose from ${update.source}: pos ${formatVec3(update.pose.position)} ` +
        `yaw ${update.pose.rotation[1].toFixed(1)}` +
        (update.quality?.note ? ` (${update.quality.note})` : ''),
    );
  }, []);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const provider = createProvider(providerId);
    providerRef.current = provider;
    heldPoseRef.current = null;
    const offPose = provider.onPose((update) => {
      const app = getAppState();
      if (update.automatic && app.mode === 'VR' && app.door) {
        // Moving the portal around somebody who stands behind it would throw them out of
        // the virtual world (or leave them inside for good). The correction waits.
        heldPoseRef.current = update;
        appActions.log(`door correction from ${update.source} held back until the user is on the AR side again`);
        return;
      }
      heldPoseRef.current = null;
      applyPose(update);
    });
    const offStatus = provider.onStatus((status, detail, meta) => {
      appActions.setProviderStatus(status, detail, meta);
      appActions.log(`provider ${provider.id}: ${status}${detail ? ` - ${detail}` : ''}`);
    });
    appActions.log(`provider selected: ${provider.displayName}`);
    provider.start(context);
    return () => {
      offPose();
      offStatus();
      provider.stop();
      providerRef.current = null;
      // A door belongs to the visit of the AR screen it was found in.
      appActions.clearDoor();
    };
  }, [providerId, context, applyPose, active]);

  // What was learnt in this AR session is in this session's coordinates: when the view
  // goes, it goes too.
  useEffect(
    () => () => {
      roomActions.clearPlanes();
      roomActions.setServerPlan(null);
      roomActions.setScanning(false);
      measureController.resetSession();
      // The next AR view starts from "not tracking, no floor", not from this one's last word.
      appActions.setTracking('unavailable', '');
      appActions.setFloorY(null);
    },
    [],
  );

  useEffect(() => {
    const held = heldPoseRef.current;
    if (mode === 'AR' && held) {
      heldPoseRef.current = null;
      appActions.log('applying the door correction that was held back');
      applyPose(held);
    }
  }, [mode, applyPose]);

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
      // Every plane goes into the room model (walls, floor, ceiling, furniture).
      const plane = toPlaneAnchorData(anchor);
      if (plane) {
        roomActions.upsertPlane(plane);
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
      if (anchor?.anchorId) {
        roomActions.removePlane(anchor.anchorId);
      }
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
      onDepthReady={roomActions.setDepthReady}
    >
      {/* Lights for the AR-side objects. */}
      <ViroAmbientLight color="#ffffff" intensity={350} influenceBitMask={LIGHT_MASK_AR} />
      <ViroDirectionalLight
        color="#ffffff"
        direction={[-0.4, -1, -0.6]}
        intensity={700}
        influenceBitMask={LIGHT_MASK_AR}
      />

      {/* Task 1: basic 3D objects in front of the user (session origin looks along -Z).
          A developer option since the product screens: a visitor has no use for them. */}
      {testObjects ? (
        <>
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
        </>
      ) : null}

      <RoomScanLayer />
      <ServerRoomLayer />
      <MeasureLayer />

      {door && pending ? (
        <DoorOutline pose={door.pose} opening={door.opening} />
      ) : door ? (
        // `key` re-mounts the portal when the attach mode, the world or the frame changes, so each
        // starts clean.
        <DoorPortal
          key={`${attachMode}-${environment}-${frame}`}
          pose={door.pose}
          attachMode={attachMode}
          environment={environment}
          frame={frame}
          opening={door.opening}
        />
      ) : null}
    </ViroARScene>
  );
}
