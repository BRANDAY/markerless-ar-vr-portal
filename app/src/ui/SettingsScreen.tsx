import { Pressable, StyleSheet, Text, View } from 'react-native';

import appConfig from '../../app.json';
import { t } from '../i18n';
import { SELECTABLE_PROVIDER_IDS } from '../localization';
import { roomActions, useRoomScan } from '../room/roomStore';
import { appActions, useAppState } from '../state/appStore';
import { prefsActions, usePrefs } from '../state/prefs';
import { chipState } from './core/homeView';
import { Body, Eyebrow, Row, ScreenFrame, Small, useSevenTaps } from './kit';
import { useServerView } from './ServerPanel';
import { TYPE, useTheme } from './theme';

/** Settings (`docs/product/ui-spec.md`, 5.12), and below them the developer options. */
export function SettingsScreen() {
  const theme = useTheme();
  const connection = useServerView().connection;
  const auto = usePrefs((s) => s.findAutomatically);
  const developer = usePrefs((s) => s.developerOptions);

  const chip = chipState(connection.state);
  const serverName = connection.info?.serverName ?? '';
  const serverValue =
    chip === 'connected'
      ? t('settings.server.connected', { server: serverName })
      : chip === 'connecting'
        ? t('settings.server.connecting')
        : chip === 'offline'
          ? t('settings.server.offline')
          : t('settings.server.none');

  const onVersionTap = useSevenTaps(() => {
    const next = !developer;
    prefsActions.set({ developerOptions: next });
    appActions.log(`developer options ${next ? 'on' : 'off'}`);
  });

  return (
    <ScreenFrame title={t('settings.title')} onBack={() => appActions.back()}>
      <Row icon="wifi" tone={chip === 'connected' ? 'teal' : 'neutral'} title={t('settings.server')} value={serverValue} arrow onPress={() => appActions.go('connect')} />
      <Row icon="search" title={t('settings.auto')} toggle={{ value: auto, onChange: (value) => prefsActions.set({ findAutomatically: value }) }} />
      <Row icon="lock" title={t('settings.privacy')} arrow onPress={() => appActions.go('privacy')} />

      <Pressable onPress={onVersionTap} style={styles.version} accessibilityRole="text">
        <Text style={[TYPE.small, { color: theme.ink2 }]}>{t('settings.version', { version: appConfig.expo.version })}</Text>
        {developer ? <Small>{t('settings.developer.on')}</Small> : null}
      </Pressable>

      {developer ? <DeveloperOptions /> : null}
    </ScreenFrame>
  );
}

/**
 * Everything technical, off by default. The wording is the developer's own, on purpose:
 * these rows are not part of the product and are not translated.
 */
function DeveloperOptions() {
  const diagnosticsLine = usePrefs((s) => s.diagnosticsLine);
  const testObjects = usePrefs((s) => s.testObjects);
  const keepArView = usePrefs((s) => s.keepArView);
  const providerId = useAppState((s) => s.providerId);
  const frame = useAppState((s) => s.frame);
  const attachMode = useAppState((s) => s.attachMode);
  const environment = useAppState((s) => s.environment);
  const planVisible = useRoomScan((s) => s.planVisible);

  const nextProvider = () => {
    const index = SELECTABLE_PROVIDER_IDS.indexOf(providerId);
    appActions.setProvider(SELECTABLE_PROVIDER_IDS[(index + 1) % SELECTABLE_PROVIDER_IDS.length]);
  };

  return (
    <View style={styles.developer}>
      <Eyebrow>Developer options</Eyebrow>
      <Body dim>
        On the AR screen the "Tools" button opens the status panel, the event log, the scan and measurement panels and the mesh
        switches.
      </Body>
      <Row title="Diagnostics on the AR screen" toggle={{ value: diagnosticsLine, onChange: (value) => prefsActions.set({ diagnosticsLine: value }) }} />
      <Row title="Localisation provider" sub="Normally chosen by the app when a door is opened" value={providerId} onPress={nextProvider} />
      <Row title="Door frame" value={frame} onPress={() => appActions.setFrame(frame === 'casing' ? 'simple' : 'casing')} />
      <Row title="Attach mode" value={attachMode} onPress={() => appActions.setAttachMode(attachMode === 'direct' ? 'parent' : 'direct')} />
      <Row title="Room plan in AR" toggle={{ value: planVisible, onChange: () => roomActions.togglePlan() }} />
      <Row
        title="Test room"
        sub="The small room of primitives instead of the chosen space"
        toggle={{ value: environment === 'test-room', onChange: (value) => appActions.setEnvironment(value ? 'test-room' : 'sponza') }}
      />
      <Row title="Test objects" sub="Box and sphere near the session origin" toggle={{ value: testObjects, onChange: (value) => prefsActions.set({ testObjects: value }) }} />
      <Row
        title="Keep the AR view running"
        sub="Between screens, instead of starting a new AR session each time"
        toggle={{ value: keepArView, onChange: (value) => prefsActions.set({ keepArView: value }) }}
      />
      <Row title="Diagnostics" sub="Status and event log" arrow onPress={() => appActions.go('diagnostics')} />
      <Row title="Turn developer options off" onPress={() => prefsActions.set({ developerOptions: false })} />
    </View>
  );
}

const styles = StyleSheet.create({
  version: { paddingVertical: 18, alignItems: 'center', gap: 2 },
  developer: { gap: 4, paddingTop: 8 },
});
