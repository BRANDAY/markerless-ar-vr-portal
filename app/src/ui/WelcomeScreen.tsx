import { type ComponentRef, useRef, useState } from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { t, type TextKey } from '../i18n';
import type { IconName } from './icons';
import { AppButton, Body, IconTile, ScreenFrame, Title } from './kit';
import { SPACE, useTheme } from './theme';

const CARDS: { icon: IconName; title: TextKey; body: TextKey }[] = [
  { icon: 'door', title: 'welcome.1.title', body: 'welcome.1.body' },
  { icon: 'walk', title: 'welcome.2.title', body: 'welcome.2.body' },
  { icon: 'check', title: 'welcome.3.title', body: 'welcome.3.body' },
];

/**
 * The three welcome cards (`docs/product/ui-spec.md`, 5.1): swipe or "Continue". Shown on
 * the first launch, and again from Settings ("How it works").
 */
export function WelcomeScreen({ onDone }: { onDone: () => void }) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [index, setIndex] = useState(0);
  const last = index === CARDS.length - 1;

  const onScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setIndex(Math.max(0, Math.min(CARDS.length - 1, Math.round(event.nativeEvent.contentOffset.x / width))));
  };
  const next = () => {
    if (last) {
      onDone();
      return;
    }
    scroll.current?.scrollTo({ x: (index + 1) * width, animated: true });
    setIndex(index + 1);
  };

  return (
    <ScreenFrame
      plain
      footer={
        <>
          <View style={styles.dots}>
            {CARDS.map((card, i) => (
              <View key={card.title} style={[styles.dot, { backgroundColor: i === index ? theme.amber : theme.line }]} />
            ))}
          </View>
          <AppButton label={t(last ? 'welcome.getStarted' : 'common.continue')} onPress={next} />
          <AppButton kind="text" label={t('common.skip')} onPress={onDone} />
        </>
      }
    >
      <ScrollView
        ref={scroll}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        style={styles.pager}
      >
        {CARDS.map((card) => (
          <View key={card.title} style={[styles.card, { width }]}>
            <IconTile icon={card.icon} tone="amber" size={96} />
            <Title>{t(card.title)}</Title>
            <Body dim>{t(card.body)}</Body>
          </View>
        ))}
      </ScrollView>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  pager: { flex: 1 },
  card: { paddingHorizontal: SPACE.screen, justifyContent: 'center', gap: 16 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
