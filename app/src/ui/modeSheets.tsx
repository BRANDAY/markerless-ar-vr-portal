/**
 * The sheets that guard the change of mode (`docs/product/ui-spec.md`, 4.3 and 5.12): the
 * staff PIN, and the question before switching to visitor mode.
 */
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t, type TextKey } from '../i18n';
import { appActions } from '../state/appStore';
import { getPrefs, prefsActions } from '../state/prefs';
import { afterWrongPin, gateLocked, hashPin, OPEN_GATE, PIN_LENGTH, type PinGate, pinMatches } from './core/modes';
import { enterVisitorMode } from './flows';
import { AppButton, Body, Sheet, SheetTitle, Small } from './kit';
import { TYPE, useTheme } from './theme';

/** Wrong tries are counted for the whole run of the app, not per opening of the sheet. */
let gate: PinGate = OPEN_GATE;

type Stage =
  /** Enter the PIN that exists. */
  | 'enter'
  /** Change: the current PIN first. */
  | 'current'
  /** A new PIN... */
  | 'create'
  /** ...and once more. */
  | 'again';

const TITLE: Record<Stage, TextKey> = {
  enter: 'pin.enter.title',
  current: 'pin.change.current',
  create: 'pin.create.title',
  again: 'pin.again.title',
};

const PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'delete'] as const;

/**
 * The staff PIN. `unlock`: asks for the PIN, or creates one where the device has none
 * yet. `change`: the current PIN, then a new one twice. `onDone` runs once the PIN was
 * right (or set).
 */
export function PinSheet(props: { purpose: 'unlock' | 'change'; onDone: () => void; onClose: () => void }) {
  const theme = useTheme();
  const [stage, setStage] = useState<Stage>(() => {
    const exists = getPrefs().pinHash !== null;
    return props.purpose === 'change' ? (exists ? 'current' : 'create') : exists ? 'enter' : 'create';
  });
  const [digits, setDigits] = useState('');
  const [first, setFirst] = useState('');
  const [message, setMessage] = useState<TextKey | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const locked = gateLocked(gate, now);

  // While the pad is locked, look at the clock until it is not.
  useEffect(() => {
    if (!locked) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [locked]);

  const submit = (pin: string) => {
    setDigits('');
    if (stage === 'enter' || stage === 'current') {
      if (pinMatches(pin, getPrefs().pinHash)) {
        gate = OPEN_GATE;
        setMessage(null);
        if (stage === 'enter') {
          props.onDone();
        } else {
          setStage('create');
        }
      } else {
        gate = afterWrongPin(gate, Date.now());
        setNow(Date.now());
        setMessage('pin.wrong');
      }
    } else if (stage === 'create') {
      setFirst(pin);
      setMessage(null);
      setStage('again');
    } else if (pin === first) {
      prefsActions.set({ pinHash: hashPin(pin) });
      appActions.log('staff PIN set');
      props.onDone();
    } else {
      setFirst('');
      setMessage('pin.mismatch');
      setStage('create');
    }
  };

  const press = (key: (typeof PAD)[number]) => {
    if (locked || key === '') {
      return;
    }
    if (key === 'delete') {
      setDigits((value) => value.slice(0, -1));
      return;
    }
    const next = digits + key;
    if (next.length >= PIN_LENGTH) {
      submit(next.slice(0, PIN_LENGTH));
    } else {
      setDigits(next);
    }
  };

  const body: TextKey | null = stage === 'create' ? 'pin.create.body' : stage === 'enter' ? 'pin.enter.body' : null;
  const note = locked ? t('pin.locked') : message ? t(message) : '';

  return (
    <Sheet onClose={props.onClose}>
      <SheetTitle>{t(TITLE[stage])}</SheetTitle>
      {body ? <Body dim>{t(body)}</Body> : null}
      <View style={styles.dots}>
        {Array.from({ length: PIN_LENGTH }, (_, index) => (
          <View
            key={index}
            style={[styles.dot, { borderColor: theme.ink2 }, index < digits.length ? { backgroundColor: theme.ink, borderColor: theme.ink } : null]}
          />
        ))}
      </View>
      <Small style={{ ...styles.note, color: theme.danger }}>{note}</Small>
      <View style={styles.pad}>
        {PAD.map((key, index) =>
          key === '' ? (
            <View key={index} style={styles.key} />
          ) : (
            <Pressable
              key={index}
              onPress={() => press(key)}
              disabled={locked}
              accessibilityRole="button"
              accessibilityLabel={key === 'delete' ? t('pin.delete') : key}
              style={({ pressed }) => [
                styles.key,
                { backgroundColor: theme.surface2 },
                pressed ? styles.pressed : null,
                locked ? styles.disabled : null,
              ]}
            >
              <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{key === 'delete' ? '⌫' : key}</Text>
            </Pressable>
          ),
        )}
      </View>
      <AppButton kind="text" label={t('common.cancel')} onPress={props.onClose} />
    </Sheet>
  );
}

/** "Switch to visitor mode?" The way back needs the staff PIN, so the sheet says so. */
export function SwitchToVisitorSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{t('settings.switch')}</SheetTitle>
      <Body dim>{t('settings.switch.ask')}</Body>
      <AppButton
        label={t('settings.switch.yes')}
        onPress={() => {
          onClose();
          enterVisitorMode();
        }}
      />
      <AppButton kind="text" label={t('common.cancel')} onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 16, paddingTop: 6 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  note: { textAlign: 'center', minHeight: 18 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, alignSelf: 'center', width: 264 },
  key: { width: 80, height: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
});
