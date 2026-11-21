import { StyleSheet, Text, View } from 'react-native';

/**
 * The interface's icons, drawn with plain views: outline, round ends, one weight. No
 * vector-drawing module is part of the build, so every icon is made of bars, rings and
 * corners. One set only (`ui-spec.md`, 3.3).
 */
export type IconName =
  | 'close'
  | 'back'
  | 'forward'
  | 'more'
  | 'settings'
  | 'info'
  | 'check'
  | 'alert'
  | 'door'
  | 'camera'
  | 'lock'
  | 'search'
  | 'light'
  | 'walk'
  | 'wifi'
  | 'turn';

const STROKE = 1.8;

export function Icon({ name, color, size = 22 }: { name: IconName; color: string; size?: number }) {
  const bar = (width: number, rotate: number, dx = 0, dy = 0) => (
    <View
      style={{
        position: 'absolute',
        width,
        height: STROKE,
        borderRadius: STROKE,
        backgroundColor: color,
        transform: [{ translateX: dx }, { translateY: dy }, { rotate: `${rotate}deg` }],
      }}
    />
  );
  const ring = (d: number, dx = 0, dy = 0, radius = d / 2) => (
    <View
      style={{
        position: 'absolute',
        width: d,
        height: d,
        borderRadius: radius,
        borderWidth: STROKE,
        borderColor: color,
        transform: [{ translateX: dx }, { translateY: dy }],
      }}
    />
  );
  const dot = (d: number, dx = 0, dy = 0) => (
    <View
      style={{
        position: 'absolute',
        width: d,
        height: d,
        borderRadius: d / 2,
        backgroundColor: color,
        transform: [{ translateX: dx }, { translateY: dy }],
      }}
    />
  );
  /** Two sides of a square, turned: a chevron or a tick. */
  const corner = (w: number, h: number, rotate: number, dx = 0, dy = 0) => (
    <View
      style={{
        position: 'absolute',
        width: w,
        height: h,
        borderLeftWidth: STROKE,
        borderBottomWidth: STROKE,
        borderColor: color,
        transform: [{ translateX: dx }, { translateY: dy }, { rotate: `${rotate}deg` }],
      }}
    />
  );
  const s = size / 22;
  let body: React.ReactNode;
  switch (name) {
    case 'close':
      body = (
        <>
          {bar(18 * s, 45)}
          {bar(18 * s, -45)}
        </>
      );
      break;
    case 'back':
      body = corner(10 * s, 10 * s, 45, 2 * s);
      break;
    case 'forward':
      body = corner(10 * s, 10 * s, -135, -2 * s);
      break;
    case 'turn':
      body = (
        <>
          {ring(14 * s)}
          {corner(6 * s, 6 * s, 45, -7 * s, -3 * s)}
        </>
      );
      break;
    case 'more':
      body = (
        <>
          {dot(3.6 * s, -7 * s)}
          {dot(3.6 * s)}
          {dot(3.6 * s, 7 * s)}
        </>
      );
      break;
    case 'settings':
      body = (
        <>
          {bar(18 * s, 0, 0, -6 * s)}
          {bar(18 * s, 0)}
          {bar(18 * s, 0, 0, 6 * s)}
          {dot(5 * s, -4 * s, -6 * s)}
          {dot(5 * s, 4 * s)}
          {dot(5 * s, -2 * s, 6 * s)}
        </>
      );
      break;
    case 'info':
      body = (
        <>
          {ring(19 * s)}
          {bar(7 * s, 90, 0, 2.5 * s)}
          {dot(2.4 * s, 0, -5 * s)}
        </>
      );
      break;
    case 'check':
      body = corner(12 * s, 6 * s, -45, 0, -2 * s);
      break;
    case 'alert':
      body = (
        <>
          {ring(19 * s)}
          {bar(7 * s, 90, 0, -2.5 * s)}
          {dot(2.4 * s, 0, 5 * s)}
        </>
      );
      break;
    case 'door':
      body = (
        <>
          {ring(13 * s, 0, 0, 2 * s)}
          <View
            style={{
              position: 'absolute',
              width: 13 * s,
              height: 19 * s,
              borderRadius: 2 * s,
              borderWidth: STROKE,
              borderColor: color,
            }}
          />
          {dot(2.4 * s, 3 * s, 1 * s)}
        </>
      );
      break;
    case 'camera':
      body = (
        <>
          <View
            style={{
              position: 'absolute',
              width: 20 * s,
              height: 14 * s,
              borderRadius: 4 * s,
              borderWidth: STROKE,
              borderColor: color,
              transform: [{ translateY: 1 * s }],
            }}
          />
          {ring(7 * s, 0, 1 * s)}
        </>
      );
      break;
    case 'lock':
      body = (
        <>
          {ring(10 * s, 0, -4 * s)}
          <View
            style={{
              position: 'absolute',
              width: 15 * s,
              height: 11 * s,
              borderRadius: 3 * s,
              backgroundColor: color,
              transform: [{ translateY: 3.5 * s }],
            }}
          />
        </>
      );
      break;
    case 'search':
      body = (
        <>
          {ring(13 * s, -2 * s, -2 * s)}
          {bar(7 * s, 45, 6 * s, 6 * s)}
        </>
      );
      break;
    case 'light':
      body = (
        <>
          {ring(11 * s, 0, -2 * s)}
          {bar(6 * s, 0, 0, 6 * s)}
          {bar(4 * s, 0, 0, 9 * s)}
        </>
      );
      break;
    case 'walk':
      body = (
        <>
          {dot(4 * s, 0, -8 * s)}
          {bar(9 * s, 90, 0, -1 * s)}
          {bar(8 * s, 60, -2 * s, 6 * s)}
          {bar(8 * s, 120, 2 * s, 6 * s)}
        </>
      );
      break;
    case 'wifi':
      body = (
        <>
          {ring(18 * s, 0, 4 * s)}
          {ring(10 * s, 0, 4 * s)}
          {dot(3 * s, 0, 4 * s)}
        </>
      );
      break;
  }
  return (
    <View style={[styles.box, { width: size, height: size }]} pointerEvents="none">
      {body}
    </View>
  );
}

/** A letter in the weight of the icons, where a drawn shape would not read (plan labels). */
export function Glyph({ text, color, size = 15 }: { text: string; color: string; size?: number }) {
  return <Text style={{ color, fontSize: size, fontWeight: '700' }}>{text}</Text>;
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
});
