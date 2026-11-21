import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { photoCamera } from '../ar/photoCamera';
import { t } from '../i18n';
import { appActions } from '../state/appStore';
import { PHOTO_PREVIEW_MS } from './core/photo';
import { HUD, TYPE } from './theme';

/** The shutter is the one large control over the camera (`ui-spec.md`, 3: "shutter 68"). */
const SHUTTER = 68;
const PREVIEW_WIDTH = 92;
const PREVIEW_HEIGHT = 164;

type Shown = { kind: 'photo'; uri: string; inGallery: boolean } | { kind: 'failed' } | null;

/**
 * The shutter and what follows a photo (`docs/product/ui-spec.md`, 5.9): the picture of
 * the view without the interface, then a small preview for 4 seconds.
 *
 * The spec's **Share** on the preview is not offered: handing a picture file to another
 * app needs a native module this build does not have (React Native's own share sheet
 * takes text only on Android). The preview says where the picture went instead.
 */
export function Shutter() {
  const [shown, setShown] = useState<Shown>(null);
  const [taking, setTaking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);

  useEffect(
    () => () => {
      live.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const take = useCallback(async () => {
    if (taking) {
      return;
    }
    setTaking(true);
    const result = await photoCamera.take(appActions.log);
    if (!live.current) {
      return;
    }
    setTaking(false);
    setShown(result.ok ? { kind: 'photo', uri: result.uri, inGallery: result.inGallery } : { kind: 'failed' });
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      if (live.current) {
        setShown(null);
      }
    }, PHOTO_PREVIEW_MS);
  }, [taking]);

  return (
    <View style={styles.row} pointerEvents="box-none">
      <View style={styles.side} pointerEvents="none">
        {shown?.kind === 'photo' ? (
          <View style={styles.preview}>
            <Image source={{ uri: shown.uri }} style={styles.image} resizeMode="cover" />
            <Text style={[TYPE.small, styles.caption]} numberOfLines={2}>
              {t(shown.inGallery ? 'photo.saved' : 'photo.taken')}
            </Text>
          </View>
        ) : null}
        {shown?.kind === 'failed' ? (
          <View style={styles.note}>
            <Text style={[TYPE.small, styles.caption]}>{t('photo.failed')}</Text>
          </View>
        ) : null}
      </View>
      <Pressable
        onPress={() => void take()}
        disabled={taking}
        accessibilityRole="button"
        accessibilityLabel={t('photo.take')}
        style={({ pressed }) => [styles.shutter, pressed || taking ? styles.pressed : null]}
      >
        <View style={styles.shutterCore} />
      </Pressable>
      <View style={styles.side} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 14 },
  side: { flex: 1, alignItems: 'flex-end' },
  shutter: {
    width: SHUTTER,
    height: SHUTTER,
    borderRadius: SHUTTER / 2,
    borderWidth: 3,
    borderColor: HUD.fg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: HUD.bg,
  },
  shutterCore: { width: SHUTTER - 16, height: SHUTTER - 16, borderRadius: (SHUTTER - 16) / 2, backgroundColor: HUD.fg },
  pressed: { opacity: 0.6 },
  preview: {
    width: PREVIEW_WIDTH,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: HUD.bg,
    borderWidth: 1,
    borderColor: HUD.line,
  },
  image: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
  note: { borderRadius: 12, paddingVertical: 4, backgroundColor: HUD.bg, borderWidth: 1, borderColor: HUD.line },
  caption: { color: HUD.fg, paddingHorizontal: 8, paddingVertical: 5 },
});
