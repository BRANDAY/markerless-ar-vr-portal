import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { t, type TextKey } from '../i18n';
import { resumeBuild } from '../room/roomServer';
import { roomName, roomsActions, useRooms } from '../room/roomsStore';
import { isBuilding, useRoomScan } from '../room/roomStore';
import { appActions, useAppState } from '../state/appStore';
import { usePrefs } from '../state/prefs';
import { buildProblem, percentOf } from './core/buildView';
import { doorSize, draftFromServer } from './core/doorEdit';
import { chipState, homeSituation } from './core/homeView';
import { openDoor, openGuidedScan, openPlaceDoor } from './flows';
import { Icon } from './icons';
import { AppButton, Body, Card, Dot, Eyebrow, IconTile, ScreenFrame, Small, Tag } from './kit';
import { SwitchToVisitorSheet } from './modeSheets';
import { PlanDrawing } from './PlanDrawing';
import { useServerView } from './ServerPanel';
import { BRAND, SPACE, TYPE, useTheme } from './theme';

/** Home (`docs/product/ui-spec.md`, 5.4): the room, what is behind its door, and one next step. */
export function HomeScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const connection = useServerView().connection;
  const rooms = useRooms((s) => s.rooms);
  const currentId = useRooms((s) => s.currentId);
  const detail = useRooms((s) => s.detail);
  const lastRoomId = usePrefs((s) => s.lastRoomId);
  const build = useRoomScan((s) => s.build);
  const environment = useAppState((s) => s.environment);
  // A build that failed while the user was elsewhere stays on Home until it has been seen.
  const building = isBuilding(build) || build.phase === 'failed';
  const [switchOpen, setSwitchOpen] = useState(false);

  useEffect(() => {
    void roomsActions.refresh();
  }, []);

  // A build that was lost sight of is taken up again when the server answers.
  const connected = connection.state === 'connected';
  useEffect(() => {
    if (connected) {
      void resumeBuild();
    }
  }, [connected]);

  const currentRoom = rooms.find((room) => room.mapId === currentId);
  const situation = homeSituation({
    connection: connection.state,
    rooms: connection.state === 'connected' ? (connection.info?.maps ?? []) : [],
    lastRoomId,
    building,
    // Not known until the list of rooms has been read.
    doorSaved: currentRoom ? currentRoom.portalConfirmed : null,
  });
  const chip = chipState(connection.state);
  const chipColor = { connected: theme.ok, connecting: theme.amber, offline: theme.danger, none: theme.ink2 }[chip];
  const chipText =
    chip === 'connected'
      ? (connection.info?.serverName ?? '')
      : t({ connecting: 'home.chip.connecting', offline: 'home.chip.offline', none: 'home.chip.none' }[chip] as TextKey);

  const hasRoom = situation === 'room-ready' || situation === 'room-no-door';
  const roomId = hasRoom ? currentId : lastRoomId;
  const plan = detail && detail.mapId === roomId ? detail : null;
  const portal = plan?.portal ?? null;
  // The door staff saved, as it is drawn on the plan and described under it.
  const saved = portal && portal.confirmed && portal.position && portal.rotation ? portal : null;
  const savedDoor = saved?.position && saved.rotation
    ? draftFromServer({ position: saved.position, rotation: saved.rotation, width: saved.width, height: saved.height })
    : null;
  const size = doorSize(saved?.width, saved?.height);
  const placedOn = saved?.updatedUtc ? formatDate(saved.updatedUtc) : '';
  const sizeParams = { w: size.width.toFixed(2), h: size.height.toFixed(2) };
  const doorLine = !saved
    ? ''
    : placedOn
      ? t('home.room.doorPlaced', { date: placedOn, ...sizeParams })
      : t('home.room.doorPlaced.noDate', sizeParams);
  const planWidth = width - 2 * SPACE.screen - 34;

  const roomCard = (kind: 'ready' | 'no-door' | 'offline') => (
    <Card dimmed={kind === 'offline'}>
      <View style={styles.cardHead}>
        <Eyebrow>{t('home.room.eyebrow')}</Eyebrow>
        {kind === 'ready' ? <Tag label={t('home.room.ready')} /> : null}
        {kind === 'no-door' ? <Tag label={t('home.room.noDoor')} tone="amber" /> : null}
      </View>
      <PlanDrawing room={plan?.room ?? null} door={kind === 'no-door' ? null : savedDoor} width={planWidth} height={150} />
      <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{roomName(roomId) || t('home.room.eyebrow')}</Text>
      {kind === 'no-door' ? <Small>{t('home.room.noDoor.line')}</Small> : doorLine ? <Small>{doorLine}</Small> : null}
    </Card>
  );

  let content: React.ReactNode;
  let footer: React.ReactNode;
  switch (situation) {
    case 'room-ready':
      content = (
        <>
          {roomCard('ready')}
          <Card>
            <Eyebrow>{t('home.space.eyebrow')}</Eyebrow>
            <View style={styles.spaceRow}>
              <IconTile icon="door" tone="amber" />
              <Text style={[TYPE.rowTitle, styles.flex, { color: theme.ink }]}>{t(`space.${environment}.name` as TextKey)}</Text>
            </View>
          </Card>
        </>
      );
      footer = (
        <>
          <AppButton label={t('home.openDoor')} onPress={() => openDoor('room')} />
          <AppButton kind="text" label={t('settings.switch')} onPress={() => setSwitchOpen(true)} />
        </>
      );
      break;
    case 'room-no-door':
      content = roomCard('no-door');
      footer = (
        <>
          <AppButton label={t('home.placeDoor')} onPress={openPlaceDoor} />
          <AppButton kind="text" label={t('build.scanAgain')} onPress={() => openGuidedScan('again')} />
        </>
      );
      break;
    case 'no-room':
      content = (
        <Card>
          <IconTile icon="door" tone="teal" />
          <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{t('home.noRoom.title')}</Text>
          <Body dim>{t('home.noRoom.body')}</Body>
        </Card>
      );
      footer = (
        <>
          <AppButton label={t('home.scanThis')} onPress={() => openGuidedScan('new')} />
        </>
      );
      break;
    case 'building':
      content = (
        <Card>
          <IconTile icon="door" tone="amber" />
          <Text style={[TYPE.cardTitle, { color: theme.ink }]}>
            {build.target?.label || roomName(build.target?.mapId ?? null) || t('home.room.eyebrow')}
          </Text>
          <Body dim>
            {build.phase === 'failed'
              ? t(buildProblem(build.failure ?? 'internal').title)
              : t('home.build.line', {
                  p: percentOf({
                    phase: build.phase === 'uploading' ? 'uploading' : 'running',
                    uploadFraction: build.uploadFraction,
                    jobProgress: build.jobProgress,
                  }),
                })}
          </Body>
        </Card>
      );
      footer = <AppButton label={t('home.build.see')} onPress={() => appActions.go('build')} />;
      break;
    case 'offline':
      content = (
        <>
          {roomCard('offline')}
          <Body dim>{t('home.offline.line')}</Body>
        </>
      );
      footer = (
        <>
          <AppButton label={t('common.searchAgain')} onPress={() => appActions.go('connect')} />
        </>
      );
      break;
    case 'offline-unknown':
      content = (
        <Card>
          <IconTile icon="alert" tone="danger" />
          <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{t('home.chip.offline')}</Text>
          <Body dim>{t('home.offline.line')}</Body>
        </Card>
      );
      footer = (
        <>
          <AppButton label={t('common.searchAgain')} onPress={() => appActions.go('connect')} />
        </>
      );
      break;
    case 'connecting':
      content = (
        <Card>
          <IconTile icon="search" tone="amber" />
          <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{t('home.chip.connecting')}</Text>
          <Body dim>{t('ar.coach.server.2')}</Body>
        </Card>
      );
      footer = null;
      break;
    case 'no-server':
      content = (
        <Card>
          <IconTile icon="wifi" tone="neutral" />
          <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{t('home.noServer.title')}</Text>
          <Body dim>{t('home.noServer.body')}</Body>
        </Card>
      );
      footer = (
        <>
          <AppButton label={t('home.findServer')} onPress={() => appActions.go('connect')} />
        </>
      );
      break;
  }

  return (
    <>
    <ScreenFrame footer={footer}>
      <View style={styles.header}>
        <Text style={[TYPE.title, styles.flex, { color: theme.ink }]}>{BRAND.name}</Text>
        <Pressable
          onPress={() => appActions.go('settings')}
          accessibilityRole="button"
          style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.line }]}
        >
          <Dot color={chipColor} />
          <Text style={[TYPE.small, { color: theme.ink, maxWidth: 130 }]} numberOfLines={1}>
            {chipText}
          </Text>
        </Pressable>
        <Pressable onPress={() => appActions.go('settings')} accessibilityRole="button" accessibilityLabel={t('settings.title')} style={styles.settings} hitSlop={6}>
          <Icon name="settings" color={theme.ink} />
        </Pressable>
      </View>
      {content}
    </ScreenFrame>
    {switchOpen ? <SwitchToVisitorSheet onClose={() => setSwitchOpen(false)} /> : null}
    </>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
  },
  settings: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  spaceRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
