import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRoomScan } from '../room/roomStore';
import { scanController } from '../room/scanController';

/** Room-scan controls and numbers, part of the debug overlay. */
export function ScanPanel() {
  const scanning = useRoomScan((s) => s.scanning);
  const wireframe = useRoomScan((s) => s.wireframe);
  const room = useRoomScan((s) => s.room);
  const planeCount = useRoomScan((s) => s.planeCount);
  const depthReady = useRoomScan((s) => s.depthReady);
  const mesh = useRoomScan((s) => s.mesh);
  const recording = useRoomScan((s) => s.recording);
  const recordingSince = useRoomScan((s) => s.recordingSince);

  // Re-render once a second while recording, for the timer.
  const [, tick] = useState(0);
  useEffect(() => {
    if (recordingSince === null) {
      return undefined;
    }
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [recordingSince]);

  const seconds = recordingSince === null ? 0 : Math.floor((Date.now() - recordingSince) / 1000);
  const recordLabel =
    recording === 'recording'
      ? `Stop rec ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : recording === 'idle'
        ? 'Record'
        : recording === 'starting'
          ? 'Starting...'
          : 'Saving...';

  const meshLine = !scanning
    ? 'off'
    : mesh === null
      ? 'waiting...'
      : mesh.available
        ? `${mesh.source}${mesh.accumulated ? ' (accumulated)' : ''}: ${mesh.triangleCount} triangles, ${mesh.vertexCount} vertices`
        : `not available${mesh.reason ? ` - ${mesh.reason}` : ''}`;

  return (
    <View style={styles.box} pointerEvents="box-none">
      <View style={styles.numbers} pointerEvents="none">
        <Text style={styles.line}>
          room   {room.wallCount} walls, {room.corners.length} corners, floor {room.floorArea.toFixed(1)} m2, {planeCount} planes
        </Text>
        <Text style={styles.line}>
          mesh   {meshLine}
          {scanning ? `   depth ${depthReady ? 'ready' : 'not reported'}` : ''}
        </Text>
      </View>
      <View style={styles.buttons} pointerEvents="box-none">
        <ScanButton
          label={scanning ? 'Scan: ON' : 'Scan room'}
          active={scanning}
          onPress={() => scanController.setScanning(!scanning)}
        />
        <ScanButton
          label={recordLabel}
          active={recording === 'recording'}
          disabled={recording === 'starting' || recording === 'stopping'}
          onPress={() => void scanController.toggleRecording()}
        />
        {scanning ? (
          <>
            <ScanButton label={wireframe ? 'Mesh lines: on' : 'Mesh lines'} active={wireframe} onPress={scanController.toggleWireframe} />
            <ScanButton label="Save mesh" onPress={() => void scanController.snapshot()} />
            <ScanButton label="Reset mesh" onPress={() => void scanController.reset()} />
          </>
        ) : null}
      </View>
    </View>
  );
}

function ScanButton(props: { label: string; onPress: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => [
        styles.button,
        props.active ? styles.buttonActive : null,
        pressed ? styles.buttonPressed : null,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 8 },
  numbers: { padding: 6, borderRadius: 8, backgroundColor: 'rgba(0, 0, 0, 0.55)' },
  line: { color: '#fff', fontFamily: 'monospace', fontSize: 11, lineHeight: 15 },
  buttons: { marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: 'rgba(8, 60, 70, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.7)',
  },
  buttonActive: { backgroundColor: 'rgba(14, 116, 144, 0.95)' },
  buttonPressed: { backgroundColor: 'rgba(90, 90, 120, 0.9)' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
