import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { t, type TextKey } from '../i18n';
import { filtersShown, listedSpaces, type SpaceFilter } from '../spaces/core/choice';
import { SPACE_PICTURE } from '../spaces/pictures';
import { putBehindDoor } from '../spaces/spaceChoice';
import { type SpaceInfo, SPACES } from '../spaces/spaces';
import { appActions, useAppState } from '../state/appStore';
import { usePrefs } from '../state/prefs';
import { homeScreen } from './flows';
import { AppButton, Body, Card, Eyebrow, IconTile, Notice, ScreenFrame, Sheet, SheetTitle, Small, Tag } from './kit';
import { RADIUS, TYPE, useTheme } from './theme';

const FILTERS: readonly { id: SpaceFilter; label: TextKey }[] = [
  { id: 'all', label: 'spaces.filter.all' },
  { id: 'heritage', label: 'spaces.filter.heritage' },
  { id: '360', label: 'spaces.filter.360' },
];

/** "{place} · walk-in 3D · {size} MB"; the test room is no place and has no files. */
function cardLine(space: SpaceInfo): string {
  if (!space.place) {
    return 'Developer only · built from plain shapes';
  }
  return t(space.kind === '360' ? 'spaces.line.360' : 'spaces.line.walkIn', { place: t(space.place), size: space.megabytes });
}

/**
 * Spaces (`docs/product/ui-spec.md`, 5.10): what can stand behind the door, and which one
 * does for this room. Every space is part of the app, so each is "On this phone"; there
 * is nothing to download yet (spec section 9, S7). The choice is kept per room, on this
 * phone (`spaces/spaceChoice.ts`).
 */
export function SpacesScreen() {
  const theme = useTheme();
  const developer = usePrefs((s) => s.developerOptions);
  // What the door shows now: the space chosen for the room.
  const behind = useAppState((s) => s.environment);
  const [filter, setFilter] = useState<SpaceFilter>('all');
  const [open, setOpen] = useState<SpaceInfo | null>(null);

  const chips = filtersShown(SPACES, developer);
  const spaces = listedSpaces(SPACES, developer, chips ? filter : 'all');

  const leave = () => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  };
  const put = (space: SpaceInfo) => {
    putBehindDoor(space.id);
    setOpen(null);
    leave(); // back to the door, or to Home: where the new space is seen
  };

  const picture = (space: SpaceInfo, height: number) => {
    const source = SPACE_PICTURE[space.id];
    return source ? (
      <Image source={source} style={[styles.picture, { height }]} resizeMode="cover" accessibilityIgnoresInvertColors />
    ) : (
      <View style={[styles.picture, styles.noPicture, { height, backgroundColor: theme.surface2 }]}>
        <IconTile icon="door" />
      </View>
    );
  };

  return (
    <>
      <ScreenFrame title={t('spaces.title')} onBack={leave}>
        {chips ? (
          <View style={styles.chips}>
            {FILTERS.map((item) => {
              const on = item.id === filter;
              return (
                <Pressable
                  key={item.id}
                  onPress={() => setFilter(item.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.chip, { borderColor: on ? theme.teal : theme.line, backgroundColor: on ? theme.tealSoft : 'transparent' }]}
                >
                  <Text style={[TYPE.small, { color: on ? theme.teal : theme.ink, fontWeight: '600' }]}>{t(item.label)}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {spaces.map((space) => (
          <Pressable key={space.id} onPress={() => setOpen(space)} accessibilityRole="button" style={({ pressed }) => (pressed ? styles.pressed : null)}>
            <Card>
              {picture(space, 132)}
              <Text style={[TYPE.cardTitle, { color: theme.ink }]}>{t(space.name)}</Text>
              <Small>{cardLine(space)}</Small>
              {space.id === behind ? <Tag label={t('spaces.tag.behind')} /> : <Tag label={t('spaces.tag.onPhone')} tone="neutral" />}
            </Card>
          </Pressable>
        ))}

        <Notice>{t('spaces.notice')}</Notice>
      </ScreenFrame>

      {open ? (
        <Sheet onClose={() => setOpen(null)}>
          {picture(open, 150)}
          {open.place ? <Eyebrow>{[t(open.place), open.date ? t(open.date) : ''].filter(Boolean).join(' · ')}</Eyebrow> : null}
          <SheetTitle>{t(open.name)}</SheetTitle>
          {open.summary ? <Body dim>{t(open.summary)}</Body> : null}
          {open.credit ? <Small>{t('spaces.sheet.line', { size: open.megabytes, credit: t(open.credit) })}</Small> : <Small>{cardLine(open)}</Small>}
          {open.id === behind ? <Tag label={t('spaces.tag.behind')} /> : <AppButton label={t('spaces.put')} onPress={() => put(open)} />}
          <AppButton kind="text" label={t('common.close')} onPress={() => setOpen(null)} />
        </Sheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { height: 36, paddingHorizontal: 14, borderRadius: RADIUS.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  picture: { width: '100%', borderRadius: 12 },
  noPicture: { alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.85 },
});
