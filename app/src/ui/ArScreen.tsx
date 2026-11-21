import { useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';

import { t, type TextKey } from '../i18n';
import { useMeasure } from '../measure/measureController';
import { DEFAULT_MAP_ID } from '../room/roomServer';
import { roomDisplayName } from '../room/roomNames';
import { appActions, useAppState } from '../state/appStore';
import { prefsActions, usePrefs } from '../state/prefs';
import { arView } from './core/arView';
import { AppButton, Body, CoachCard, HudButton, HudPill, Row, Sheet, SheetTitle, useSevenTaps } from './kit';
import { useServerView } from './ServerPanel';
import { HUD, TYPE, useInsets } from './theme';

/** The hint under the door goes away after this long. */
const HINT_MS = 5000;

/**
 * What the user sees over the camera (`docs/product/ui-spec.md`, 5.9): one instruction
 * while the room is being found, then almost nothing - a close button, the name of the
 * space, a menu. What is shown when is decided by `core/arView.ts`; this component only
 * draws it. With developer options on there is also one line of diagnostics and the
 * button that opens the developer tools (`Overlay.tsx`).
 */
export function ArScreen() {
  const insets = useInsets();
  const developer = usePrefs((s) => s.developerOptions);
  const diagnostics = usePrefs((s) => s.diagnosticsLine);
  const toolsOpen = useAppState((s) => s.overlayVisible);
  const status = useAppState((s) => s.providerStatus);
  const meta = useAppState((s) => s.providerMeta);
  const door = useAppState((s) => s.door);
  const mode = useAppState((s) => s.mode);
  const tracking = useAppState((s) => s.trackingState);
  const trackingReason = useAppState((s) => s.trackingReason);
  const providerId = useAppState((s) => s.providerId);
  const environment = useAppState((s) => s.environment);
  const connection = useServerView().connection;

  const source = providerId === 'self-hosted' ? 'room' : 'free';
  const view = arView({
    status,
    meta,
    hasDoor: door !== null,
    mode,
    tracking,
    trackingReason,
    source,
    connection: connection.state,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  /** The sheet the user has closed; it stays closed until the problem goes away. */
  const [closedSheet, setClosedSheet] = useState<string | null>(null);
  useEffect(() => {
    if (view.sheet === null) {
      setClosedSheet(null);
    }
  }, [view.sheet]);
  const sheet = view.sheet !== null && view.sheet !== closedSheet ? view.sheet : null;

  // "Walk through the door", for a few seconds whenever the door comes to stand.
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (view.situation !== 'door') {
      setHint(false);
      return undefined;
    }
    setHint(true);
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [view.situation]);

  // Back closes what is open before it does anything else.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (menuOpen) {
        setMenuOpen(false);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [menuOpen]);

  // Until the settings screen exists, seven taps in the top right corner switch the
  // developer options on and off.
  const onSecretTap = useSevenTaps(() => {
    const next = !developer;
    prefsActions.set({ developerOptions: next });
    appActions.log(`developer options ${next ? 'on' : 'off'}`);
  });

  if (developer && toolsOpen) {
    return null; // the developer tools take the whole screen
  }

  const findAgain = () => {
    setMenuOpen(false);
    appActions.requestRelocalize();
  };
  const roomName = roomDisplayName(DEFAULT_MAP_ID);
  const spaceName = t(`space.${environment}.name` as TextKey);

  // Until Home exists, the cases in which the AR screen cannot go on are told here.
  const stuck: { line1: TextKey; line2: TextKey } | null =
    view.leave === 'no-room'
      ? { line1: 'home.noRoom.title', line2: 'home.noRoom.body' }
      : view.leave === 'version'
        ? { line1: 'connect.version.title', line2: 'connect.version.body' }
        : view.leave === 'server'
          ? { line1: 'problem.server.title', line2: 'problem.server.body.unnamed' }
          : null;
  const coach = stuck ?? view.coach;

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        <HudButton icon="close" label={t('common.close')} onPress={() => BackHandler.exitApp()} />
        <View style={styles.topRight} pointerEvents="box-none">
          {view.situation === 'finding' && source === 'room' ? <HudPill text={roomName} icon="door" /> : null}
          {view.situation === 'door' ? (
            <>
              <HudPill text={spaceName} />
              <HudButton icon="more" label={t('ar.menu.findAgain')} onPress={() => setMenuOpen(true)} />
            </>
          ) : null}
          {view.situation === 'finding' ? <Pressable style={styles.secret} onPress={onSecretTap} accessibilityElementsHidden /> : null}
        </View>
      </View>

      <View style={styles.under} pointerEvents="box-none">
        {view.lostBanner ? <CoachCard danger line1={t('ar.lost.title')} line2={t('ar.lost.body')} /> : null}
        {view.pill === 'off' ? (
          <HudPill text={t('ar.pill.off')} action={t('ar.pill.findAgain')} onPress={appActions.requestRelocalize} />
        ) : null}
        {view.pill === 'offline' ? <HudPill text={t('ar.pill.offline')} /> : null}
      </View>

      <View style={styles.spacer} pointerEvents="none" />

      <View style={styles.bottom} pointerEvents="box-none">
        {coach && !view.lostBanner ? (
          <CoachCard line1={t(coach.line1)} line2={coach.line2 ? t(coach.line2) : undefined} />
        ) : null}
        {hint && view.situation === 'door' && !view.lostBanner ? (
          <View style={styles.center} pointerEvents="none">
            <HudPill text={t('ar.hint.walk')} />
          </View>
        ) : null}
        {developer ? (
          <View style={styles.devRow} pointerEvents="box-none">
            <Pressable style={styles.tools} onPress={appActions.toggleOverlay} accessibilityRole="button">
              <Text style={[TYPE.mono, styles.toolsText]}>Tools</Text>
            </Pressable>
            {diagnostics ? <DiagnosticsLine /> : null}
          </View>
        ) : null}
      </View>

      {menuOpen ? (
        <Sheet onClose={() => setMenuOpen(false)}>
          {source === 'room' ? (
            <Row icon="search" tone="amber" title={t('ar.menu.findAgain')} sub={t('ar.menu.findAgain.sub')} onPress={findAgain} />
          ) : (
            <Row icon="door" tone="amber" title={t('ar.free.replace')} sub={t('ar.free.replace.sub')} onPress={findAgain} />
          )}
        </Sheet>
      ) : null}

      {sheet === 'unknown' ? (
        <Sheet onClose={() => setClosedSheet('unknown')}>
          <SheetTitle>{t('problem.unknown.title', { room: source === 'room' ? roomName : t('ar.room.fallback') })}</SheetTitle>
          <Body dim>{t('problem.unknown.body')}</Body>
          <AppButton label={t('problem.unknown.keep')} onPress={appActions.requestRelocalize} />
        </Sheet>
      ) : null}
      {sheet === 'noDoorway' ? (
        <Sheet onClose={() => setClosedSheet('noDoorway')}>
          <SheetTitle>{t('problem.noDoorway.title')}</SheetTitle>
          <Body dim>{t('problem.noDoorway.body')}</Body>
          <AppButton kind="ghost" label={t('common.close')} onPress={() => setClosedSheet('noDoorway')} />
        </Sheet>
      ) : null}
    </View>
  );
}

/**
 * Developer line: tracking state, provider, match quality and inliers of the latest
 * search, the time it took, door size and confidence.
 */
function DiagnosticsLine() {
  const tracking = useAppState((s) => s.trackingState);
  const providerId = useAppState((s) => s.providerId);
  const status = useAppState((s) => s.providerStatus);
  const door = useAppState((s) => s.door);
  const placement = useMeasure((s) => s.placement);
  const parts = [tracking.toUpperCase(), `${providerId}: ${status}`];
  if (placement) {
    parts.push(`${placement.quality ?? placement.reason}${placement.inliers === null ? '' : ` ${placement.inliers}`}`);
    if (placement.elapsedMs !== null) {
      parts.push(`${(placement.elapsedMs / 1000).toFixed(1)} s`);
    }
  }
  if (door?.opening) {
    parts.push(`${door.opening.width.toFixed(2)}x${door.opening.height.toFixed(2)} m`);
  }
  if (door?.quality?.confidence !== undefined) {
    parts.push(`conf ${door.quality.confidence.toFixed(2)}`);
  }
  return (
    <View style={styles.diagnostics} pointerEvents="none">
      <Text style={[TYPE.mono, styles.toolsText]} numberOfLines={2}>
        {parts.join(' · ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  secret: { width: 44, height: 44 },
  under: { marginTop: 10, gap: 8, alignItems: 'flex-start' },
  spacer: { flex: 1 },
  bottom: { gap: 10 },
  center: { alignItems: 'center' },
  devRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tools: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  toolsText: { color: HUD.fg },
  diagnostics: { flex: 1, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8, backgroundColor: HUD.bg },
});
