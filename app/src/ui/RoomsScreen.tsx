import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { t } from '../i18n';
import { removeSavedDoor } from '../room/doorServer';
import { type AdminOutcome, deleteRoomNow, renameRoomTo, serverAdministersRooms } from '../room/roomAdmin';
import { roomDisplayName } from '../room/roomNames';
import { roomsActions, useRooms } from '../room/roomsStore';
import { isBuilding, useRoomScan } from '../room/roomStore';
import { spaceOfRoom } from '../spaces/spaceChoice';
import { spaceInfo } from '../spaces/spaces';
import { appActions } from '../state/appStore';
import { usePrefs } from '../state/prefs';
import { percentOf } from './core/buildView';
import { type RoomRow, roomLabel, roomMenu, roomRows, rowTone } from './core/roomsView';
import { homeScreen, openGuidedScan, openPlaceDoor } from './flows';
import { Icon } from './icons';
import { AppButton, Body, Card, IconTile, Notice, Row, ScreenFrame, Sheet, SheetTitle, Small, Tag } from './kit';
import { useServerView } from './ServerPanel';
import { RADIUS, TYPE, useTheme } from './theme';

/** A question or a form about one room, on a sheet. */
interface Ask {
  kind: 'removeDoor' | 'rename' | 'delete';
  row: RoomRow;
  busy: boolean;
  problem: AdminOutcome | null;
}

/**
 * Rooms (`docs/product/ui-spec.md`, 5.11): the rooms of the server, the state of each and
 * what can be done with it. A tap on a row makes that room the one the app works with and
 * leads back - the spec does not say what a tap does; without it a second room could not
 * be opened, because the room is not yet recognised by the server on its own.
 */
export function RoomsScreen() {
  const theme = useTheme();
  const connection = useServerView().connection;
  const rooms = useRooms((s) => s.rooms);
  const currentId = useRooms((s) => s.currentId);
  const build = useRoomScan((s) => s.build);
  const missed = usePrefs((s) => s.missedByRoom);
  // The line of a ready room names its space: drawn anew when a choice changes.
  usePrefs((s) => s.spaceByRoom);
  usePrefs((s) => s.developerOptions);
  const [menu, setMenu] = useState<RoomRow | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    void roomsActions.refresh();
  }, []);

  const connected = connection.state === 'connected';
  const serverName = connection.info?.serverName ?? '';
  const rows = roomRows({
    rooms,
    building:
      isBuilding(build) && build.target
        ? {
            mapId: build.target.mapId,
            label: build.target.label,
            percent: percentOf({
              phase: build.phase === 'uploading' ? 'uploading' : 'running',
              uploadFraction: build.uploadFraction,
              jobProgress: build.jobProgress,
            }),
          }
        : null,
    missed,
  });
  const hasDoor = (row: RoomRow) => rooms.find((room) => room.mapId === row.mapId)?.portalConfirmed === true;
  const nameOf = (row: RoomRow) => row.label || roomDisplayName(row.mapId);
  const lineOf = (row: RoomRow) =>
    row.state === 'building'
      ? t('home.build.line', { p: row.percent })
      : row.state === 'changed'
        ? t('rooms.state.changed')
        : row.state === 'ready'
          ? t('rooms.state.ready', { space: t(spaceInfo(spaceOfRoom(row.mapId)).name) })
          : t('rooms.state.noDoor');

  const leave = () => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  };
  /** Everything below asks the server for something. */
  const needsServer = (): boolean => {
    if (!connected) {
      appActions.showProblem('server');
      return false;
    }
    return true;
  };
  const open = (row: RoomRow) => {
    if (row.state === 'building') {
      appActions.go('build');
      return;
    }
    if (row.mapId !== currentId) {
      roomsActions.select(row.mapId);
    }
    leave();
  };
  /** The actions of the row menu work on the room of the row: it becomes the current one first. */
  const withRoom = (row: RoomRow, action: () => void) => {
    setMenu(null);
    if (!needsServer()) {
      return;
    }
    if (row.mapId !== currentId) {
      roomsActions.select(row.mapId);
    }
    action();
  };
  const question = (kind: Ask['kind'], row: RoomRow) => {
    setMenu(null);
    if (!needsServer()) {
      return;
    }
    setName(nameOf(row));
    setAsk({ kind, row, busy: false, problem: null });
  };
  const confirm = async () => {
    if (!ask || ask.busy) {
      return;
    }
    setAsk({ ...ask, busy: true, problem: null });
    const outcome: AdminOutcome =
      ask.kind === 'removeDoor'
        ? (await removeSavedDoor(ask.row.mapId))
          ? 'ok'
          : 'failed'
        : ask.kind === 'rename'
          ? await renameRoomTo(ask.row.mapId, name)
          : await deleteRoomNow(ask.row.mapId);
    setAsk(outcome === 'ok' ? null : { ...ask, busy: false, problem: outcome });
  };

  const items = menu ? roomMenu(menu, hasDoor(menu), connected && serverAdministersRooms()) : null;

  return (
    <>
      <ScreenFrame
        title={t('rooms.title')}
        onBack={leave}
        footer={<AppButton label={t('rooms.scanNew')} onPress={() => openGuidedScan('new')} />}
      >
        {rows.length === 0 ? (
          <Card>
            <IconTile icon="door" tone="teal" />
            <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{t('home.noRoom.title')}</Text>
            <Body dim>{t(connected ? 'home.noRoom.body' : 'home.offline.line')}</Body>
          </Card>
        ) : null}

        {rows.map((row) => (
          <View key={row.mapId} style={[styles.row, { borderColor: theme.line }, connected ? null : styles.dimmed]}>
            <Pressable onPress={() => open(row)} accessibilityRole="button" style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : null]}>
              <IconTile icon="door" tone={rowTone(row.state)} />
              <View style={styles.rowText}>
                <Text style={[TYPE.rowTitle, { color: theme.ink }]} numberOfLines={2}>
                  {nameOf(row)}
                </Text>
                <Small>{lineOf(row)}</Small>
                {row.mapId === currentId && row.state !== 'building' ? <Tag label={t('home.room.eyebrow')} /> : null}
              </View>
            </Pressable>
            {row.state !== 'building' ? (
              <Pressable onPress={() => setMenu(row)} accessibilityRole="button" accessibilityLabel={t('rooms.menu', { name: nameOf(row) })} hitSlop={6} style={styles.more}>
                <Icon name="more" color={theme.ink} />
              </Pressable>
            ) : null}
          </View>
        ))}

        {serverName ? <Notice>{t('rooms.footer', { server: serverName })}</Notice> : null}
      </ScreenFrame>

      {menu && items ? (
        <Sheet onClose={() => setMenu(null)}>
          <SheetTitle>{nameOf(menu)}</SheetTitle>
          <Row icon="door" tone="teal" title={t(items.door === 'move' ? 'door.move' : 'home.placeDoor')} onPress={() => withRoom(menu, openPlaceDoor)} />
          {items.removeDoor ? <Row icon="close" tone="danger" title={t('door.remove')} onPress={() => question('removeDoor', menu)} /> : null}
          <Row icon="forward" title={t('ar.menu.changeSpace')} onPress={() => withRoom(menu, () => appActions.go('spaces'))} />
          <Row
            icon="camera"
            title={t('build.scanAgain')}
            onPress={() => withRoom(menu, () => openGuidedScan('again', { mapId: menu.mapId, label: nameOf(menu), replace: true }))}
          />
          {items.rename ? <Row icon="settings" title={t('rooms.rename')} onPress={() => question('rename', menu)} /> : null}
          {items.remove ? <Row icon="close" tone="danger" title={t('rooms.delete')} onPress={() => question('delete', menu)} /> : null}
        </Sheet>
      ) : null}

      {ask ? (
        <Sheet onClose={() => (ask.busy ? undefined : setAsk(null))}>
          {ask.kind === 'rename' ? (
            <>
              <SheetTitle>{t('rooms.rename')}</SheetTitle>
              <Small>{t('scanPrepare.name.label')}</Small>
              <TextInput
                value={name}
                onChangeText={setName}
                maxLength={80}
                autoCorrect={false}
                autoFocus
                style={[TYPE.body, styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.bg }]}
              />
            </>
          ) : (
            <SheetTitle>
              {ask.kind === 'delete' ? t('rooms.delete.ask', { name: nameOf(ask.row) }) : t('door.remove.ask', { room: nameOf(ask.row) })}
            </SheetTitle>
          )}
          {ask.problem ? (
            <Small>
              {t(ask.problem === 'building' ? 'rooms.delete.building' : ask.kind === 'removeDoor' ? 'door.remove.failed' : 'rooms.failed')}
            </Small>
          ) : null}
          <AppButton
            label={t(ask.kind === 'rename' ? 'rooms.rename.save' : ask.kind === 'delete' ? 'rooms.delete' : 'door.remove.yes')}
            onPress={() => void confirm()}
            disabled={ask.busy || (ask.kind === 'rename' && roomLabel(name) === null)}
          />
          <AppButton kind="text" label={t(ask.kind === 'rename' ? 'common.cancel' : 'door.remove.keep')} onPress={() => setAsk(null)} disabled={ask.busy} />
        </Sheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  rowMain: { flex: 1, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rowText: { flex: 1, gap: 3 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  input: { height: 48, borderRadius: RADIUS.button, borderWidth: 1, paddingHorizontal: 14 },
  dimmed: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
});
