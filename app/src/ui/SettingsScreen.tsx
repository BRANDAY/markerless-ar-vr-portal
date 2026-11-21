import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import appConfig from '../../app.json';
import { availableLanguages, getLanguage, t } from '../i18n';
import { LANGUAGE_NAMES } from '../i18n/languages';
import { SELECTABLE_PROVIDER_IDS } from '../localization';
import { roomActions, useRoomScan } from '../room/roomStore';
import { putTestRoom } from '../spaces/spaceChoice';
import { appActions, useAppState } from '../state/appStore';
import { chooseLanguage } from '../state/language';
import { prefsActions, usePrefs } from '../state/prefs';
import { chipState } from './core/homeView';
import { openDoor } from './flows';
import { PinSheet, SwitchToVisitorSheet } from './modeSheets';
import { Body, Eyebrow, Row, ScreenFrame, Sheet, SheetTitle, Small, useSevenTaps } from './kit';
import { useServerView } from './ServerPanel';
import { TYPE, useTheme } from './theme';

/** Settings (`docs/product/ui-spec.md`, 5.12), and below them the developer options. */
export function SettingsScreen() {
  const theme = useTheme();
  const connection = useServerView().connection;
  const auto = usePrefs((s) => s.findAutomatically);
  const developer = usePrefs((s) => s.developerOptions);
  const cloud = usePrefs((s) => s.connection === 'reactvision');
  const [sheet, setSheet] = useState<'switch' | 'pin' | 'language' | null>(null);

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
    <>
    <ScreenFrame title={t('settings.title')} onBack={() => appActions.back()}>
      <Row
        icon="search"
        title={t('connection.title')}
        value={cloud ? t('connection.cloud.title') : t('connection.server.short')}
        arrow
        onPress={() => appActions.go('connection')}
      />
      <Row icon="wifi" tone={chip === 'connected' ? 'teal' : 'neutral'} title={t('settings.server')} value={serverValue} arrow onPress={() => appActions.go('connect')} />
      <Row icon="search" title={t('settings.auto')} toggle={{ value: auto, onChange: (value) => prefsActions.set({ findAutomatically: value }) }} />
      <Row icon="door" title={t('settings.switch')} arrow onPress={() => setSheet('switch')} />
      <Row icon="lock" title={t('settings.changePin')} arrow onPress={() => setSheet('pin')} />
      <Row icon="settings" title={t('settings.language')} value={LANGUAGE_NAMES[getLanguage()] ?? getLanguage()} arrow onPress={() => setSheet('language')} />
      <Row icon="lock" title={t('settings.privacy')} arrow onPress={() => appActions.go('privacy')} />
      <Row icon="info" title={t('settings.credits')} arrow onPress={() => appActions.go('credits')} />
      <Row icon="info" title={t('settings.how')} arrow onPress={() => appActions.go('welcome')} />

      <Pressable onPress={onVersionTap} style={styles.version} accessibilityRole="text">
        <Text style={[TYPE.small, { color: theme.ink2 }]}>{t('settings.version', { version: appConfig.expo.version })}</Text>
        {developer ? <Small>{t('settings.developer.on')}</Small> : null}
      </Pressable>

      {developer ? <DeveloperOptions /> : null}
    </ScreenFrame>
    {sheet === 'switch' ? <SwitchToVisitorSheet onClose={() => setSheet(null)} /> : null}
    {sheet === 'language' ? (
      <Sheet onClose={() => setSheet(null)}>
        <SheetTitle>{t('settings.language')}</SheetTitle>
        {availableLanguages()
          .filter((code) => LANGUAGE_NAMES[code])
          .map((code) => (
            <Row
              key={code}
              title={LANGUAGE_NAMES[code]}
              value={code === getLanguage() ? '✓' : undefined}
              onPress={() => {
                chooseLanguage(code);
                setSheet(null);
              }}
            />
          ))}
      </Sheet>
    ) : null}
    {sheet === 'pin' ? <PinSheet purpose="change" onClose={() => setSheet(null)} onDone={() => setSheet(null)} /> : null}
    </>
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
      <Row
        title="Localisation provider"
        sub="Kept while developer options are on; without them the server is always used"
        value={providerId === 'manual' ? 'manual - not tied to the room' : providerId}
        onPress={nextProvider}
      />
      <Row title="Door in front of the camera" sub="Not tied to the room: two metres ahead, no server" arrow onPress={() => openDoor('free')} />
      <Row title="Door frame" value={frame} onPress={() => appActions.setFrame(frame === 'casing' ? 'simple' : 'casing')} />
      <Row title="Attach mode" value={attachMode} onPress={() => appActions.setAttachMode(attachMode === 'direct' ? 'parent' : 'direct')} />
      <Row title="Room plan in AR" toggle={{ value: planVisible, onChange: () => roomActions.togglePlan() }} />
      <Row
        title="Test room"
        sub="The small room of primitives behind this room's door (the same as choosing it under Spaces)"
        toggle={{ value: environment === 'test-room', onChange: putTestRoom }}
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
