/**
 * Shared pieces of the interface (`docs/product/ui-spec.md`, section 3): buttons, the
 * screen frame, rows, notices, and the elements drawn over the camera (pill, round
 * button, coach card, sheet). Colours come from `theme.ts`; nothing here knows a text.
 */
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Switch, Text, type TextStyle, View, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './icons';
import { HUD, RADIUS, SIZE, SPACE, TYPE, useInsets, useTheme } from './theme';

// ---- buttons -----------------------------------------------------------------------------

export type ButtonKind = 'primary' | 'ghost' | 'text';

/**
 * `primary` is the one amber button of a screen, `ghost` an outlined second choice,
 * `text` a quiet third. `onCamera` switches ghost and text to the look used on video.
 */
export function AppButton(props: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  onCamera?: boolean;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const kind = props.kind ?? 'primary';
  const ink = props.onCamera ? HUD.fg : theme.ink;
  const box: ViewStyle =
    kind === 'primary'
      ? { backgroundColor: theme.amber }
      : kind === 'ghost'
        ? { borderWidth: 1, borderColor: props.onCamera ? HUD.line : theme.line, backgroundColor: props.onCamera ? HUD.bg : 'transparent' }
        : { height: SIZE.touch };
  const text: TextStyle = { color: kind === 'primary' ? theme.amberInk : ink };
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        box,
        pressed ? styles.pressed : null,
        props.disabled ? styles.disabled : null,
        props.style,
      ]}
    >
      <Text style={[TYPE.button, text, kind === 'text' ? styles.textButton : null]} numberOfLines={2}>
        {props.label}
      </Text>
    </Pressable>
  );
}

// ---- screens that are not over the camera ------------------------------------------------

/** Background, safe padding, optional top bar, scrolling body and a footer for the buttons. */
export function ScreenFrame(props: {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** The body lays itself out (a pager): no scrolling and no side padding around it. */
  plain?: boolean;
}) {
  const theme = useTheme();
  const insets = useInsets();
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {props.title !== undefined || props.onBack || props.right ? (
        <View style={styles.topBar}>
          {props.onBack ? (
            <Pressable onPress={props.onBack} hitSlop={8} style={styles.topBarButton} accessibilityRole="button">
              <Icon name="back" color={theme.ink} />
            </Pressable>
          ) : null}
          <Text style={[TYPE.rowTitle, styles.topBarTitle, { color: theme.ink }]} numberOfLines={1}>
            {props.title ?? ''}
          </Text>
          {props.right ?? null}
        </View>
      ) : null}
      {props.plain ? (
        <View style={styles.flex}>{props.children}</View>
      ) : (
        <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {props.children}
        </ScrollView>
      )}
      {props.footer ? <View style={styles.footer}>{props.footer}</View> : null}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[TYPE.title, { color: theme.ink }]}>{children}</Text>;
}

export function Body({ children, dim, style }: { children: ReactNode; dim?: boolean; style?: TextStyle }) {
  const theme = useTheme();
  return <Text style={[TYPE.body, { color: dim ? theme.ink2 : theme.ink }, style]}>{children}</Text>;
}

export function Small({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const theme = useTheme();
  return <Text style={[TYPE.small, { color: theme.ink2 }, style]}>{children}</Text>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[TYPE.eyebrow, { color: theme.ink2 }]}>{children}</Text>;
}

export function Card({ children, style, dimmed }: { children: ReactNode; style?: ViewStyle; dimmed?: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.line }, dimmed ? styles.dimmed : null, style]}>
      {children}
    </View>
  );
}

export type Tone = 'neutral' | 'amber' | 'teal' | 'danger';

/** A square tile with an icon: the leading element of rows, problems and option lists. */
export function IconTile({ icon, tone = 'neutral', size = 44 }: { icon: IconName; tone?: Tone; size?: number }) {
  const theme = useTheme();
  const fill = { neutral: theme.surface2, amber: theme.amberSoft, teal: theme.tealSoft, danger: theme.dangerSoft }[tone];
  const ink = { neutral: theme.ink, amber: theme.amberText, teal: theme.teal, danger: theme.danger }[tone];
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: fill }]}>
      <Icon name={icon} color={ink} />
    </View>
  );
}

/** One line of a list: tile, title, second line, and a value, switch or arrow on the right. */
export function Row(props: {
  icon?: IconName;
  tone?: Tone;
  title: string;
  sub?: string;
  value?: string;
  onPress?: () => void;
  toggle?: { value: boolean; onChange: (value: boolean) => void };
  arrow?: boolean;
  /** The title is a sentence, not a name: body weight. */
  long?: boolean;
}) {
  const theme = useTheme();
  const content = (
    <View style={[styles.row, { borderColor: theme.line }]}>
      {props.icon ? <IconTile icon={props.icon} tone={props.tone} /> : null}
      <View style={styles.rowText}>
        <Text style={[props.long ? TYPE.body : TYPE.rowTitle, { color: theme.ink }]}>{props.title}</Text>
        {props.sub ? <Text style={[TYPE.small, { color: theme.ink2 }]}>{props.sub}</Text> : null}
      </View>
      {props.value ? (
        <Text style={[TYPE.small, styles.rowValue, { color: theme.ink2 }]} numberOfLines={2}>
          {props.value}
        </Text>
      ) : null}
      {props.toggle ? (
        <Switch
          value={props.toggle.value}
          onValueChange={props.toggle.onChange}
          trackColor={{ false: theme.surface2, true: theme.teal }}
          thumbColor={theme.surface}
        />
      ) : null}
      {props.arrow ? <Icon name="forward" color={theme.ink2} size={16} /> : null}
    </View>
  );
  if (!props.onPress) {
    return content;
  }
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" style={({ pressed }) => (pressed ? styles.pressed : null)}>
      {content}
    </Pressable>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.notice, { backgroundColor: theme.surface2 }]}>
      <Text style={[TYPE.small, { color: theme.ink2 }]}>{children}</Text>
    </View>
  );
}

export function Tag({ label, tone = 'teal' }: { label: string; tone?: Tone }) {
  const theme = useTheme();
  const fill = { neutral: theme.surface2, amber: theme.amberSoft, teal: theme.tealSoft, danger: theme.dangerSoft }[tone];
  const ink = { neutral: theme.ink2, amber: theme.amberText, teal: theme.teal, danger: theme.danger }[tone];
  return (
    <View style={[styles.tag, { backgroundColor: fill }]}>
      <Text style={[TYPE.small, { color: ink, fontWeight: '600' }]}>{label}</Text>
    </View>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

// ---- over the camera ---------------------------------------------------------------------

/** A round 44-point button on video: close, menu, info. */
export function HudButton({ icon, onPress, label }: { icon: IconName; onPress: () => void; label: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.hudButton, pressed ? styles.pressed : null]}
    >
      <Icon name={icon} color={HUD.fg} />
    </Pressable>
  );
}

/** A label on video; with `onPress` it is a control, with `action` it carries a second, bold part. */
export function HudPill(props: {
  text: string;
  action?: string;
  onPress?: () => void;
  icon?: IconName;
  danger?: boolean;
}) {
  const content = (
    <View style={[styles.pill, props.danger ? styles.pillDanger : null]}>
      {props.icon ? <Icon name={props.icon} color={HUD.fg} size={16} /> : null}
      <Text style={[TYPE.small, styles.pillText]} numberOfLines={2}>
        {props.text}
        {props.action ? <Text style={styles.pillAction}>{`  ·  ${props.action}`}</Text> : null}
      </Text>
    </View>
  );
  if (!props.onPress) {
    return content;
  }
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button" hitSlop={8} style={({ pressed }) => (pressed ? styles.pressed : null)}>
      {content}
    </Pressable>
  );
}

/** The one instruction of the moment: a bold line, a second line, and at most one button. */
export function CoachCard(props: { line1: string; line2?: string; danger?: boolean; children?: ReactNode }) {
  return (
    <View style={[styles.coach, props.danger ? styles.pillDanger : null]}>
      <Text style={[TYPE.rowTitle, styles.coachLine1]}>{props.line1}</Text>
      {props.line2 ? <Text style={[TYPE.small, styles.coachLine2]}>{props.line2}</Text> : null}
      {props.children ? <View style={styles.coachExtra}>{props.children}</View> : null}
    </View>
  );
}

/**
 * A sheet from the bottom edge with a dimmed backdrop. Drawn as plain views inside the
 * screen (not a system dialog), so the screen's own back handling closes it.
 */
export function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const theme = useTheme();
  const insets = useInsets();
  // Android's back button closes the sheet before it does anything else.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);
  return (
    <View style={styles.sheetLayer}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: theme.surface, paddingBottom: insets.bottom + 8 }]}>
        <View style={[styles.grabber, { backgroundColor: theme.line }]} />
        {children}
      </View>
    </View>
  );
}

export function SheetTitle({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{children}</Text>;
}

// ---- behaviour ---------------------------------------------------------------------------

/** Calls `onDone` after seven presses in a row, each within a second and a half of the last. */
export function useSevenTaps(onDone: () => void): () => void {
  const count = useRef(0);
  const last = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    count.current = now - last.current < 1500 ? count.current + 1 : 1;
    last.current = now;
    if (count.current >= 7) {
      count.current = 0;
      onDone();
    }
  }, [onDone]);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  dimmed: { opacity: 0.55 },
  button: {
    height: SIZE.button,
    borderRadius: RADIUS.button,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textButton: { fontWeight: '600', textAlign: 'center' },
  screen: { flex: 1 },
  topBar: {
    height: 52,
    paddingHorizontal: SPACE.screen - 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  topBarButton: { width: SIZE.touch, height: SIZE.touch, alignItems: 'center', justifyContent: 'center' },
  topBarTitle: { flex: 1, paddingHorizontal: 8 },
  body: { paddingHorizontal: SPACE.screen, paddingTop: 8, paddingBottom: 24, gap: SPACE.gap },
  footer: { paddingHorizontal: SPACE.screen, paddingTop: 8, gap: 4 },
  card: { borderRadius: RADIUS.card, borderWidth: 1, padding: 16, gap: 8 },
  tile: { borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rowText: { flex: 1, gap: 2 },
  rowValue: { maxWidth: '45%', textAlign: 'right' },
  notice: { borderRadius: 14, padding: 12 },
  tag: { alignSelf: 'flex-start', borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 3 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  hudButton: {
    width: SIZE.touch,
    height: SIZE.touch,
    borderRadius: SIZE.touch / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  pill: {
    minHeight: 36,
    maxWidth: 300,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  pillDanger: { backgroundColor: HUD.danger },
  pillText: { color: HUD.fg, flexShrink: 1 },
  pillAction: { fontWeight: '700' },
  coach: {
    borderRadius: RADIUS.card,
    padding: 16,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  coachLine1: { color: HUD.fg, fontSize: 17 },
  coachLine2: { color: HUD.dim, marginTop: 3 },
  coachExtra: { marginTop: 12 },
  sheetLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(5,8,14,0.5)' },
  sheet: {
    borderTopLeftRadius: RADIUS.sheet,
    borderTopRightRadius: RADIUS.sheet,
    paddingHorizontal: SPACE.screen,
    paddingTop: 10,
    gap: 10,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginBottom: 6 },
});
