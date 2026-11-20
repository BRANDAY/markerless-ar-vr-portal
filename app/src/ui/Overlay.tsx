import { type ComponentRef, useCallback, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PROVIDER_IDS } from '../localization';
import { formatVec3 } from '../localization/math';
import { appActions, useAppState } from '../state/appStore';
import { ScanPanel } from './ScanPanel';
import { ServerChip } from './ServerPanel';

const TRACKING_COLORS = {
  normal: '#2ecc71',
  limited: '#f1c40f',
  unavailable: '#e74c3c',
} as const;

/** React Native layer drawn on top of the AR view: mode badge, debug panel, event log, buttons. */
export function Overlay() {
  const overlayVisible = useAppState((s) => s.overlayVisible);
  const mode = useAppState((s) => s.mode);

  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        <View style={[styles.modeBadge, mode === 'VR' ? styles.modeVr : styles.modeAr]}>
          <Text style={styles.modeText}>{mode}</Text>
        </View>
        <Button label={overlayVisible ? 'Hide debug' : 'Debug'} onPress={appActions.toggleOverlay} />
      </View>

      {/* Outside the debug overlay on purpose: the server status is always visible. */}
      <ServerChip />

      {overlayVisible ? (
        <>
          <StatusPanel />
          <View style={styles.spacer} pointerEvents="none" />
          <EventLog />
          <ScanPanel />
          <Controls />
        </>
      ) : null}
    </View>
  );
}

function StatusPanel() {
  const trackingState = useAppState((s) => s.trackingState);
  const trackingReason = useAppState((s) => s.trackingReason);
  const cameraPosition = useAppState((s) => s.cameraPosition);
  const cameraForward = useAppState((s) => s.cameraForward);
  const floorY = useAppState((s) => s.floorY);
  const door = useAppState((s) => s.door);
  const providerId = useAppState((s) => s.providerId);
  const providerStatus = useAppState((s) => s.providerStatus);
  const providerDetail = useAppState((s) => s.providerDetail);
  const attachMode = useAppState((s) => s.attachMode);

  return (
    <View style={styles.panel} pointerEvents="none">
      <Text style={styles.line}>
        <Text style={{ color: TRACKING_COLORS[trackingState] }}>
          {'●'} tracking: {trackingState.toUpperCase()}
        </Text>
        {trackingReason ? `  (${trackingReason})` : ''}
      </Text>
      <Text style={styles.line}>cam pos  {formatVec3(cameraPosition)} m</Text>
      <Text style={styles.line}>cam fwd  {formatVec3(cameraForward)}</Text>
      <Text style={styles.line}>
        floor y  {floorY === null ? 'no plane yet' : `${floorY.toFixed(2)} m`}
      </Text>
      <Text style={styles.line}>
        provider {providerId}: {providerStatus}
        {providerDetail ? ` - ${providerDetail}` : ''}
      </Text>
      <Text style={styles.line}>
        door pos {door ? `${formatVec3(door.pose.position)} m` : 'not placed'}
      </Text>
      <Text style={styles.line}>
        door rot {door ? `${formatVec3(door.pose.rotation, 1)} deg` : '-'}
        {door?.quality?.note ? `  [${door.quality.note}]` : ''}
      </Text>
      <Text style={styles.line}>attach   {attachMode}</Text>
    </View>
  );
}

function EventLog() {
  const logVisible = useAppState((s) => s.logVisible);
  const log = useAppState((s) => s.log);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);

  // Scrolling in an effect on `log` runs before the new line has been laid out and leaves
  // the view one entry behind; `onContentSizeChange` fires after layout, when the content
  // really has its new height.
  const scrollToNewest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  if (!logVisible) {
    return null;
  }
  return (
    <View style={styles.logBox}>
      <ScrollView ref={scrollRef} onContentSizeChange={scrollToNewest} onLayout={scrollToNewest}>
        {log.length === 0 ? <Text style={styles.logLine}>(no events yet)</Text> : null}
        {log.map((entry) => (
          <Text key={entry.id} style={styles.logLine}>
            {entry.t.toFixed(1).padStart(6, ' ')}s  {entry.text}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function Controls() {
  const attachMode = useAppState((s) => s.attachMode);
  const providerId = useAppState((s) => s.providerId);
  const logVisible = useAppState((s) => s.logVisible);
  const environment = useAppState((s) => s.environment);

  const nextProvider = () => {
    const index = PROVIDER_IDS.indexOf(providerId);
    appActions.setProvider(PROVIDER_IDS[(index + 1) % PROVIDER_IDS.length]);
  };

  return (
    <View style={styles.controls} pointerEvents="box-none">
      <Button label="Re-place door" onPress={appActions.requestRelocalize} />
      <Button
        label={`Attach: ${attachMode}`}
        onPress={() => appActions.setAttachMode(attachMode === 'direct' ? 'parent' : 'direct')}
      />
      <Button label={`Provider: ${providerId}`} onPress={nextProvider} />
      <Button
        label={`World: ${environment}`}
        onPress={() => appActions.setEnvironment(environment === 'sponza' ? 'test-room' : 'sponza')}
      />
      <Button label={logVisible ? 'Hide log' : 'Show log'} onPress={appActions.toggleLog} />
      <Button label="Clear log" onPress={appActions.clearLog} />
    </View>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const MONO = 'monospace';

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    paddingTop: 44,
    paddingBottom: 28,
    paddingHorizontal: 10,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modeBadge: {
    paddingHorizontal: 18,
    paddingVertical: 6,
    borderRadius: 8,
  },
  modeAr: { backgroundColor: 'rgba(30, 132, 73, 0.9)' },
  modeVr: { backgroundColor: 'rgba(155, 40, 190, 0.95)' },
  modeText: { color: '#fff', fontSize: 22, fontWeight: '700', letterSpacing: 2 },
  panel: {
    marginTop: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  line: { color: '#fff', fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  spacer: { flex: 1 },
  logBox: {
    height: 150,
    padding: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  logLine: { color: '#d6f5ff', fontFamily: MONO, fontSize: 11, lineHeight: 15 },
  controls: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: 'rgba(20, 20, 30, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  buttonPressed: { backgroundColor: 'rgba(90, 90, 120, 0.9)' },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
