import { ViroBox, ViroNode } from '@reactvision/react-viro';

import { type Mark, useMeasure } from '../measure/measureController';
import './materials';

const POST_HEIGHT_M = 0.4;
const POST_WIDTH_M = 0.012;
const FOOT_M = 0.04;
const FOOT_HEIGHT_M = 0.004;

/**
 * Measurement mode: a thin post on every marked corner of the real door opening, so that
 * the user sees where a mark landed in the room and whether it still stands there after
 * walking around or after an interruption of tracking. Magenta = left, cyan = right,
 * grey = made before tracking was interrupted.
 */
export function MeasureLayer() {
  const visible = useMeasure((s) => s.visible);
  const left = useMeasure((s) => s.left);
  const right = useMeasure((s) => s.right);
  const stale = useMeasure((s) => s.stale);
  if (!visible) {
    return null;
  }
  return (
    <>
      {left ? <Post mark={left} material={stale ? 'measureStale' : 'measureLeft'} /> : null}
      {right ? <Post mark={right} material={stale ? 'measureStale' : 'measureRight'} /> : null}
    </>
  );
}

function Post({ mark, material }: { mark: Mark; material: string }) {
  return (
    <ViroNode position={mark.point}>
      {/* A flat foot shows the marked point itself; the post makes it visible from afar. */}
      <ViroBox
        position={[0, FOOT_HEIGHT_M / 2, 0]}
        width={FOOT_M}
        height={FOOT_HEIGHT_M}
        length={FOOT_M}
        materials={[material]}
      />
      <ViroBox
        position={[0, POST_HEIGHT_M / 2, 0]}
        width={POST_WIDTH_M}
        height={POST_HEIGHT_M}
        length={POST_WIDTH_M}
        materials={[material]}
      />
    </ViroNode>
  );
}
