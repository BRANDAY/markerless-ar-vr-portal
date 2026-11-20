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
import { DoorCasing, DoorLeaf, doorCasingOriginHeight } from '../environments/DoorCasing';
import { SponzaAtrium } from '../environments/SponzaAtrium';
import { appActions, type AttachMode, type EnvironmentId, type FrameId } from '../state/appStore';
import { DOOR, DOOR_ORIGIN_HEIGHT } from './doorGeometry';
import { VirtualRoom } from './VirtualRoom';

interface DoorPortalProps {
  /** Doorway pose: on the floor, middle of the threshold, local +Z towards the AR side. */
  pose: Pose;
  attachMode: AttachMode;
  environment: EnvironmentId;
  frame: FrameId;
  /**
   * Clear size of the real doorway the frame has to fit, metres (from the server's room
   * plan). Without it - a door placed by hand - the frame has the default size
   * `DOOR.openingWidth` x `DOOR.openingHeight`.
   */
  opening?: { width: number; height: number };
}

/**
 * The walk-through doorway: door frame + the virtual world seen through it.
 *
 * Scene graph (the order of the ViroPortalScene children follows the ViroReact samples):
 *
 *   ViroPortalScene (passable)          origin = centre of the opening
 *     ViroPortal
 *       DoorCasing                      frame 'casing': seven Viro3DObjects, the last one the
 *                                       transparent "window"
 *       | Viro3DObject door_frame.obj   frame 'simple': one model with its own window
 *     ViroSkyBox                        background of the inner world (hides the camera feed)
 *     ViroNode (y = -origin height)     floor-level coordinates
 *       SponzaAtrium | VirtualRoom
 *       DoorLeaf                        open plank door, with the casing in the atrium only
 *
 * Both frames take the size of the real doorway. The casing stretches each part only along
 * its own length, so its moulding keeps its cross-section. The simple frame is one model
 * scaled in X and Y, which also changes the thickness of its posts.
 *
 * The door leaf is shown open and does not move: its swing animation has not been tried
 * on a device. It is left out in the test room, whose front wall is 6 cm behind the leaf
 * and would cut through it.
 *
 * `attachMode` only changes WHO carries the door pose:
 *   'direct' - the ViroPortalScene itself (direct child of ViroARScene);
 *   'parent' - a plain ViroNode above it (the portal scene sits at a fixed local offset).
 * Both must look identical; the switch exists to compare how the native side behaves when
 * the pose is updated (auto-anchoring of scene children, portals under moving parents).
 */
export function DoorPortal({ pose, attachMode, environment, frame, opening }: DoorPortalProps) {
  const width = opening?.width ?? DOOR.openingWidth;
  const height = opening?.height ?? DOOR.openingHeight;
  const casing = frame === 'casing';
  const scaleX = width / DOOR.openingWidth;
  const scaleY = height / DOOR.openingHeight;
  /** From the door pose (floor level) up to the portal origin (centre of the opening). */
  const originHeight = casing ? doorCasingOriginHeight(height) : DOOR_ORIGIN_HEIGHT * scaleY;
  const originOffset = useMemo<Vec3>(() => [0, originHeight, 0], [originHeight]);

  const onPortalEnter = useCallback(() => {
    appActions.setMode('VR');
    appActions.log('portal ENTER -> VR');
  }, []);

  const onPortalExit = useCallback(() => {
    appActions.setMode('AR');
    appActions.log('portal EXIT -> AR');
  }, []);

  const directPosition = useMemo(
    () => add(pose.position, rotateByViroEuler(originOffset, pose.rotation)),
    [pose, originOffset],
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
        {casing ? (
          <DoorCasing
            width={width}
            height={height}
            onLoadEnd={() =>
              appActions.log(`door casing loaded (${width.toFixed(2)} x ${height.toFixed(2)} m)`)
            }
            onError={(message) => appActions.log(`door casing ERROR: ${message}`)}
          />
        ) : (
          <Viro3DObject
            source={require('../../assets/models/door_frame.obj')}
            type="OBJ"
            scale={[scaleX, scaleY, 1]}
            materials={['doorFrame']}
            onError={(event) =>
              appActions.log(`door model ERROR: ${JSON.stringify(event?.nativeEvent ?? {})}`)
            }
            onLoadEnd={() => appActions.log('door model loaded')}
          />
        )}
      </ViroPortal>
      <ViroSkyBox color="#070716" />
      <ViroNode position={[0, -originHeight, 0]}>
        {environment === 'sponza' ? (
          <SponzaAtrium
            onLoadStart={() => appActions.log('environment: loading the Sponza atrium...')}
            onLoadEnd={() => appActions.log('environment: Sponza atrium loaded')}
            onError={(message) => appActions.log(`environment ERROR: ${message}`)}
          />
        ) : (
          <VirtualRoom />
        )}
        {casing && environment === 'sponza' ? (
          <DoorLeaf
            width={width}
            height={height}
            animated={false}
            onError={(message) => appActions.log(`door leaf ERROR: ${message}`)}
          />
        ) : null}
      </ViroNode>
    </ViroPortalScene>
  );

  if (attachMode === 'parent') {
    return (
      <ViroNode position={pose.position} rotation={pose.rotation}>
        {portal(originOffset, [0, 0, 0])}
      </ViroNode>
    );
  }
  return portal(directPosition, pose.rotation);
}
