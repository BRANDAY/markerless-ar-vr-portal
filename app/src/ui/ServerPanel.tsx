import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { DEFAULT_PORT, formatAddress, parseServerAddress } from '../server/core/address';
import {
  describeConnection,
  type ConnectionSnapshot,
  type ConnectionState,
} from '../server/core/connectionMachine';
import type { DiscoveredServer } from '../server/core/discovery';
import { serverConnection, type ServerConnectionView } from '../server/ServerConnection';

const STATE_COLORS: Record<ConnectionState, string> = {
  connected: '#1e8e4a',
  searching: '#5c6470',
  connecting: '#5c6470',
  'not-configured': '#5c6470',
  unreachable: '#b3392f',
  incompatible: '#b3392f',
};

/** What each state means, shown under the status in the settings panel. */
const STATE_HELP: Record<ConnectionState, string> = {
  'not-configured': 'No server address yet. Use "Find automatically" or type the address of the computer that runs the server.',
  searching: 'Looking for the server on the phone\'s Wi-Fi network...',
  connecting: 'Waiting for the first answer from the server...',
  connected: 'The server answers and is compatible with this app.',
  unreachable: 'No usable answer from this address. Is the server running? Same Wi-Fi? Firewall on the computer?',
  incompatible: 'The server answers but uses a different API version. Update the app or the server.',
};

function useServerView(): ServerConnectionView {
  return useSyncExternalStore(
    (listener) => serverConnection.subscribe(listener),
    () => serverConnection.getView(),
    () => serverConnection.getView(),
  );
}

/** Always-visible status chip; tapping it opens the server settings. */
export function ServerChip() {
  const { connection } = useServerView();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <Pressable
        onPress={() => setSettingsOpen(true)}
        style={[styles.chip, { backgroundColor: STATE_COLORS[connection.state] }]}
      >
        <Text style={styles.chipText} numberOfLines={1}>
          {describeConnection(connection)}
        </Text>
      </Pressable>
      {settingsOpen ? <ServerSettings onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}

function ServerSettings({ onClose }: { onClose: () => void }) {
  const { connection, lastSearch } = useServerView();
  const [text, setText] = useState(() =>
    connection.address ? formatAddress(connection.address) : '',
  );
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  // The phone changes Wi-Fi networks and addresses on its own: keep the line current.
  const [phoneNetwork, setPhoneNetwork] = useState(() => serverConnection.describePhoneNetwork());
  useEffect(() => {
    const timer = setInterval(() => setPhoneNetwork(serverConnection.describePhoneNetwork()), 2000);
    return () => clearInterval(timer);
  }, []);
  const searching = connection.state === 'searching';

  // Follow address changes made elsewhere (automatic search choosing a server).
  const currentAddress = connection.address ? formatAddress(connection.address) : null;
  useEffect(() => {
    if (currentAddress) {
      setText(currentAddress);
    }
  }, [currentAddress]);

  const testConnection = useCallback(async () => {
    const parsed = parseServerAddress(text);
    if (!parsed.ok) {
      setMessage(parsed.error);
      return;
    }
    setTesting(true);
    setMessage('Testing...');
    const result = await serverConnection.connectTo(parsed.address);
    setTesting(false);
    switch (result.kind) {
      case 'ok':
        setMessage(`Connected to ${result.info.serverName} (${result.latencyMs} ms).`);
        break;
      case 'incompatible':
        setMessage(`Incompatible server: ${result.reason}.`);
        break;
      case 'unhealthy':
        setMessage(`The server answers but is not ready: ${result.reason}.`);
        break;
      case 'not-our-server':
        setMessage(`Something answers there, but it is not the localization server (${result.reason}).`);
        break;
      case 'unreachable':
        setMessage(`No connection: ${result.reason}.`);
        break;
    }
  }, [text]);

  const findAutomatically = useCallback(async () => {
    // A port typed into the field is used for the search as well.
    const parsed = parseServerAddress(text);
    const port = parsed.ok ? parsed.address.port : DEFAULT_PORT;
    setMessage('');
    await serverConnection.findAutomatically(port);
  }, [text]);

  const choose = useCallback(async (server: DiscoveredServer) => {
    setText(formatAddress(server.address));
    setMessage('Testing...');
    const result = await serverConnection.connectTo(server.address);
    setMessage(result.kind === 'ok' ? `Connected to ${result.info.serverName}.` : 'That server did not answer the second time.');
  }, []);

  const forget = useCallback(() => {
    serverConnection.forget();
    setText('');
    setMessage('Address forgotten.');
  }, []);

  const found = lastSearch?.found ?? [];
  const showChoices = !searching && found.length > 0 && connection.state !== 'connected';

  return (
    <Modal transparent={true} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Localization server</Text>

            <View style={[styles.statusBox, { borderColor: STATE_COLORS[connection.state] }]}>
              <Text style={[styles.statusText, { color: STATE_COLORS[connection.state] }]}>
                {describeConnection(connection)}
              </Text>
              <Text style={styles.help}>{STATE_HELP[connection.state]}</Text>
              {connection.detail ? <Text style={styles.detail}>{connection.detail}</Text> : null}
              <ServerFacts connection={connection} />
            </View>

            <Text style={styles.label}>Address (host or host:port, default port {DEFAULT_PORT})</Text>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="address of the computer running the server"
              placeholderTextColor="#7d8590"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={testConnection}
              editable={!searching}
            />

            <View style={styles.buttons}>
              <PanelButton label="Test connection" onPress={testConnection} disabled={searching || testing} />
              {searching ? (
                <PanelButton label="Cancel search" onPress={() => serverConnection.cancelSearch()} />
              ) : (
                <PanelButton label="Find automatically" onPress={findAutomatically} disabled={testing} />
              )}
              <PanelButton label="Forget" onPress={forget} disabled={searching || !connection.address} />
            </View>

            {searching && connection.scan ? (
              <Text style={styles.message}>
                Searching the Wi-Fi network: {connection.scan.scanned} of {connection.scan.total} addresses
                checked. This can take up to a minute: a faster search makes some routers cut the phone off.
              </Text>
            ) : null}
            {message ? <Text style={styles.message}>{message}</Text> : null}
            {!searching && lastSearch ? <Text style={styles.message}>{lastSearch.message}</Text> : null}

            {showChoices
              ? found.map((server) => (
                  <Pressable
                    key={formatAddress(server.address)}
                    style={styles.choice}
                    onPress={() => choose(server)}
                    disabled={!server.compatible}
                  >
                    <Text style={styles.choiceName}>
                      {server.info.serverName}
                      {server.compatible ? '' : '  (incompatible)'}
                    </Text>
                    <Text style={styles.choiceMeta}>
                      {formatAddress(server.address)} · {server.latencyMs} ms
                      {server.info.serverVersion ? ` · v${server.info.serverVersion}` : ''}
                    </Text>
                  </Pressable>
                ))
              : null}

            <Text style={styles.fact}>{phoneNetwork}</Text>
            <Text style={styles.help}>
              The phone and the computer must be on the same network. The last address that
              worked is remembered and tried first at the next start.
            </Text>
          </ScrollView>
          <PanelButton label="Close" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function ServerFacts({ connection }: { connection: ConnectionSnapshot }) {
  const { info, address, latencyMs } = connection;
  if (!info || !address) {
    return null;
  }
  return (
    <View style={styles.facts}>
      <Text style={styles.fact}>name     {info.serverName}</Text>
      <Text style={styles.fact}>address  {formatAddress(address)}</Text>
      <Text style={styles.fact}>
        version  {info.serverVersion || '?'} (API {Number.isNaN(info.apiVersion) ? '?' : info.apiVersion})
      </Text>
      {latencyMs !== null ? <Text style={styles.fact}>latency  {latencyMs} ms</Text> : null}
      {info.device ? (
        <Text style={styles.fact}>
          compute  {info.device}
          {info.deviceName ? ` (${info.deviceName})` : ''}
        </Text>
      ) : null}
      <Text style={styles.fact}>maps     {info.maps.length > 0 ? info.maps.join(', ') : 'none'}</Text>
    </View>
  );
}

function PanelButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        pressed ? styles.buttonPressed : null,
        disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const MONO = 'monospace';

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingTop: 48,
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  panel: {
    maxHeight: '100%',
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#161b22',
  },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 10 },
  statusBox: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 12 },
  statusText: { fontSize: 15, fontWeight: '700' },
  help: { color: '#9aa4b0', fontSize: 12, lineHeight: 17, marginTop: 6 },
  detail: { color: '#e3b341', fontSize: 12, lineHeight: 17, marginTop: 6 },
  facts: { marginTop: 8 },
  fact: { color: '#d0d7de', fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  label: { color: '#d0d7de', fontSize: 13, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#3d444d',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: '#fff',
    fontSize: 16,
    backgroundColor: '#0d1117',
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2d6cdf',
    alignItems: 'center',
    marginTop: 4,
  },
  buttonPressed: { backgroundColor: '#1f4fa8' },
  buttonDisabled: { backgroundColor: '#3d444d' },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  message: { color: '#fff', fontSize: 13, lineHeight: 18, marginTop: 10 },
  choice: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3d444d',
  },
  choiceName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  choiceMeta: { color: '#9aa4b0', fontFamily: MONO, fontSize: 12, marginTop: 2 },
});
