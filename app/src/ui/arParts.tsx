/**
 * Pieces the staff AR screen and the visitor screen share: what both show inside the
 * space (`docs/product/ui-spec.md`, 5.9 "Inside the space").
 */
import { t } from '../i18n';
import { useRoomScan } from '../room/roomStore';
import type { SpaceInfo } from '../spaces/spaces';
import { useAppState } from '../state/appStore';
import { doorOutOfView, nearestWall, WALL_WARNING } from './core/insideView';
import { AppButton, Body, Eyebrow, HudPill, Sheet, SheetTitle, Small } from './kit';

/** True while the user is inside the space and the phone is close to a real wall of the room. */
export function useWallClose(): boolean {
  const inside = useAppState((s) => s.mode === 'VR');
  const camera = useAppState((s) => (s.mode === 'VR' ? s.cameraPosition : null));
  const walls = useRoomScan((s) => s.serverPlan?.room?.walls);
  if (!inside || !camera || !walls) {
    return false;
  }
  const near = nearestWall(camera, walls);
  return near !== null && near.distance < WALL_WARNING.startM;
}

/** "Door is behind you", while the door is out of the view. */
export function DoorBehindPill() {
  const camera = useAppState((s) => s.cameraPosition);
  const forward = useAppState((s) => s.cameraForward);
  const door = useAppState((s) => s.door);
  if (!camera || !forward || !door || !doorOutOfView(camera, forward, door.pose.position)) {
    return null;
  }
  return <HudPill text={t('ar.inside.behind')} icon="turn" />;
}

/** "About this place": where and from when, the name, a paragraph, the model's credit. */
export function AboutSheet({ space, onClose }: { space: SpaceInfo; onClose: () => void }) {
  return (
    <Sheet onClose={onClose}>
      {space.place ? <Eyebrow>{[t(space.place), space.date ? t(space.date) : ''].filter(Boolean).join(' · ')}</Eyebrow> : null}
      <SheetTitle>{t(space.name)}</SheetTitle>
      {space.about ? <Body dim>{t(space.about)}</Body> : null}
      {space.credit ? <Small>{t(space.credit)}</Small> : null}
      <AppButton kind="ghost" label={t('common.close')} onPress={onClose} />
    </Sheet>
  );
}
