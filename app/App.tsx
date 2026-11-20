import { ViroARSceneNavigator } from '@reactvision/react-viro';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Linking,
  PermissionsAndroid,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { PortalARScene } from './src/ar/PortalARScene';
import { appActions } from './src/state/appStore';
import { Overlay } from './src/ui/Overlay';

/**
 * 'pending'  - the user has not answered the system dialog yet (it may not even have been shown);
 * 'denied'   - the user answered "no"; ask again only when they press the button;
 * 'blocked'  - "don't ask again": only the system settings can grant it now.
 */
type CameraPermission = 'pending' | 'granted' | 'denied' | 'blocked';

const CAMERA = PermissionsAndroid.PERMISSIONS.CAMERA;
const RETRY_DELAY_MS = 1000;
const MAX_TIMED_RETRIES = 10;

/**
 * Camera permission that survives a start without a foreground Activity.
 *
 * `PermissionsAndroid.request` throws "Tried to use permissions API while not attached to
 * an Activity" when the app is started while the screen is locked (or otherwise before the
 * Activity is resumed). So the dialog is only requested while the app is `active`, a failed
 * attempt is retried after a short delay, and everything is re-evaluated whenever the app
 * becomes active again (which also picks up a permission granted in the system settings).
 */
function useCameraPermission() {
  const [permission, setPermission] = useState<CameraPermission>('pending');
  const permissionRef = useRef<CameraPermission>('pending');
  const busyRef = useRef(false);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = useCallback((next: CameraPermission) => {
    permissionRef.current = next;
    setPermission(next);
  }, []);

  /** `byUser`: the button was pressed, so showing the dialog again is wanted. */
  const evaluate = useCallback(
    async (byUser: boolean) => {
      if (busyRef.current || permissionRef.current === 'granted') {
        return;
      }
      busyRef.current = true;
      let retry = false;
      try {
        // `check` works without an Activity; `request` does not.
        if (await PermissionsAndroid.check(CAMERA)) {
          update('granted');
          return;
        }
        // Show the dialog automatically only once: closing it makes the app `active`
        // again, and asking on every `active` would loop for a user who said no.
        if (!byUser && permissionRef.current !== 'pending') {
          return;
        }
        if (AppState.currentState !== 'active') {
          return; // the AppState listener calls us again when the app comes to the front
        }
        const result = await PermissionsAndroid.request(CAMERA);
        if (result === PermissionsAndroid.RESULTS.GRANTED) {
          update('granted');
        } else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          update('blocked');
        } else {
          update('denied');
        }
      } catch (error) {
        // Not attached to an Activity yet: keep the current state and try again shortly.
        appActions.log(`camera permission not available yet: ${String(error)}`);
        retry = true;
      } finally {
        busyRef.current = false;
      }
      if (retry && retriesRef.current < MAX_TIMED_RETRIES && !retryTimerRef.current) {
        retriesRef.current += 1;
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          evaluate(byUser);
        }, RETRY_DELAY_MS);
      }
    },
    [update],
  );

  useEffect(() => {
    evaluate(false);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        retriesRef.current = 0;
        evaluate(false);
      }
    });
    return () => {
      subscription.remove();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [evaluate]);

  const ask = useCallback(() => {
    retriesRef.current = 0;
    evaluate(true);
  }, [evaluate]);

  return { permission, ask };
}

export default function App() {
  const { permission, ask } = useCameraPermission();

  // The AR view is mounted only once the camera permission is granted: starting an
  // ARCore session without it is a known source of a black camera image.
  if (permission !== 'granted') {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <Text style={styles.title}>FESB AR Portal</Text>
        <Text style={styles.text}>
          {permission === 'pending'
            ? 'Waiting for camera access...'
            : permission === 'blocked'
              ? 'The camera permission is required for AR and has been blocked. Enable it in the system settings of the app.'
              : 'The camera permission is required for AR.'}
        </Text>
        {permission === 'blocked' ? (
          <Pressable style={styles.button} onPress={() => Linking.openSettings()}>
            <Text style={styles.buttonText}>Open app settings</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.button} onPress={ask}>
            <Text style={styles.buttonText}>Grant camera access</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ViroARSceneNavigator
        style={styles.root}
        autofocus={true}
        // The scene receives `arSceneNavigator` from the navigator; ViroReact types the
        // scene as a prop-less function, hence the cast.
        initialScene={{ scene: PortalARScene as unknown as () => React.JSX.Element }}
      />
      <Overlay />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: '#101018',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 12 },
  text: { color: '#c8c8d8', fontSize: 15, textAlign: 'center', lineHeight: 21 },
  button: {
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#2d6cdf',
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
