import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { useRoomScan } from '../room/roomStore';
import { scanController } from '../room/scanController';
import { appActions, useAppState } from '../state/appStore';
import { addToCoverage, buttonLabel, clock, describeCoverage, NO_COVERAGE, scanView } from './core/scanFlow';
import { beginBuild, leaveScan } from './flows';
import { AppButton, Body, CoachCard, Dot, HudButton, Sheet, SheetTitle } from './kit';
import { HUD, RADIUS, TYPE, useInsets } from './theme';

const TICK_MS = 500;
/** A recording that does not start is tried again this often, this many times. */
const START_RETRY_MS = 2000;
const MAX_START_TRIES = 6;

/**
 * The guided scan (`docs/product/ui-spec.md`, 5.6), drawn over the camera: one flow in
 * place of "Scan room", "Record" and "Upload". The recording starts by itself once
 * tracking is ready; what the coach says and what the one button does is decided by
 * `core/scanFlow.ts`.
 */
export function ScanScreen() {
  const insets = useInsets();
  const tracking = useAppState((s) => s.trackingState);
  const trackingReason = useAppState((s) => s.trackingReason);
  const floorFound = useAppState((s) => s.floorY !== null);
  const cameraPosition = useAppState((s) => s.cameraPosition);
  const cameraForward = useAppState((s) => s.cameraForward);
  const recording = useRoomScan((s) => s.recording);
  const recordingSince = useRoomScan((s) => s.recordingSince);
  const walls = useRoomScan((s) => s.room.wallCount);

  const [now, setNow] = useState(() => Date.now());
  const [doorwayShown, setDoorwayShown] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmSpot, setConfirmSpot] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tries, setTries] = useState(0);
  const [coverage, setCoverage] = useState(NO_COVERAGE);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const leavingRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // The recording starts by itself as soon as the camera follows the room.
  useEffect(() => {
    if (tracking !== 'normal' || recording !== 'idle' || startedRef.current || startingRef.current || tries >= MAX_START_TRIES) {
      return undefined;
    }
    let retry: ReturnType<typeof setTimeout> | null = null;
    startingRef.current = true;
    void scanController.startRecording().then((started) => {
      startingRef.current = false;
      if (started) {
        startedRef.current = true;
      } else if (!leavingRef.current) {
        retry = setTimeout(() => setTries((n) => n + 1), START_RETRY_MS);
      }
    });
    return () => {
      if (retry) {
        clearTimeout(retry);
      }
    };
  }, [tracking, recording, tries]);

  // Whatever way the screen is left, a recording that is still running is thrown away.
  useEffect(
    () => () => {
      leavingRef.current = true;
      void scanController.discardRecording();
    },
    [],
  );

  // Where the phone has been and how it was tilted, from the camera samples. Positions
  // from a camera that has lost the room are not counted: they drift.
  useEffect(() => {
    if (recording !== 'recording' || tracking !== 'normal' || !cameraPosition || recordingSince === null) {
      return;
    }
    const t = Math.max(0, (Date.now() - recordingSince) / 1000);
    setCoverage((before) => addToCoverage(before, cameraPosition, cameraForward, t));
  }, [cameraPosition, cameraForward, recording, tracking, recordingSince]);

  const seconds = recordingSince !== null ? Math.max(0, (now - recordingSince) / 1000) : 0;
  const view = scanView({
    recording: recording === 'recording',
    seconds,
    floorFound,
    walls,
    coverage,
    doorwayShown,
    tracking,
    trackingReason,
  });
  // For the log line of `finish`, which is made once and must see the latest numbers.
  const scanAtRef = useRef({ seconds: 0, coverage, oneSpot: false, walls: 0, floorFound: false, doorwayShown: false });
  scanAtRef.current = { seconds, coverage, oneSpot: view.oneSpot, walls, floorFound, doorwayShown };

  /** `by`: the button, the "Send anyway" of the one-spot question, or the three minutes being up. */
  const finish = useCallback((by: 'button' | 'anyway' | 'time') => {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;
    const at = scanAtRef.current;
    const spot = !at.oneSpot ? '' : by === 'anyway' ? ', made from one spot - sent anyway' : ', made from one spot - the time was up, sent without asking';
    appActions.log(
      `scan: finishing after ${at.seconds.toFixed(0)} s, ${describeCoverage(at.coverage)}, ${at.walls} wall(s), ` +
        `floor ${at.floorFound ? 'found' : 'NOT found'}, the place of the door ${at.doorwayShown ? 'shown' : 'not confirmed as shown'}${spot}`,
    );
    setConfirmSpot(false);
    setSaving(true);
    void scanController.stopRecording().then(beginBuild);
  }, []);

  /** "Finish scan": a scan made from one spot is asked about first; the recording goes on meanwhile. */
  const pressFinish = useCallback(() => {
    const at = scanAtRef.current;
    if (at.oneSpot) {
      appActions.log(`scan: asking before sending - made from one spot (${describeCoverage(at.coverage)})`);
      setConfirmSpot(true);
    } else {
      finish('button');
    }
  }, [finish]);

  // After three minutes the scan finishes by itself.
  const finishNow = view.finishNow;
  useEffect(() => {
    if (finishNow) {
      finish('time');
    }
  }, [finishNow, finish]);

  const stop = useCallback(() => {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;
    setConfirmStop(false);
    void scanController.discardRecording().then(leaveScan);
  }, []);

  // Android's back button asks, like the close button.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setConfirmStop(true);
      return true;
    });
    return () => subscription.remove();
  }, []);

  const cantStart = tries >= MAX_START_TRIES && !startedRef.current;
  const label = buttonLabel(view.button);
  const coach = saving ? { line1: 'scan.coach.saving.1' as const, line2: 'scan.coach.saving.2' as const } : view.coach;

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        <HudButton icon="close" label={t('common.close')} onPress={() => setConfirmStop(true)} />
        <View style={styles.timer}>
          <Dot color={recording === 'recording' ? '#FF4B3E' : HUD.dim} />
          <Text style={[TYPE.small, TYPE.numbers, styles.timerText]}>{clock(seconds)}</Text>
        </View>
      </View>

      <View style={styles.middle} pointerEvents="none">
        {view.brackets && !saving ? <Brackets /> : null}
      </View>

      <View style={styles.bottom} pointerEvents="box-none">
        <CoachCard line1={t(coach.line1)} line2={coach.line2 ? t(coach.line2) : undefined} />
        <View style={styles.counters} pointerEvents="none">
          <Counter text={t(floorFound ? 'scan.count.floor.found' : 'scan.count.floor')} dim={!floorFound} />
          {view.showWalls ? (
            <Counter text={walls === 1 ? t('scan.count.walls.one') : t('scan.count.walls', { n: walls })} dim={walls === 0} />
          ) : null}
          <Counter
            text={t('scan.count.area', { a: coverage.long.toFixed(1), b: coverage.short.toFixed(1) })}
            dim={!view.areaEnough}
          />
          <Counter
            text={t('scan.count.tilt', { d: mark(view.tilt.down), l: mark(view.tilt.level), u: mark(view.tilt.up) })}
            dim={!(view.tilt.down && view.tilt.level && view.tilt.up)}
          />
        </View>
        <AppButton
          label={t(label.key, label.params)}
          kind={view.button.kind === 'finish' ? 'primary' : 'ghost'}
          onCamera
          disabled={view.button.kind === 'wait' || saving}
          onPress={view.button.kind === 'showed' ? () => setDoorwayShown(true) : pressFinish}
        />
      </View>

      {confirmStop && !saving ? (
        <Sheet onClose={() => setConfirmStop(false)}>
          <SheetTitle>{t('scan.stop.title')}</SheetTitle>
          <Body dim>{t('scan.stop.body')}</Body>
          <AppButton label={t('scan.stop.keep')} onPress={() => setConfirmStop(false)} />
          <AppButton kind="text" label={t('scan.stop.stop')} onPress={stop} />
        </Sheet>
      ) : null}
      {confirmSpot && !confirmStop && !saving ? (
        <Sheet onClose={() => setConfirmSpot(false)}>
          <SheetTitle>{t('scan.spot.title')}</SheetTitle>
          <Body dim>{t('scan.spot.body')}</Body>
          <AppButton label={t('scan.stop.keep')} onPress={() => setConfirmSpot(false)} />
          <AppButton kind="text" label={t('scan.spot.send')} onPress={() => finish('anyway')} />
        </Sheet>
      ) : null}
      {cantStart && !confirmStop ? (
        <Sheet onClose={stop}>
          <SheetTitle>{t('scan.cantStart.title')}</SheetTitle>
          <Body dim>{t('scan.cantStart.body')}</Body>
          <AppButton label={t('common.close')} onPress={stop} />
        </Sheet>
      ) : null}
    </View>
  );
}

/** A part of the tilt counter: done, or still to do. */
function mark(done: boolean): string {
  return done ? '✓' : '–';
}

function Counter({ text, dim }: { text: string; dim: boolean }) {
  return (
    <View style={styles.counter}>
      <Text style={[TYPE.small, TYPE.numbers, { color: dim ? HUD.dim : HUD.fg }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** Amber corner brackets around the middle of the view: an aiming aid for the doorway. */
function Brackets() {
  return (
    <View style={styles.brackets}>
      <View style={[styles.corner, styles.topLeft]} />
      <View style={[styles.corner, styles.topRight]} />
      <View style={[styles.corner, styles.bottomLeft]} />
      <View style={[styles.corner, styles.bottomRight]} />
    </View>
  );
}

const CORNER = 34;
const STROKE = 3;

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timer: {
    height: 36,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  timerText: { color: HUD.fg, fontWeight: '600' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  brackets: { width: '62%', height: '58%' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: HUD.door },
  topLeft: { top: 0, left: 0, borderTopWidth: STROKE, borderLeftWidth: STROKE, borderTopLeftRadius: 10 },
  topRight: { top: 0, right: 0, borderTopWidth: STROKE, borderRightWidth: STROKE, borderTopRightRadius: 10 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: STROKE, borderLeftWidth: STROKE, borderBottomLeftRadius: 10 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: STROKE, borderRightWidth: STROKE, borderBottomRightRadius: 10 },
  bottom: { gap: 10 },
  counters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  counter: {
    borderRadius: RADIUS.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
});
