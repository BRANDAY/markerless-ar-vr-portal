import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { saveDoorDraft, serverKeepsDoorSize } from '../room/doorServer';
import { roomName as nameOfRoom, useRooms } from '../room/roomsStore';
import { getRoomScanState, roomActions, useRoomScan } from '../room/roomStore';
import { appActions, getAppState, useAppState } from '../state/appStore';
import {
  type DoorDraft,
  doorInFront,
  doorSize,
  draftFromServer,
  moveDoor,
  putHere,
  resizeDoor,
  sameDoor,
  sizeLabel,
  turnAround,
  turnDoor,
} from './core/doorEdit';
import { foundDoorways, placeScreen, placeStart } from './core/placeView';
import { enterVisitorMode, homeScreen, openGuidedScan } from './flows';
import { Icon } from './icons';
import { AppButton, Body, CoachCard, HudButton, HudPill, Sheet, SheetTitle } from './kit';
import { useServerView } from './ServerPanel';
import { HUD, TYPE, useInsets } from './theme';

/** Holding a step button repeats the step: after this pause, this often. */
const REPEAT_AFTER_MS = 380;
const REPEAT_EVERY_MS = 110;
/** Until the camera has said where it looks, the first place of the door is tried again this often. */
const CAMERA_RETRY_MS = 300;

/**
 * "Place the door" (`docs/product/ui-spec.md`, 5.14): the staff member puts the door
 * where it should stand and saves it to the server; visitors then get it from there.
 *
 * The room has to be found in this AR session first, because the door is written down in
 * the room's frame through that (`roomStore.found`, set by the door layer). The door that
 * is being placed lives in the room store (`doorDraft`), where the AR scene reads it; the
 * steps themselves are in `core/doorEdit.ts`, and what is shown when in `core/placeView.ts`.
 */
export function PlaceDoorScreen() {
  const insets = useInsets();
  const status = useAppState((s) => s.providerStatus);
  const meta = useAppState((s) => s.providerMeta);
  const shownDoor = useAppState((s) => s.door);
  const tracking = useAppState((s) => s.trackingState);
  const trackingReason = useAppState((s) => s.trackingReason);
  const connection = useServerView().connection;
  const found = useRoomScan((s) => s.found);
  const draft = useRoomScan((s) => s.doorDraft);
  const currentRoom = useRooms((s) => s.currentId);
  const roomName = nameOfRoom(found?.mapId ?? currentRoom) || t('home.room.eyebrow');

  /** The door as it was when the staff member last had nothing to save. */
  const [baseline, setBaseline] = useState<DoorDraft | null>(null);
  const [touched, setTouched] = useState(false);
  const touchedRef = useRef(false);
  const [adjusting, setAdjusting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<'saved' | 'failed' | null>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [closedSheet, setClosedSheet] = useState(false);
  const nextDoorway = useRef(0);
  const [retry, setRetry] = useState(0);

  // Other phones draw a door of the default size unless the server stores the size.
  const sized = serverKeepsDoorSize();
  const plan = found?.plan ?? null;
  const portal = plan?.portal ?? null;
  const start = placeStart(portal ? { source: portal.source, hasPose: portal.position !== null } : null, !!portal?.suggested);
  const doorways = useMemo(() => foundDoorways(plan?.room?.openings ?? null, plan?.portal?.suggested ?? null), [plan]);

  const view = placeScreen({
    status,
    meta,
    hasDoor: shownDoor !== null,
    tracking,
    trackingReason,
    connection: connection.state,
    found: found !== null,
    start,
    touched,
  });
  const ready = view.ready;

  // The door is the screen's own: it goes when the screen does.
  useEffect(() => () => roomActions.setDoorDraft(null), []);

  // A search that ended with "no door saved" without having placed the map in this AR
  // session (the room was built in this very session, in the developer tools) has
  // nothing to save a door through: look for the room once more.
  const idleWithoutRoom = found === null && status === 'error' && meta.code === 'no-doorway';
  useEffect(() => {
    if (idleWithoutRoom) {
      appActions.requestRelocalize();
    }
  }, [idleWithoutRoom]);

  // Where the door first stands: at the saved place, else in the suggested doorway, else
  // two metres in front of the camera. As long as nothing has been changed by hand, a
  // better answer of the server moves it along.
  useEffect(() => {
    if (!ready || !plan || touchedRef.current) {
      return undefined;
    }
    const fit = (door: DoorDraft): DoorDraft => (sized ? door : { ...door, ...doorSize(null, null) });
    let next: DoorDraft | null = null;
    if (start === 'saved' && portal?.position && portal.rotation) {
      next = fit(draftFromServer({ position: portal.position, rotation: portal.rotation, width: portal.width, height: portal.height }));
    } else if (start === 'suggested' && portal?.suggested) {
      next = fit(draftFromServer(portal.suggested));
      nextDoorway.current = doorways.length > 1 ? 1 : 0;
    } else {
      if (getRoomScanState().doorDraft) {
        return undefined; // already standing in front of the camera
      }
      const { cameraPosition, cameraForward, floorY } = getAppState();
      next = cameraPosition && cameraForward ? doorInFront(cameraPosition, cameraForward, floorY, doorSize(null, null)) : null;
      if (!next) {
        const timer = setTimeout(() => setRetry((n) => n + 1), CAMERA_RETRY_MS);
        return () => clearTimeout(timer);
      }
    }
    roomActions.setDoorDraft(next);
    setBaseline(next);
    return undefined;
  }, [ready, plan, portal, start, sized, doorways.length, retry]);

  const changed = draft !== null && baseline !== null && !sameDoor(draft, baseline);

  /** A change by hand: from now on the door is the staff member's. */
  const edit = useCallback((change: (door: DoorDraft) => DoorDraft | null) => {
    const current = getRoomScanState().doorDraft;
    const next = current ? change(current) : null;
    if (next) {
      touchedRef.current = true;
      setTouched(true);
      roomActions.setDoorDraft(next);
    }
  }, []);

  const putItHere = () =>
    edit((door) => {
      const { cameraPosition, cameraForward, floorY } = getAppState();
      return cameraPosition && cameraForward ? putHere(cameraPosition, cameraForward, floorY, door) : null;
    });

  const useDoorway = () => {
    const option = doorways[nextDoorway.current % doorways.length];
    if (!option) {
      return;
    }
    nextDoorway.current = (nextDoorway.current + 1) % doorways.length;
    edit((door) => {
      const next = draftFromServer(option);
      return sized ? next : { ...next, width: door.width, height: door.height };
    });
  };

  const save = async () => {
    const door = getRoomScanState().doorDraft;
    if (!door || saving) {
      return;
    }
    setSaving(true);
    const answer = await saveDoorDraft(door);
    setSaving(false);
    if (answer.ok) {
      setBaseline(door);
      setAdjusting(false);
      setResult('saved');
    } else {
      setResult('failed');
    }
  };

  const leave = useCallback(() => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  }, []);
  const close = useCallback(() => {
    if (changed) {
      setLeaveAsk(true);
    } else {
      leave();
    }
  }, [changed, leave]);

  // Android's back button is the close button. Open sheets close themselves first.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close]);

  // The cases in which the room cannot be looked for lead to Home or to a problem screen.
  const leaveTo = view.leave;
  useEffect(() => {
    if (leaveTo === 'no-room') {
      appActions.resetTo(homeScreen());
    } else if (leaveTo === 'server' || leaveTo === 'version' || leaveTo === 'cloud') {
      appActions.resetTo(homeScreen());
      appActions.showProblem(leaveTo);
    } else if (leaveTo === 'cloud-setup') {
      appActions.resetTo(homeScreen());
      appActions.showProblem('cloudSetup');
    }
  }, [leaveTo]);

  useEffect(() => {
    if (view.sheet === null) {
      setClosedSheet(false);
    }
  }, [view.sheet]);

  // A saved door that was not changed has nothing to save.
  const canSave = ready && draft !== null && !saving && !(start === 'saved' && !changed);
  const saveLabel = saving ? t('place.save.saving') : ready ? t('place.save') : t('place.save.finding');
  const coach = view.coach;

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.crossLayer} pointerEvents="none">
        <View style={styles.cross}>
          <View style={[styles.crossLine, styles.crossAcross]} />
          <View style={[styles.crossLine, styles.crossUp]} />
        </View>
      </View>

      <View style={styles.topRow} pointerEvents="box-none">
        <HudButton icon="close" label={t('common.close')} onPress={close} />
        <HudPill text={roomName} icon="door" />
      </View>

      <View style={styles.under} pointerEvents="box-none">
        {view.lostBanner ? <CoachCard danger line1={t('ar.lost.title')} line2={t('ar.lost.body')} /> : null}
      </View>

      <View style={styles.spacer} pointerEvents="none" />

      <View style={styles.bottom} pointerEvents="box-none">
        {coach && !adjusting ? <CoachCard line1={t(coach.line1)} line2={coach.line2 ? t(coach.line2) : undefined} /> : null}

        {adjusting && draft ? (
          <>
            {sized ? (
              <View style={styles.center} pointerEvents="none">
                <HudPill text={sizeLabel(draft)} />
              </View>
            ) : null}
            <View style={styles.panel}>
              <PanelRow label={t('place.row.move')}>
                <StepButton glyph="←" label={t('place.a11y.left')} onStep={() => edit((door) => moveDoor(door, -1, 0))} />
                <StepButton glyph="→" label={t('place.a11y.right')} onStep={() => edit((door) => moveDoor(door, 1, 0))} />
                <StepButton glyph="↑" label={t('place.a11y.away')} onStep={() => edit((door) => moveDoor(door, 0, -1))} />
                <StepButton glyph="↓" label={t('place.a11y.towards')} onStep={() => edit((door) => moveDoor(door, 0, 1))} />
              </PanelRow>
              <PanelRow label={t('place.row.turn')}>
                <StepButton turn="left" label={t('place.a11y.turnLeft')} onStep={() => edit((door) => turnDoor(door, 1))} />
                <StepButton turn="right" label={t('place.a11y.turnRight')} onStep={() => edit((door) => turnDoor(door, -1))} />
                <Pressable
                  onPress={() => edit(turnAround)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.wide, pressed ? styles.pressed : null]}
                >
                  <Text style={[TYPE.small, styles.wideText]}>{t('place.turnAround')}</Text>
                </Pressable>
              </PanelRow>
              {sized ? (
                <>
                  <PanelRow label={t('place.row.width')}>
                    <StepButton glyph="−" label={t('place.a11y.less')} onStep={() => edit((door) => resizeDoor(door, -1, 0))} />
                    <Text style={[TYPE.rowTitle, TYPE.numbers, styles.value]}>{t('place.metres', { v: draft.width.toFixed(2) })}</Text>
                    <StepButton glyph="+" label={t('place.a11y.more')} onStep={() => edit((door) => resizeDoor(door, 1, 0))} />
                  </PanelRow>
                  <PanelRow label={t('place.row.height')}>
                    <StepButton glyph="−" label={t('place.a11y.less')} onStep={() => edit((door) => resizeDoor(door, 0, -1))} />
                    <Text style={[TYPE.rowTitle, TYPE.numbers, styles.value]}>{t('place.metres', { v: draft.height.toFixed(2) })}</Text>
                    <StepButton glyph="+" label={t('place.a11y.more')} onStep={() => edit((door) => resizeDoor(door, 0, 1))} />
                  </PanelRow>
                </>
              ) : null}
              {doorways.length > 0 ? <AppButton kind="ghost" onCamera label={t('place.useDoorway')} onPress={useDoorway} /> : null}
              <AppButton kind="text" onCamera label={t('place.done')} onPress={() => setAdjusting(false)} />
            </View>
          </>
        ) : (
          <View style={styles.pair}>
            <AppButton kind="ghost" onCamera label={t('place.putHere')} onPress={putItHere} disabled={!draft} style={styles.half} />
            <AppButton kind="ghost" onCamera label={t('place.adjust')} onPress={() => setAdjusting(true)} disabled={!draft} style={styles.half} />
          </View>
        )}

        <AppButton label={saveLabel} onPress={() => void save()} disabled={!canSave} />
      </View>

      {view.sheet === 'unknown' && !closedSheet ? (
        <Sheet onClose={() => setClosedSheet(true)}>
          <SheetTitle>{t('problem.unknown.title', { room: roomName })}</SheetTitle>
          <Body dim>{t('problem.unknown.body')}</Body>
          <AppButton label={t('problem.unknown.keep')} onPress={appActions.requestRelocalize} />
          <AppButton kind="text" label={t('problem.unknown.scan')} onPress={() => openGuidedScan('again')} />
        </Sheet>
      ) : null}

      {result === 'saved' ? (
        <Sheet onClose={() => appActions.resetTo(homeScreen())}>
          <SheetTitle>{t('place.saved.title')}</SheetTitle>
          <Body dim>{t('place.saved.body')}</Body>
          <AppButton label={t('place.saved.visitor')} onPress={enterVisitorMode} />
          <AppButton kind="text" label={t('place.done')} onPress={() => appActions.resetTo(homeScreen())} />
        </Sheet>
      ) : null}

      {result === 'failed' ? (
        <Sheet onClose={() => setResult(null)}>
          <SheetTitle>{t('place.failed.title')}</SheetTitle>
          <Body dim>{t('place.failed.body')}</Body>
          <AppButton
            label={t('place.failed.again')}
            onPress={() => {
              setResult(null);
              // Until the room is found again the button says so, and the staff member presses it then.
              if (getRoomScanState().found) {
                void save();
              }
            }}
          />
          <AppButton kind="text" label={t('common.notNow')} onPress={() => setResult(null)} />
        </Sheet>
      ) : null}

      {leaveAsk ? (
        <Sheet onClose={() => setLeaveAsk(false)}>
          <SheetTitle>{t('place.leave.ask')}</SheetTitle>
          <AppButton label={t('place.leave.keep')} onPress={() => setLeaveAsk(false)} />
          <AppButton kind="text" label={t('place.leave.leave')} onPress={leave} />
        </Sheet>
      ) : null}
    </View>
  );
}

function PanelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={[TYPE.small, styles.rowLabel]}>{label}</Text>
      <View style={styles.rowControls}>{children}</View>
    </View>
  );
}

/** One step per tap; holding repeats. */
function StepButton(props: { glyph?: string; turn?: 'left' | 'right'; label: string; onStep: () => void }) {
  const step = useRef(props.onStep);
  step.current = props.onStep;
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (pause.current !== null) {
      clearTimeout(pause.current);
      pause.current = null;
    }
    if (repeat.current !== null) {
      clearInterval(repeat.current);
      repeat.current = null;
    }
  }, []);
  useEffect(() => stop, [stop]);
  const begin = () => {
    stop();
    step.current();
    pause.current = setTimeout(() => {
      pause.current = null;
      repeat.current = setInterval(() => step.current(), REPEAT_EVERY_MS);
    }, REPEAT_AFTER_MS);
  };
  return (
    <Pressable
      onPressIn={begin}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      style={({ pressed }) => [styles.step, pressed ? styles.pressed : null]}
    >
      {props.turn ? (
        // One drawn arrow, mirrored for the other direction.
        <View style={props.turn === 'right' ? styles.mirrored : null}>
          <Icon name="turn" color={HUD.fg} size={20} />
        </View>
      ) : (
        <Text style={styles.glyph}>{props.glyph}</Text>
      )}
    </Pressable>
  );
}

const CROSS = 26;
const CROSS_LINE = 2;

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16 },
  crossLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  cross: { width: CROSS, height: CROSS, opacity: 0.9 },
  crossLine: { position: 'absolute', backgroundColor: HUD.fg, borderRadius: CROSS_LINE },
  crossAcross: { left: 0, right: 0, top: (CROSS - CROSS_LINE) / 2, height: CROSS_LINE },
  crossUp: { top: 0, bottom: 0, left: (CROSS - CROSS_LINE) / 2, width: CROSS_LINE },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  under: { marginTop: 10, gap: 8, alignItems: 'flex-start' },
  spacer: { flex: 1 },
  bottom: { gap: 10 },
  center: { alignItems: 'center' },
  pair: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  panel: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 6,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  rowLabel: { width: 64, color: HUD.dim },
  rowControls: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  step: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: HUD.line,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  glyph: { color: HUD.fg, fontSize: 21, lineHeight: 25, fontWeight: '600' },
  mirrored: { transform: [{ scaleX: -1 }] },
  wide: {
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: HUD.line,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  wideText: { color: HUD.fg, fontWeight: '600' },
  value: { color: HUD.fg, minWidth: 64, textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
