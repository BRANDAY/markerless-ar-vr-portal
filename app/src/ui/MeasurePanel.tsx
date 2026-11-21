import { Pressable, StyleSheet, Text, View } from 'react-native';

import { referenceFrame, TOLERANCE } from '../measure/core/measurement';
import { measureController, useMeasure } from '../measure/measureController';
import { useAppState } from '../state/appStore';

/**
 * Measurement mode (assignment task 5): choose the test, mark the two bottom corners of
 * the real door opening, press "Measure". Part of the debug overlay; shown instead of
 * the room-scan panel while the mode is on. The procedure is in `docs/test-protocol.md`.
 */
export function MeasurePanel() {
  const condition = useMeasure((s) => s.condition);
  const method = useMeasure((s) => s.method);
  const left = useMeasure((s) => s.left);
  const right = useMeasure((s) => s.right);
  const stale = useMeasure((s) => s.stale);
  const records = useMeasure((s) => s.records);
  const checks = useMeasure((s) => s.checks);
  const last = useMeasure((s) => s.last);
  const lastPass = useMeasure((s) => s.lastPass);
  const file = useMeasure((s) => s.file);
  const door = useAppState((s) => s.door);

  const frame = referenceFrame({ left: left?.point ?? null, right: right?.point ?? null });
  const marks =
    `left ${left ? 'set' : '-'}, right ${right ? 'set' : '-'}` +
    (frame ? `, opening ${frame.widthM.toFixed(2)} m wide` : left && right ? ', too close together' : '') +
    (stale ? ' - made before tracking was interrupted: check the posts' : '');

  return (
    <View style={styles.box} pointerEvents="box-none">
      <View style={styles.numbers} pointerEvents="none">
        <Text style={styles.line}>
          test   {condition}: {checks} measured, {records} records{file ? `, ${file}` : ''}
        </Text>
        <Text style={[styles.line, stale ? styles.attention : null]}>marks  {marks}</Text>
        <Text style={[styles.line, lastPass === false ? styles.attention : lastPass ? styles.good : null]}>
          last   {last || `nothing yet (tolerance ${TOLERANCE.positionCm} cm / ${TOLERANCE.headingDeg} deg)`}
        </Text>
      </View>
      <View style={styles.buttons} pointerEvents="box-none">
        <PanelButton label={`Test: ${condition}`} onPress={measureController.nextCondition} />
        <PanelButton label="Mark left" active={left !== null} onPress={() => measureController.mark('left')} />
        <PanelButton label="Mark right" active={right !== null} onPress={() => measureController.mark('right')} />
        <PanelButton label="Measure" disabled={!door} onPress={measureController.measureNow} />
        <PanelButton label={`Mark by: ${method}`} onPress={measureController.toggleMethod} />
        {left || right ? <PanelButton label="Clear marks" onPress={measureController.clearMarks} /> : null}
      </View>
    </View>
  );
}

/** The point of the screen a corner is aimed at: the middle of the camera image. */
export function Crosshair() {
  const visible = useMeasure((s) => s.visible);
  const method = useMeasure((s) => s.method);
  if (!visible || method !== 'aim') {
    return null;
  }
  return (
    <View style={styles.crosshairLayer} pointerEvents="none">
      <View style={styles.crosshairBox}>
        <View style={[styles.crosshairLine, styles.crosshairHorizontal]} />
        <View style={[styles.crosshairLine, styles.crosshairVertical]} />
        <View style={styles.crosshairDot} />
      </View>
    </View>
  );
}

function PanelButton(props: { label: string; onPress: () => void; active?: boolean; disabled?: boolean }) {
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

const CROSSHAIR = 44;
const LINE = 2;

const styles = StyleSheet.create({
  box: { marginTop: 8 },
  numbers: { padding: 6, borderRadius: 8, backgroundColor: 'rgba(0, 0, 0, 0.55)' },
  line: { color: '#fff', fontFamily: 'monospace', fontSize: 11, lineHeight: 15 },
  attention: { color: '#ffb74d' },
  good: { color: '#8ef0a8' },
  buttons: { marginTop: 6, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: 'rgba(70, 20, 70, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(255, 43, 214, 0.7)',
  },
  buttonActive: { backgroundColor: 'rgba(150, 30, 130, 0.95)' },
  buttonPressed: { backgroundColor: 'rgba(90, 90, 120, 0.9)' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  // Fills the overlay (which covers the AR view exactly), so its centre is the centre of
  // the camera image.
  crosshairLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crosshairBox: { width: CROSSHAIR, height: CROSSHAIR },
  crosshairLine: { position: 'absolute', backgroundColor: 'rgba(255, 43, 214, 0.95)' },
  crosshairHorizontal: { left: 0, right: 0, top: (CROSSHAIR - LINE) / 2, height: LINE },
  crosshairVertical: { top: 0, bottom: 0, left: (CROSSHAIR - LINE) / 2, width: LINE },
  crosshairDot: {
    position: 'absolute',
    left: CROSSHAIR / 2 - 3,
    top: CROSSHAIR / 2 - 3,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fff',
  },
});
