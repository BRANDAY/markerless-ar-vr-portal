import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { t } from '../i18n';
import { formatAddress, parseServerAddress } from '../server/core/address';
import { serverConnection } from '../server/ServerConnection';
import { getPhoneNetworkState } from '../server/wifiRoute';
import { appActions } from '../state/appStore';
import { usePrefs } from '../state/prefs';
import { homeScreen, openDoor, searchForServer } from './flows';
import { AppButton, Body, IconTile, Row, ScreenFrame, Sheet, SheetTitle, Small, Title } from './kit';
import { useServerView } from './ServerPanel';
import { RADIUS, TYPE, useTheme } from './theme';

type Kind = 'searching' | 'found' | 'several' | 'none' | 'wifi' | 'version';

/**
 * Find the server (`docs/product/ui-spec.md`, 5.3). The search starts at once; the
 * states are those of the existing connection (`server/core/connectionMachine.ts`).
 */
export function ConnectScreen({ firstRun }: { firstRun: boolean }) {
  const theme = useTheme();
  const { connection, lastSearch } = useServerView();
  const auto = usePrefs((s) => s.findAutomatically);
  const [addressOpen, setAddressOpen] = useState(false);

  useEffect(() => {
    const state = serverConnection.getView().connection.state;
    if (auto && (state === 'not-configured' || state === 'unreachable')) {
      searchForServer();
    }
    // Only on entry: a search that ends without a server must not start itself again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const several = (lastSearch?.found ?? []).filter((server) => server.compatible);
  const wifi = getPhoneNetworkState()?.wifiConnected !== false;
  let kind: Kind;
  if (connection.state === 'incompatible') {
    kind = 'version';
  } else if (connection.state === 'connected') {
    kind = 'found';
  } else if (connection.state === 'searching' || connection.state === 'connecting') {
    kind = 'searching';
  } else if (several.length > 1) {
    kind = 'several';
  } else if (!wifi) {
    kind = 'wifi';
  } else {
    kind = 'none';
  }

  const done = () => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  };
  const withoutServer = () => {
    appActions.resetTo(homeScreen());
    openDoor('free');
  };
  const roomCount = connection.info?.maps.length ?? 0;

  let body: React.ReactNode;
  let footer: React.ReactNode;
  switch (kind) {
    case 'searching':
      body = (
        <>
          <IconTile icon="search" tone="amber" size={56} />
          <Title>{t('connect.searching.title')}</Title>
          <Body dim>{t('connect.searching.body')}</Body>
          {connection.scan ? (
            <View style={[styles.track, { backgroundColor: theme.surface2 }]}>
              <View
                style={[
                  styles.fill,
                  { backgroundColor: theme.teal, width: `${Math.round((connection.scan.scanned / Math.max(1, connection.scan.total)) * 100)}%` },
                ]}
              />
            </View>
          ) : null}
        </>
      );
      footer = (
        <>
          <AppButton kind="ghost" label={t('connect.enterAddressInstead')} onPress={() => setAddressOpen(true)} />
          <AppButton kind="text" label={t('connect.tryWithoutServer')} onPress={withoutServer} />
        </>
      );
      break;
    case 'found':
      body = (
        <>
          <IconTile icon="check" tone="teal" size={56} />
          <Title>{t('connect.found.title', { server: connection.info?.serverName ?? '' })}</Title>
          <Body dim>
            {roomCount === 0
              ? t('connect.found.body.none')
              : roomCount === 1
                ? t('connect.found.body.one')
                : t('connect.found.body', { n: roomCount })}
          </Body>
        </>
      );
      footer = <AppButton label={t('common.connect')} onPress={done} />;
      break;
    case 'several':
      body = (
        <>
          <Title>{t('connect.several.title')}</Title>
          {several.map((server) => (
            <Row
              key={formatAddress(server.address)}
              icon="wifi"
              tone="teal"
              title={server.info.serverName}
              sub={formatAddress(server.address)}
              arrow
              onPress={() => void serverConnection.connectTo(server.address)}
            />
          ))}
        </>
      );
      footer = <AppButton kind="text" label={t('connect.tryWithoutServer')} onPress={withoutServer} />;
      break;
    case 'wifi':
      body = (
        <>
          <IconTile icon="wifi" tone="danger" size={56} />
          <Title>{t('connect.wifi.title')}</Title>
          <Body dim>{t('connect.wifi.body')}</Body>
        </>
      );
      footer = <AppButton label={t('common.searchAgain')} onPress={searchForServer} />;
      break;
    case 'version':
      body = (
        <>
          <IconTile icon="alert" tone="danger" size={56} />
          <Title>{t('connect.version.title')}</Title>
          <Body dim>{t('connect.version.body')}</Body>
        </>
      );
      footer = <AppButton label={t('common.searchAgain')} onPress={searchForServer} />;
      break;
    case 'none':
      body = (
        <>
          <IconTile icon="wifi" tone="neutral" size={56} />
          <Title>{t('connect.none.title')}</Title>
          <Body dim>{t('connect.none.body')}</Body>
          <Row long icon="check" title={t('connect.none.check.pc')} />
          <Row long icon="check" title={t('connect.none.check.wifi')} />
        </>
      );
      footer = (
        <>
          <AppButton label={t('common.searchAgain')} onPress={searchForServer} />
          <AppButton kind="ghost" label={t('connect.enterAddress')} onPress={() => setAddressOpen(true)} />
          <AppButton kind="text" label={t('connect.tryWithoutServer')} onPress={withoutServer} />
        </>
      );
      break;
  }

  return (
    <View style={styles.flex}>
      <ScreenFrame onBack={firstRun ? undefined : done} title="" footer={footer}>
        <View style={styles.body}>{body}</View>
      </ScreenFrame>
      {addressOpen ? <AddressSheet onClose={() => setAddressOpen(false)} /> : null}
    </View>
  );
}

function AddressSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const current = serverConnection.getView().connection.address;
  const [text, setText] = useState(current ? formatAddress(current) : '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    const parsed = parseServerAddress(text);
    if (!parsed.ok) {
      setMessage(parsed.error);
      return;
    }
    setBusy(true);
    setMessage(t('connect.address.checking'));
    const result = await serverConnection.connectTo(parsed.address);
    setBusy(false);
    if (result.kind === 'ok') {
      onClose();
    } else if (result.kind === 'incompatible') {
      setMessage(t('connect.version.body'));
    } else {
      setMessage(t('connect.address.noAnswer'));
    }
  };

  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{t('connect.address.label')}</SheetTitle>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t('connect.address.hint')}
        placeholderTextColor={theme.ink2}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[TYPE.body, styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.bg }]}
      />
      {message ? <Small>{message}</Small> : null}
      <AppButton label={t('common.connect')} disabled={busy} onPress={() => void connect()} />
      <AppButton kind="text" label={t('common.cancel')} onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { gap: 12, paddingTop: 24 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  input: { height: 52, borderWidth: 1, borderRadius: RADIUS.button, paddingHorizontal: 14 },
});
