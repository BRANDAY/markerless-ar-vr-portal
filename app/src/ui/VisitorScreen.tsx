import { useCallback, useEffect, useState } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { useRoomHealth } from '../room/roomAdmin';
import { roomsActions } from '../room/roomsStore';
import { serverConnection } from '../server/ServerConnection';
import { getPhoneNetworkState } from '../server/wifiRoute';
import { spaceInfo } from '../spaces/spaces';
import { appActions, useAppState } from '../state/appStore';
import { prefsActions, usePrefs } from '../state/prefs';
import { AboutSheet, DoorBehindPill, useWallClose } from './arParts';
import { sessionMissed } from './core/roomsView';
import { type VisitorSheet, visitorSheetText, visitorView } from './core/visitorView';
import { enterStaffMode, roomProvider } from './flows';
import { Icon } from './icons';
import { LanguageChips } from './LanguageChips';
import { AppButton, Body, CoachCard, HudButton, HudPill, Notice, ScreenFrame, Sheet, SheetTitle, Small, Title } from './kit';
import { PinSheet } from './modeSheets';
import { Shutter } from './Shutter';
import { useServerView } from './ServerPanel';
import { SIZE, TYPE, useInsets, useTheme } from './theme';

/** The hint under the door goes away after this long. */
const HINT_MS = 5000;

type Permission = 'pending' | 'granted' | 'denied' | 'blocked';

/**
 * The whole of visitor mode (`docs/product/ui-spec.md`, 5.13): a welcome panel on the
 * first launch, then the camera, one instruction at a time and the door. Nothing can be
 * set up here; when something does not work, a sheet says so in plain words. The lock on
 * the welcome panel leads to staff mode, behind the staff PIN.
 */
export function VisitorScreen(props: { permission: Permission; permissionChecked: boolean; onAllow: () => void }) {
  const { permission, onAllow } = props;
  const started = useAppState((s) => s.visitorStarted);
  const welcomeDone = usePrefs((s) => s.visitorWelcomeDone);
  const [help, setHelp] = useState(false);
  const [wantStart, setWantStart] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  /** The search for a server that this screen started has ended. */
  const [searched, setSearched] = useState(false);

  const search = useCallback(() => {
    setSearched(false);
    void serverConnection.findAutomatically().finally(() => setSearched(true));
  }, []);

  // A visitor's door comes from the server and from nowhere else. Without a known server
  // the Wi-Fi is searched at once, so that the venue's name is there before "Start".
  useEffect(() => {
    appActions.setProvider(roomProvider());
    void roomsActions.refresh(); // which rooms have a saved door
    if (serverConnection.getView().connection.state === 'not-configured') {
      search();
    } else {
      setSearched(true);
    }
    return () => appActions.setVisitorStarted(false);
  }, [search]);

  // Later launches open the camera at once; the first one after "Start".
  useEffect(() => {
    if (!started && permission === 'granted' && (welcomeDone || wantStart)) {
      if (!welcomeDone) {
        prefsActions.set({ visitorWelcomeDone: true });
      }
      setWantStart(false);
      appActions.setVisitorStarted(true);
    }
  }, [started, permission, welcomeDone, wantStart]);

  // Android's back button closes the help panel before it leaves the app.
  useEffect(() => {
    if (!help) {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setHelp(false);
      return true;
    });
    return () => subscription.remove();
  }, [help]);

  const cameraRefused = wantStart && (permission === 'denied' || permission === 'blocked');
  const start = () => {
    if (help) {
      setHelp(false);
    } else if (permission === 'granted') {
      prefsActions.set({ visitorWelcomeDone: true });
      appActions.setVisitorStarted(true);
    } else {
      setWantStart(true);
      onAllow();
    }
  };

  if (!started && !help && welcomeDone && !props.permissionChecked) {
    return null; // a later launch: the camera opens in a moment, without the panel flashing by
  }
  if (!started || help) {
    return (
      <>
        <WelcomePanel onStart={start} onLock={() => setPinOpen(true)} />
        {cameraRefused ? (
          <ProblemSheet sheet="camera" onRetry={() => undefined} onClose={() => setWantStart(false)} />
        ) : null}
        {pinOpen ? <PinSheet purpose="unlock" onClose={() => setPinOpen(false)} onDone={enterStaffMode} /> : null}
      </>
    );
  }
  return <OverCamera searched={searched} onSearch={search} onHelp={() => setHelp(true)} />;
}

/** The welcome panel: what will happen, and one button. */
function WelcomePanel({ onStart, onLock }: { onStart: () => void; onLock: () => void }) {
  const theme = useTheme();
  const venue = useServerView().connection.info?.serverName ?? '';
  return (
    <View style={styles.cover}>
      <ScreenFrame
        footer={
          <>
            <AppButton label={t('visitor.start')} onPress={onStart} />
            <Small style={styles.centered}>{t('visitor.line.server')}</Small>
            <LanguageChips />
          </>
        }
      >
        <View style={styles.head}>
          <Text style={[TYPE.rowTitle, styles.venue, { color: theme.ink2 }]} numberOfLines={1}>
            {venue}
          </Text>
          <Pressable onPress={onLock} hitSlop={8} style={styles.lock} accessibilityRole="button" accessibilityLabel={t('visitor.staff')}>
            <Icon name="lock" color={theme.ink2} size={18} />
          </Pressable>
        </View>
        <View style={styles.drawing}>
          <View style={[styles.door, { backgroundColor: theme.amberSoft }]}>
            <Icon name="door" color={theme.amberText} size={56} />
          </View>
        </View>
        <Title>{t('visitor.title')}</Title>
        <Body dim>{t('visitor.body')}</Body>
        <Notice>{t('visitor.notice')}</Notice>
      </ScreenFrame>
    </View>
  );
}

/** What is drawn over the camera once the visitor has started. */
function OverCamera({ searched, onSearch, onHelp }: { searched: boolean; onSearch: () => void; onHelp: () => void }) {
  const insets = useInsets();
  const status = useAppState((s) => s.providerStatus);
  const meta = useAppState((s) => s.providerMeta);
  const hasDoor = useAppState((s) => s.door !== null);
  const mode = useAppState((s) => s.mode);
  const tracking = useAppState((s) => s.trackingState);
  const trackingReason = useAppState((s) => s.trackingReason);
  const arSupported = useAppState((s) => s.arSupported);
  const environment = useAppState((s) => s.environment);
  const connection = useServerView().connection.state;
  const wallClose = useWallClose();

  const view = visitorView({
    status,
    meta,
    hasDoor,
    mode,
    tracking,
    trackingReason,
    source: 'room',
    connection,
    wallClose,
    wifi: getPhoneNetworkState()?.wifiConnected !== false,
    cameraRefused: false,
    arUnsupported: arSupported === false,
    searchPending: !searched,
  });

  // A room that keeps not being found is marked in the staff's Rooms list.
  useRoomHealth(sessionMissed(status, meta));

  const [aboutOpen, setAboutOpen] = useState(false);
  /** The sheet the visitor has closed; it stays closed until the problem goes away. */
  const [closedSheet, setClosedSheet] = useState<VisitorSheet | null>(null);
  useEffect(() => {
    if (view.sheet === null) {
      setClosedSheet(null);
    } else {
      appActions.log(`visitor screen: sheet "${view.sheet}"`);
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

  const retry = () => {
    if (sheet === 'noServer' || sheet === 'wifi' || sheet === 'version') {
      onSearch();
    } else {
      // A door may have been placed since the list of rooms was read.
      void roomsActions.refresh().then(() => appActions.requestRelocalize());
    }
  };

  const space = spaceInfo(environment);
  const coach = view.coach;
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        {view.situation === 'inside' ? (
          <>
            <DoorBehindPill />
            {space.about ? <HudButton icon="info" label={t('ar.inside.about')} onPress={() => setAboutOpen(true)} /> : null}
          </>
        ) : null}
        <HudButton icon="help" label={t('visitor.help')} onPress={onHelp} />
      </View>

      <View style={styles.under} pointerEvents="box-none">
        {view.lostBanner ? <CoachCard danger line1={t('ar.lost.title')} line2={t('ar.lost.body')} /> : null}
      </View>

      <View style={styles.spacer} pointerEvents="none" />

      <View style={styles.bottom} pointerEvents="box-none">
        {coach && !view.lostBanner ? <CoachCard line1={t(coach.line1)} line2={coach.line2 ? t(coach.line2) : undefined} /> : null}
        {hint && view.situation === 'door' && !view.lostBanner ? (
          <View style={styles.center} pointerEvents="none">
            <HudPill text={t('ar.hint.walk')} />
          </View>
        ) : null}
        {view.situation !== 'finding' ? <Shutter /> : null}
      </View>

      {aboutOpen ? <AboutSheet space={space} onClose={() => setAboutOpen(false)} /> : null}
      {sheet ? (
        <ProblemSheet
          sheet={sheet}
          onRetry={retry}
          // Closing a sheet that offers "Try again" (a tap beside it, Android's back) tries
          // again: otherwise the visitor is left with the bare camera and nothing to press.
          onClose={() => (visitorSheetText(sheet).button === 'retry' ? retry() : setClosedSheet(sheet))}
        />
      ) : null}
    </View>
  );
}

/** A dead end in a visitor's words, with the line a staff member reads at a glance. */
function ProblemSheet({ sheet, onRetry, onClose }: { sheet: VisitorSheet; onRetry: () => void; onClose: () => void }) {
  const text = visitorSheetText(sheet);
  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{t(text.title)}</SheetTitle>
      <Body dim>{t(text.body)}</Body>
      {text.reason ? <Small>{t(text.reason)}</Small> : null}
      {text.button === 'retry' ? <AppButton label={t('visitor.tryAgain')} onPress={onRetry} /> : null}
      {text.button === 'settings' ? <AppButton label={t('problem.camera.primary')} onPress={() => void Linking.openSettings()} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  head: { flexDirection: 'row', alignItems: 'center', minHeight: SIZE.touch },
  venue: { flex: 1 },
  lock: { width: SIZE.touch, height: SIZE.touch, alignItems: 'center', justifyContent: 'center' },
  drawing: { alignItems: 'center', paddingVertical: 20 },
  door: { width: 112, height: 112, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  centered: { textAlign: 'center', paddingTop: 6 },
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
  under: { marginTop: 10, gap: 8, alignItems: 'flex-start' },
  spacer: { flex: 1 },
  bottom: { gap: 10 },
  center: { alignItems: 'center' },
});
