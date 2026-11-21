import { Pressable, StyleSheet, Text, View } from 'react-native';

import { availableLanguages, getLanguage } from '../i18n';
import { LANGUAGE_NAMES } from '../i18n/languages';
import { chooseLanguage } from '../state/language';
import { RADIUS, TYPE, useTheme } from './theme';

/**
 * One chip per language the app has, each under its own name (`ui-spec.md`, 5.13: at the
 * bottom of the visitor's welcome panel, "once more than one language exists").
 */
export function LanguageChips() {
  const theme = useTheme();
  const languages = availableLanguages().filter((code) => LANGUAGE_NAMES[code]);
  if (languages.length < 2) {
    return null;
  }
  const current = getLanguage();
  return (
    <View style={styles.row}>
      {languages.map((code) => {
        const on = code === current;
        return (
          <Pressable
            key={code}
            onPress={() => chooseLanguage(code)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            hitSlop={4}
            style={[styles.chip, { borderColor: on ? theme.teal : theme.line, backgroundColor: on ? theme.tealSoft : 'transparent' }]}
          >
            <Text style={[TYPE.small, { color: on ? theme.teal : theme.ink, fontWeight: '600' }]}>{LANGUAGE_NAMES[code]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, paddingTop: 6 },
  chip: { height: 36, paddingHorizontal: 14, borderRadius: RADIUS.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
