import { Viro3DObject, ViroNode } from '@reactvision/react-viro';

/**
 * Facts about the "Sponza atrium" environment. Numbers come from the build
 * (`assets/environments/sponza_atrium/build/stats.json`).
 */
export const SPONZA_ATRIUM = {
  id: 'sponza_atrium',
  title: 'Atrium of the Sponza Palace, Dubrovnik',
  /** Metres, doorway frame: X across the doorway, Y up, Z towards the real side. */
  bounds: { min: [-6.1, 0, -27.4], max: [6.5, 13.4, 0] },
  /** Free floor straight ahead of the threshold before the first columns (metres). */
  clearDepth: 4.4,
  /** Half-width of the free floor near the threshold (two big vases stand 4.1 m off the axis). */
  clearHalfWidth: 3.0,
  triangles: 414024,
  fileBytes: 21739648,
} as const;

export interface SponzaAtriumProps {
  /**
   * The wall that contains the doorway, seen when the visitor turns around inside.
   * It is a separate single-sided model 1 cm on the REAL side of the doorway plane, so that it
   * never hides the view into the hall from outside. Switch it off if a device shows that wall
   * through the doorway from the real side (that would mean back-face culling is not applied).
   */
  showBackWall?: boolean;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onError?: (message: string) => void;
}

/**
 * The virtual world behind the portal: the atrium of the Sponza Palace (Dubrovnik, 16th century),
 * after the "Crytek Sponza" model (CC BY 3.0, see `assets/environments/sponza_atrium/LICENSES.md`).
 *
 * Local frame (the same as `VirtualRoom`): origin ON THE FLOOR in the middle of the threshold,
 * +Y up, the scene extends towards -Z, +Z is the real-world side. Scale 1:1, metres. The doorway
 * is in the middle of an end wall and looks down the 27 m long axis of the atrium.
 *
 * Lighting is baked into vertex colours and every material is unlit (`KHR_materials_unlit`,
 * ViroReact "Constant"), so the scene needs NO lights and no light bit masks: lights of the AR
 * side cannot change it and it cannot light AR objects. The sky is a dome inside the model.
 *
 * Nothing here depends on the size of the doorway.
 */
export function SponzaAtrium({ showBackWall = true, onLoadStart, onLoadEnd, onError }: SponzaAtriumProps) {
  return (
    <ViroNode>
      <Viro3DObject
        source={require('../../assets/environments/sponza_atrium/sponza_atrium.glb')}
        type="GLB"
        onLoadStart={onLoadStart}
        onLoadEnd={onLoadEnd}
        onError={(event) => onError?.(JSON.stringify(event?.nativeEvent ?? {}))}
      />
      {showBackWall ? (
        <Viro3DObject
          source={require('../../assets/environments/sponza_atrium/sponza_atrium_backwall.glb')}
          type="GLB"
          onError={(event) => onError?.(JSON.stringify(event?.nativeEvent ?? {}))}
        />
      ) : null}
    </ViroNode>
  );
}
