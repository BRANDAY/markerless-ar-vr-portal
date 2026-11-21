import { StyleSheet, Text, View } from 'react-native';

import type { ServerRoom } from '../server/core/roomPlan';
import { planLayout, type Segment, segmentBar } from './core/planLayout';
import { Icon } from './icons';
import { TYPE, useTheme } from './theme';

/**
 * The room seen from above (`docs/product/ui-spec.md`, 5.4 and 5.8): walls as teal lines
 * on a soft teal field, corners as dots, the doorway in use as a thick amber segment,
 * other doorways grey. Drawn with rotated thin views: no drawing module is in the build.
 * Without a plan, a door icon.
 */
export function PlanDrawing(props: {
  room: ServerRoom | null;
  /** Position of the doorway in use, in the plan's frame. */
  chosenAt: readonly number[] | null;
  width: number;
  height: number;
  /** Letters on the doorways, wall lengths and a one-metre bar (the room result screen). */
  detailed?: boolean;
  /** Mark this doorway as the chosen one instead of the one nearest to `chosenAt`. */
  chosenId?: string | null;
}) {
  const theme = useTheme();
  const layout = props.room && props.room.status !== 'unavailable' ? planLayout(props.room, props.width, props.height, props.chosenAt) : null;
  const box = { width: props.width, height: props.height, backgroundColor: theme.tealSoft };
  if (!layout) {
    return (
      <View style={[styles.box, styles.empty, box, { backgroundColor: theme.surface2 }]}>
        <Icon name="door" color={theme.ink2} size={40} />
      </View>
    );
  }
  const line = (segment: Segment, color: string, thickness: number, key: string) => {
    const bar = segmentBar(segment);
    return (
      <View
        key={key}
        style={{
          position: 'absolute',
          left: bar.cx - bar.length / 2,
          top: bar.cy - thickness / 2,
          width: bar.length,
          height: thickness,
          borderRadius: thickness / 2,
          backgroundColor: color,
          transform: [{ rotate: `${bar.angleDeg}deg` }],
        }}
      />
    );
  };
  const isChosen = (id: string, nearest: boolean) => (props.chosenId !== undefined ? props.chosenId === id : nearest);
  return (
    <View style={[styles.box, box]}>
      {layout.walls.map((wall) => line(wall, theme.teal, 3, wall.id))}
      {layout.corners.map((corner, index) => (
        <View key={`c${index}`} style={[styles.corner, { left: corner.x - 4, top: corner.y - 4, backgroundColor: theme.teal }]} />
      ))}
      {layout.openings.map((opening) =>
        line(opening, isChosen(opening.id, opening.chosen) ? theme.amber : theme.ink2, 7, opening.id),
      )}
      {props.detailed
        ? layout.walls.map((wall) => {
            const bar = segmentBar(wall);
            return (
              <Text key={`l${wall.id}`} style={[TYPE.small, styles.label, { left: bar.cx - 22, top: bar.cy - 9, color: theme.ink2, backgroundColor: theme.tealSoft }]}>
                {wall.lengthM.toFixed(1)} m
              </Text>
            );
          })
        : null}
      {props.detailed
        ? layout.openings.map((opening) => (
            <View
              key={`o${opening.id}`}
              style={[
                styles.letter,
                {
                  left: opening.middle.x - 11,
                  top: opening.middle.y - 11,
                  backgroundColor: isChosen(opening.id, opening.chosen) ? theme.amber : theme.surface,
                  borderColor: theme.line,
                },
              ]}
            >
              <Text style={[TYPE.small, { color: theme.amberInk, fontWeight: '700' }]}>{opening.letter}</Text>
            </View>
          ))
        : null}
      {props.detailed ? (
        <View style={styles.scale}>
          <View style={{ width: layout.metreBar, height: 3, backgroundColor: theme.ink2, borderRadius: 2 }} />
          <Text style={[TYPE.small, { color: theme.ink2 }]}>1 m</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 14, overflow: 'hidden' },
  empty: { alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  label: { position: 'absolute', width: 44, textAlign: 'center', fontSize: 11 },
  letter: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scale: { position: 'absolute', left: 8, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 6 },
});
