import {
  Viro3DObject,
  ViroNode,
  ViroPortal,
  ViroPortalScene,
  ViroSkyBox,
} from '@reactvision/react-viro';
import { useCallback, useMemo } from 'react';

import { add, rotateByViroEuler } from '../localization/math';
import type { Pose, Vec3 } from '../localization/types';
import { appActions, type AttachMode } from '../state/appStore';
import { DOOR_ORIGIN_HEIGHT } from './doorGeometry';
import { VirtualRoom } from './VirtualRoom';

interface DoorPortalProps {
  /** Doorway pose: on the floor, middle of the threshold, local +Z towards the AR side. */
  pose: Pose;
  attachMode: AttachMode;
}

/** From the door pose (floor level) up to the portal origin (centre of the opening). */
const ORIGIN_OFFSET: Vec3 = [0, DOOR_ORIGIN_HEIGHT, 0];

/**
 * The walk-through doorway: door frame + the virtual room seen through it.
 *
 * Scene graph (the order of the ViroPortalScene children follows the ViroReact samples):
 *
 *   ViroPortalScene (passable)          origin = centre of the opening
 *     ViroPortal
 *       Viro3DObject door_frame.obj     frame + transparent "window" quad
 *     ViroSkyBox                        background of the inner world (hides the camera feed)
 *     ViroNode (y = -DOOR_ORIGIN_HEIGHT)
 *       VirtualRoom                     floor-level coordinates
 *
 * `attachMode` only changes WHO carries the door pose:
 *   'direct' - the ViroPortalScene itself (direct child of ViroARScene);
 *   'parent' - a plain ViroNode above it (the portal scene sits at a fixed local offset).
 * Both must look identical; the switch exists to compare how the native side behaves when
 * the pose is updated (auto-anchoring of scene children, portals under moving parents).
 */
export function DoorPortal({ pose, attachMode }: DoorPortalProps) {
  const onPortalEnter = useCallback(() => {
    appActions.setMode('VR');
    appActions.log('portal ENTER -> VR');
  }, []);

  const onPortalExit = useCallback(() => {
    appActions.setMode('AR');
    appActions.log('portal EXIT -> AR');
  }, []);

  const directPosition = useMemo(
    () => add(pose.position, rotateByViroEuler(ORIGIN_OFFSET, pose.rotation)),
    [pose],
  );

  const portal = (position: Vec3, rotation: Vec3) => (
    <ViroPortalScene
      passable={true}
      position={position}
      rotation={rotation}
      onPortalEnter={onPortalEnter}
      onPortalExit={onPortalExit}
    >
      <ViroPortal>
        <Viro3DObject
          source={require('../../assets/models/door_frame.obj')}
          type="OBJ"
          materials={['doorFrame']}
          onError={(event) =>
            appActions.log(`door model ERROR: ${JSON.stringify(event?.nativeEvent ?? {})}`)
          }
          onLoadEnd={() => appActions.log('door model loaded')}
        />
      </ViroPortal>
      <ViroSkyBox color="#070716" />
      <ViroNode position={[0, -DOOR_ORIGIN_HEIGHT, 0]}>
        <VirtualRoom />
      </ViroNode>
    </ViroPortalScene>
  );

  if (attachMode === 'parent') {
    return (
      <ViroNode position={pose.position} rotation={pose.rotation}>
        {portal(ORIGIN_OFFSET, [0, 0, 0])}
      </ViroNode>
    );
  }
  return portal(directPosition, pose.rotation);
}
