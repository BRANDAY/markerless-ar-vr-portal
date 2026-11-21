import { ViroARSceneNavigator } from '@reactvision/react-viro';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Linking,
  PermissionsAndroid,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { PortalARScene } from './src/ar/PortalARScene';
import { BRAND } from './src/brand';
import { measureController } from './src/measure/measureController';
import { roomsActions } from './src/room/roomsStore';
import { useRoomScan } from './src/room/roomStore';
import { deviceLogger } from './src/server/deviceLogger';
import { serverConnection } from './src/server/ServerConnection';
import { appActions, getAppState, type Screen, useAppState } from './src/state/appStore';
import { prefsActions, usePrefs } from './src/state/prefs';
import { ArScreen } from './src/ui/ArScreen';
import { ConnectScreen } from './src/ui/ConnectScreen';
import { homeScreen } from './src/ui/flows';
import { HomeScreen } from './src/ui/HomeScreen';
import { DiagnosticsScreen, PrivacyScreen } from './src/ui/MoreScreens';
import { Overlay } from './src/ui/Overlay';
import { ProblemScreen } from './src/ui/ProblemScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';

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

/** The screens that are drawn over the camera. Every other screen is a plain view. */
function usesCamera(screen: Screen): boolean {
  return screen === 'ar' || screen === 'scan';
}

export default function App() {
  const { permission, ask } = useCameraPermission();
  const scanning = useRoomScan((state) => state.scanning);
  const wireframe = useRoomScan((state) => state.wireframe);
  const screen = useAppState((state) => state.screen);
  const problem = useAppState((state) => state.problem);
  const prefsLoaded = usePrefs((state) => state.loaded);
  const keepArView = usePrefs((state) => state.keepArView);

  // Independent of the camera permission and of the AR session: try the saved server
  // address and keep the heartbeat running while the app is in the foreground.
  // The device's identity is loaded first, so that every request to the server carries it.
  useEffect(() => {
    void deviceLogger.start(appActions.log).then(() => serverConnection.start(appActions.log));
    roomsActions.start();
    // The test condition chosen in the previous run (a restart is one of the tests).
    void measureController.start();
    void prefsActions.load();
  }, []);

  // Android's back button (`ui-spec.md`, 4.1). Sheets and menus register their own
  // handlers, which run before this one.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const current = getAppState().screen;
      if (current === 'home' || current === 'visitor') {
        return false; // leaves the app
      }
      if (current === 'ar' || current === 'build') {
        appActions.resetTo(homeScreen());
        return true;
      }
      if (!appActions.back()) {
        appActions.resetTo(homeScreen());
      }
      return true;
    });
    return () => subscription.remove();
  }, []);

  // The developer tools belong to the AR screen: leaving it closes them.
  useEffect(() => {
    if (screen !== 'ar') {
      appActions.setOverlayVisible(false);
    }
  }, [screen]);

  // The AR view is mounted for the screens over the camera only. Mounting it anew starts
  // a new AR session; with the developer option "Keep the AR view running" it stays
  // mounted, covered by the other screens, once it has been shown.
  const cameraScreen = usesCamera(screen);
  const [arShown, setArShown] = useState(false);
  useEffect(() => {
    if (cameraScreen) {
      setArShown(true);
    }
  }, [cameraScreen]);
  const arMounted = permission === 'granted' && (cameraScreen || (keepArView && arShown));

  if (!prefsLoaded) {
    return <View style={styles.root} />;
  }

  // The AR view is mounted only once the camera permission is granted: starting an
  // ARCore session without it is a known source of a black camera image.
  if (cameraScreen && permission !== 'granted') {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <Text style={styles.title}>{BRAND.name}</Text>
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

  let plain: React.ReactNode = null;
  switch (screen) {
    case 'home':
      plain = <HomeScreen />;
      break;
    case 'connect':
      plain = <ConnectScreen firstRun={false} />;
      break;
    case 'settings':
      plain = <SettingsScreen />;
      break;
    case 'diagnostics':
      plain = <DiagnosticsScreen />;
      break;
    case 'privacy':
      plain = <PrivacyScreen />;
      break;
    case 'problem':
      plain = <ProblemScreen kind={problem ?? 'server'} />;
      break;
    case 'ar':
    case 'scan':
      break;
    default:
      // A screen of a later step of the interface work: Home stands in for it.
      plain = <HomeScreen />;
  }

  return (
    <View style={styles.root}>
      <StatusBar style={cameraScreen ? 'light' : 'auto'} />
      {arMounted ? (
        <ViroARSceneNavigator
          style={styles.root}
          autofocus={true}
          // The scene receives `arSceneNavigator` from the navigator; ViroReact types the
          // scene as a prop-less function, hence the cast.
          initialScene={{ scene: PortalARScene as unknown as () => React.JSX.Element }}
          // Room scan: the AR engine fuses its depth images into a mesh of the room.
          worldMeshEnabled={scanning}
          worldMeshConfig={{ accumulate: true, debugDrawEnabled: wireframe }}
        />
      ) : null}
      {screen === 'ar' ? (
        <>
          <ArScreen />
          <Overlay />
        </>
      ) : null}
      {plain ? <View style={styles.cover}>{plain}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  // Other screens cover the AR view when it is kept mounted.
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
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
