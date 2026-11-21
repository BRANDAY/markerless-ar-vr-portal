import { BackHandler, StyleSheet, Text, View, Pressable } from 'react-native';

import { t } from '../i18n';
import { appActions, useAppState } from '../state/appStore';
import { prefsActions, usePrefs } from '../state/prefs';
import { HudButton, useSevenTaps } from './kit';
import { HUD, TYPE, useInsets } from './theme';

/**
 * What the user sees over the camera (`docs/product/ui-spec.md`, 5.9). Almost nothing:
 * a close button, and - with developer options on - a button that opens the developer
 * tools (`Overlay.tsx`).
 */
export function ArScreen() {
  const insets = useInsets();
  const developer = usePrefs((s) => s.developerOptions);
  const toolsOpen = useAppState((s) => s.overlayVisible);

  // Until the settings screen exists, seven taps in the top right corner switch the
  // developer options on and off.
  const onSecretTap = useSevenTaps(() => {
    const next = !developer;
    prefsActions.set({ developerOptions: next });
    appActions.log(`developer options ${next ? 'on' : 'off'}`);
  });

  if (developer && toolsOpen) {
    return null; // the developer tools take the whole screen
  }
  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        <HudButton icon="close" label={t('common.close')} onPress={() => BackHandler.exitApp()} />
        <Pressable style={styles.secret} onPress={onSecretTap} accessibilityElementsHidden />
      </View>
      <View style={styles.spacer} pointerEvents="none" />
      {developer ? (
        <Pressable style={styles.tools} onPress={appActions.toggleOverlay} accessibilityRole="button">
          <Text style={[TYPE.mono, styles.toolsText]}>Tools</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  secret: { width: 44, height: 44 },
  spacer: { flex: 1 },
  tools: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  toolsText: { color: HUD.fg },
});
