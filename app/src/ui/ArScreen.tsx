import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, type TextKey } from '../i18n';
import { useMeasure } from '../measure/measureController';
import { removeSavedDoor } from '../room/doorServer';
import { useRoomHealth } from '../room/roomAdmin';
import { roomName as nameOfRoom, useRooms } from '../room/roomsStore';
import { spaceInfo } from '../spaces/spaces';
import { appActions, useAppState } from '../state/appStore';
import { usePrefs } from '../state/prefs';
import { AboutSheet, DoorBehindPill, useWallClose } from './arParts';
import { arView } from './core/arView';
import { homeScreen, openGuidedScan, openPlaceDoor } from './flows';
import { AppButton, Body, CoachCard, HudButton, HudPill, Row, Sheet, SheetTitle, Small } from './kit';
import { useServerView } from './ServerPanel';
import { Shutter } from './Shutter';
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

  const source = providerId === 'manual' ? 'free' : 'room';
  const wallClose = useWallClose();
  const view = arView({
    status,
    meta,
    hasDoor: door !== null,
    mode,
    tracking,
    trackingReason,
    source,
    connection: connection.state,
    wallClose,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** "Remove the door": the question, then the request, then perhaps "could not be removed". */
  const [removeAsk, setRemoveAsk] = useState<'ask' | 'removing' | 'failed' | null>(null);
  /** The sheet the user has closed; it stays closed until the problem goes away. */
  const [closedSheet, setClosedSheet] = useState<string | null>(null);
  useEffect(() => {
    if (view.sheet === null) {
      setClosedSheet(null);
    }
  }, [view.sheet]);
  const sheet = view.sheet !== null && view.sheet !== closedSheet ? view.sheet : null;
  // A room that keeps not being found is marked in the Rooms list.
  useRoomHealth(view.sheet === 'unknown' && source === 'room');

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

  // The cases in which the AR screen cannot go on lead to Home or to a problem screen.
  const leave = view.leave;
  useEffect(() => {
    if (toolsOpen) {
      return; // the developer tools handle these cases themselves (a first scan has no room yet)
    }
    if (leave === 'no-room') {
      appActions.resetTo(homeScreen());
    } else if (leave === 'server' || leave === 'version' || leave === 'cloud') {
      appActions.resetTo(homeScreen());
      appActions.showProblem(leave);
    } else if (leave === 'cloud-setup') {
      appActions.resetTo(homeScreen());
      appActions.showProblem('cloudSetup');
    }
  }, [leave, toolsOpen]);

  const currentRoom = useRooms((s) => s.currentId);

  if (toolsOpen) {
    return null; // the developer tools take the whole screen
  }

  const findAgain = () => {
    setMenuOpen(false);
    appActions.requestRelocalize();
  };
  const moveDoor = () => {
    setMenuOpen(false);
    openPlaceDoor();
  };
  /** "This is a different room", "Choose another room": the Rooms list, with Home behind it. */
  const chooseRoom = () => {
    appActions.resetTo(homeScreen());
    appActions.go('rooms');
  };
  // The Spaces screen is not over the camera: coming back, the room is found again.
  const changeSpace = () => {
    setMenuOpen(false);
    appActions.go('spaces');
  };
  const removeDoor = async () => {
    if (!currentRoom || removeAsk === 'removing') {
      return;
    }
    setRemoveAsk('removing');
    if (await removeSavedDoor(currentRoom)) {
      // The room has no door now: Home says so and offers to place one.
      appActions.resetTo(homeScreen());
    } else {
      setRemoveAsk('failed');
    }
  };
  const roomName = nameOfRoom(currentRoom) || t('home.room.eyebrow');
  const space = spaceInfo(environment);
  const spaceName = t(space.name);
  const coach = view.coach;

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        <HudButton icon="close" label={t('common.close')} onPress={() => appActions.resetTo(homeScreen())} />
        <View style={styles.topRight} pointerEvents="box-none">
          {view.situation === 'finding' && source === 'room' ? <HudPill text={roomName} icon="door" /> : null}
          {view.situation === 'door' ? (
            <>
              <HudPill text={spaceName} onPress={changeSpace} />
              {source === 'room' ? <HudButton icon="more" label={t('ar.menu.findAgain')} onPress={() => setMenuOpen(true)} /> : null}
            </>
          ) : null}
          {view.situation === 'inside' ? (
            <>
              <DoorBehindPill />
              {space.about ? <HudButton icon="info" label={t('ar.inside.about')} onPress={() => setAboutOpen(true)} /> : null}
            </>
          ) : null}
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
          <CoachCard line1={t(coach.line1)} line2={coach.line2 ? t(coach.line2) : undefined}>
            {view.offerOtherRoom && source === 'room' ? (
              <AppButton kind="ghost" onCamera label={t('ar.differentRoom')} onPress={chooseRoom} />
            ) : null}
          </CoachCard>
        ) : null}
        {hint && view.situation === 'door' && !view.lostBanner ? (
          <View style={styles.center} pointerEvents="none">
            <HudPill text={t('ar.hint.walk')} />
          </View>
        ) : null}
        {view.situation !== 'finding' ? <Shutter /> : null}
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
          <Row icon="search" tone="amber" title={t('ar.menu.findAgain')} sub={t('ar.menu.findAgain.sub')} onPress={findAgain} />
          <Row icon="door" tone="teal" title={t('door.move')} onPress={moveDoor} />
          <Row
            icon="close"
            tone="danger"
            title={t('door.remove')}
            onPress={() => {
              setMenuOpen(false);
              setRemoveAsk('ask');
            }}
          />
          <Row icon="forward" title={t('ar.menu.changeSpace')} onPress={changeSpace} />
        </Sheet>
      ) : null}

      {removeAsk ? (
        <Sheet onClose={() => setRemoveAsk(null)}>
          <SheetTitle>{t('door.remove.ask', { room: roomName })}</SheetTitle>
          {removeAsk === 'failed' ? <Small>{t('door.remove.failed')}</Small> : null}
          <AppButton label={t('door.remove.yes')} onPress={() => void removeDoor()} disabled={removeAsk === 'removing'} />
          <AppButton kind="text" label={t('door.remove.keep')} onPress={() => setRemoveAsk(null)} />
        </Sheet>
      ) : null}

      {aboutOpen ? <AboutSheet space={space} onClose={() => setAboutOpen(false)} /> : null}

      {sheet === 'unknown' ? (
        <Sheet onClose={() => setClosedSheet('unknown')}>
          <SheetTitle>{t('problem.unknown.title', { room: source === 'room' ? roomName : t('ar.room.fallback') })}</SheetTitle>
          <Body dim>{t('problem.unknown.body')}</Body>
          <AppButton label={t('problem.unknown.keep')} onPress={appActions.requestRelocalize} />
          {source === 'room' ? <AppButton kind="text" label={t('problem.unknown.otherRoom')} onPress={chooseRoom} /> : null}
          {source === 'room' ? (
            <AppButton kind="text" label={t('problem.unknown.scan')} onPress={() => openGuidedScan('again')} />
          ) : null}
        </Sheet>
      ) : null}
      {sheet === 'noDoor' && source === 'room' ? (
        <Sheet onClose={() => setClosedSheet('noDoor')}>
          <SheetTitle>{t('problem.noDoor.title')}</SheetTitle>
          <Body dim>{t('problem.noDoor.body')}</Body>
          {/* In place of this screen: the room is found already, and "close" there leads Home. */}
          <AppButton label={t('home.placeDoor')} onPress={() => appActions.replace('placeDoor')} />
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
