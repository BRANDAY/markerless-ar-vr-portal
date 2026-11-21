import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { t } from '../i18n';
import { reactVisionConfigured } from '../localization/vpsBridge';
import { saveRoomLocation } from '../room/doorServer';
import { roomName, roomsActions, useRooms } from '../room/roomsStore';
import type { RoomBridge } from '../server/core/roomPlan';
import { appActions } from '../state/appStore';
import { prefsActions, usePrefs } from '../state/prefs';
import { chipState } from './core/homeView';
import { openBridge, roomProvider } from './flows';
import { AppButton, Card, Row, ScreenFrame, Small } from './kit';
import { useServerView } from './ServerPanel';
import { RADIUS, TYPE, useTheme } from './theme';

/**
 * Connection method (`docs/product/ui-spec.md`, 5.15): the venue's own server, or
 * ReactVision Advanced VPS. Staff choose; visitors never see this page. In a build
 * without ReactVision keys the second option cannot be chosen.
 *
 * What the spec does not have and this page adds: the field for the room's ReactVision
 * location id, and the room's link to that place (the bridge, `BridgeScreen`). Sending a
 * scan to ReactVision from the app is not built (it needs a token endpoint on the venue's
 * server), so the room is scanned with the vendor's own tools and the id it got is typed
 * in here.
 */
export function ConnectionScreen() {
  const theme = useTheme();
  const cloud = usePrefs((s) => s.connection === 'reactvision');
  const serverMode = usePrefs((s) => s.vpsServerMode);
  const connection = useServerView().connection;
  const currentId = useRooms((s) => s.currentId);
  const saved = useRooms((s) => s.rooms.find((room) => room.mapId === s.currentId)?.vps?.locationId ?? '');
  const bridge = useRooms((s) => s.rooms.find((room) => room.mapId === s.currentId)?.vps?.bridge ?? null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [locationId, setLocationId] = useState(saved);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    void reactVisionConfigured().then((answer) => {
      if (live) {
        setConfigured(answer);
      }
    });
    void roomsActions.refresh();
    return () => {
      live = false;
    };
  }, []);
  // What the server has replaces the field's content when it arrives or changes.
  useEffect(() => setLocationId(saved), [saved]);

  const choose = (method: 'server' | 'reactvision') => {
    prefsActions.set({ connection: method });
    appActions.setProvider(roomProvider());
    appActions.log(`connection method: ${method}`);
  };
  const saveLocation = async () => {
    if (!currentId || saving === 'saving') {
      return;
    }
    setSaving('saving');
    setSaving((await saveRoomLocation(currentId, locationId)) ? 'saved' : 'failed');
  };

  const chip = chipState(connection.state);
  const serverValue =
    chip === 'connected'
      ? t('settings.server.connected', { server: connection.info?.serverName ?? '' })
      : chip === 'connecting'
        ? t('settings.server.connecting')
        : chip === 'offline'
          ? t('settings.server.offline')
          : t('settings.server.none');
  const cloudAvailable = configured === true;

  return (
    <ScreenFrame title={t('connection.title')} onBack={() => appActions.back()}>
      <Option
        chosen={!cloud}
        title={t('connection.server.title')}
        line={t('connection.server.line')}
        onPress={() => choose('server')}
      />
      {!cloud ? <Row icon="wifi" tone={chip === 'connected' ? 'teal' : 'neutral'} title={t('settings.server')} value={serverValue} arrow onPress={() => appActions.go('connect')} /> : null}

      <Option
        chosen={cloud}
        disabled={!cloudAvailable}
        title={t('connection.cloud.title')}
        line={configured === false ? t('connection.cloud.notSetUp') : t('connection.cloud.line')}
        onPress={() => choose('reactvision')}
      />
      {cloud ? (
        <>
          <Row
            title={t('connection.cloud.recognise')}
            sub={t('connection.cloud.recognise.line')}
            toggle={{ value: serverMode, onChange: (value) => prefsActions.set({ vpsServerMode: value }) }}
          />
          {currentId ? (
            <View style={styles.field}>
              <Small>{t('connection.location.label', { room: roomName(currentId) })}</Small>
              <TextInput
                value={locationId}
                onChangeText={(text) => {
                  setLocationId(text);
                  setSaving('idle');
                }}
                maxLength={128}
                autoCorrect={false}
                autoCapitalize="none"
                style={[TYPE.body, styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.surface }]}
              />
              <Small>{t('connection.location.hint')}</Small>
              <AppButton
                kind="ghost"
                label={t('connection.location.save')}
                onPress={() => void saveLocation()}
                disabled={saving === 'saving' || locationId.trim() === saved}
              />
              {saving === 'saved' ? <Small>{t('connection.location.saved')}</Small> : null}
              {saving === 'failed' ? <Small>{t('connection.location.failed')}</Small> : null}
              {saved ? (
                <>
                  <Small>{bridgeLine(bridge)}</Small>
                  {(bridge?.warnings ?? []).map((line) => (
                    <Small key={line}>{t('bridge.warning', { text: line })}</Small>
                  ))}
                  <AppButton
                    kind="ghost"
                    label={t(bridge ? 'connection.bridge.again' : 'connection.bridge.link')}
                    onPress={openBridge}
                    disabled={!cloudAvailable || chip !== 'connected' || locationId.trim() !== saved}
                  />
                </>
              ) : null}
            </View>
          ) : (
            <Small>{t('connection.location.noRoom')}</Small>
          )}
        </>
      ) : null}
    </ScreenFrame>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

/** The state of the room's link to its place in the cloud, in one line. */
function bridgeLine(bridge: RoomBridge | null): string {
  if (!bridge) {
    return t('connection.bridge.none');
  }
  const date = bridge.measuredUtc ? formatDate(bridge.measuredUtc) : '';
  return bridge.positionErrorM === null
    ? t('connection.bridge.ok.noError', { date })
    : t('connection.bridge.ok', { date, cm: Math.max(1, Math.round(bridge.positionErrorM * 100)) });
}

/** One of the two methods: a card with a round mark, a name and one line. */
function Option(props: { chosen: boolean; disabled?: boolean; title: string; line: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled || props.chosen}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.chosen, disabled: props.disabled }}
    >
      <Card dimmed={props.disabled} style={props.chosen ? { borderColor: theme.amber, borderWidth: 2 } : undefined}>
        <View style={styles.optionHead}>
          <View style={[styles.mark, { borderColor: props.chosen ? theme.amber : theme.ink2 }]}>
            {props.chosen ? <View style={[styles.markDot, { backgroundColor: theme.amber }]} /> : null}
          </View>
          <Text style={[TYPE.rowTitle, styles.flex, { color: theme.ink }]}>{props.title}</Text>
        </View>
        <Small>{props.line}</Small>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  optionHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mark: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  markDot: { width: 10, height: 10, borderRadius: 5 },
  field: { gap: 6, paddingTop: 4 },
  input: { height: 48, borderRadius: RADIUS.button, borderWidth: 1, paddingHorizontal: 14 },
});
