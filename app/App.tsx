import { isARSupportedOnDevice, ViroARSceneNavigator } from '@reactvision/react-viro';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  PermissionsAndroid,
  StyleSheet,
  View,
} from 'react-native';

import { PortalARScene } from './src/ar/PortalARScene';
import { measureController } from './src/measure/measureController';
import { roomsActions } from './src/room/roomsStore';
import { useRoomScan } from './src/room/roomStore';
import { deviceLogger } from './src/server/deviceLogger';
import { serverConnection } from './src/server/ServerConnection';
import { appActions, getAppState, type Screen, useAppState } from './src/state/appStore';
import { prefsActions, usePrefs } from './src/state/prefs';
import { ArScreen } from './src/ui/ArScreen';
import { startScreen } from './src/ui/core/modes';
import { BuildScreen } from './src/ui/BuildScreen';
import { ConnectScreen } from './src/ui/ConnectScreen';
import { homeScreen } from './src/ui/flows';
import { HomeScreen } from './src/ui/HomeScreen';
import { DiagnosticsScreen, PrivacyScreen } from './src/ui/MoreScreens';
import { Overlay } from './src/ui/Overlay';
import { PermissionScreen } from './src/ui/PermissionScreen';
import { ProblemScreen } from './src/ui/ProblemScreen';
import { ScanPrepareScreen } from './src/ui/ScanPrepareScreen';
import { ScanScreen } from './src/ui/ScanScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { VisitorScreen } from './src/ui/VisitorScreen';
import { WelcomeScreen } from './src/ui/WelcomeScreen';

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
  /** The first look at the permission has been taken: 'pending' now means "not given". */
  const [checked, setChecked] = useState(false);
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
        const granted = await PermissionsAndroid.check(CAMERA);
        setChecked(true);
        if (granted) {
          update('granted');
          return;
        }
        // The dialog is shown only when the user asked for it (the "Allow camera" button
        // of the permission screen); everything else only checks.
        if (!byUser) {
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

  return { permission, ask, checked };
}

/**
 * The screens that are drawn over the camera. Every other screen is a plain view. The
 * visitor screen counts once its welcome panel has been passed.
 */
function usesCamera(screen: Screen, visitorStarted: boolean): boolean {
  return screen === 'ar' || screen === 'scan' || (screen === 'visitor' && visitorStarted);
}

export default function App() {
  const { permission, ask, checked: permissionChecked } = useCameraPermission();
  const scanning = useRoomScan((state) => state.scanning);
  const wireframe = useRoomScan((state) => state.wireframe);
  const screen = useAppState((state) => state.screen);
  const visitorStarted = useAppState((state) => state.visitorStarted);
  const problem = useAppState((state) => state.problem);
  const history = useAppState((state) => state.history);
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
    // The first screen follows the mode: the visitor screen (also on a fresh install), or Home.
    void prefsActions.load((prefs) => appActions.resetTo(startScreen(prefs)));
    // Whether this phone can run AR at all. A failed query is no answer.
    isARSupportedOnDevice().then(
      (answer) => {
        appActions.setArSupported(answer.isARSupported);
        appActions.log(`AR supported on this phone: ${answer.isARSupported ? 'yes' : 'NO'}`);
      },
      (error) => appActions.log(`AR support query failed: ${String(error)}`),
    );
  }, []);

  // "The camera is off" goes away by itself once the permission has been given in the
  // phone's settings.
  useEffect(() => {
    if (permission === 'granted' && screen === 'problem' && problem === 'camera') {
      if (!appActions.back()) {
        appActions.resetTo(homeScreen());
      }
    }
  }, [permission, screen, problem]);

  // First launch: once the camera is allowed, the permission screen leads on to the server.
  useEffect(() => {
    if (permission === 'granted' && screen === 'permission') {
      prefsActions.set({ onboardingDone: true });
      appActions.resetTo('connect');
    }
  }, [permission, screen]);

  /** "Allow camera": Android's dialog, or the problem screen when Android no longer shows it. */
  const allowCamera = useCallback(() => {
    if (permission === 'blocked') {
      prefsActions.set({ onboardingDone: true });
      appActions.resetTo(homeScreen());
      appActions.showProblem('camera');
    } else {
      ask();
    }
  }, [permission, ask]);
  /** "Not now", and a refusal in the dialog. */
  const cameraRefused = useCallback(() => {
    prefsActions.set({ onboardingDone: true });
    appActions.resetTo(homeScreen());
    appActions.showProblem('camera');
  }, []);
  useEffect(() => {
    // A "no" in Android's dialog while the permission screen is up.
    if ((permission === 'denied' || permission === 'blocked') && (screen === 'permission' || usesCamera(screen, visitorStarted))) {
      cameraRefused();
    }
  }, [permission, screen, visitorStarted, cameraRefused]);

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
  const cameraScreen = usesCamera(screen, visitorStarted);
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

  let plain: React.ReactNode = null;
  switch (screen) {
    case 'welcome':
      plain = (
        <WelcomeScreen
          onDone={() => {
            // From Settings ("How it works") the cards lead back; on the first launch, on.
            if (!appActions.back()) {
              appActions.resetTo(permission === 'granted' ? 'connect' : 'permission');
              if (permission === 'granted') {
                prefsActions.set({ onboardingDone: true });
              }
            }
          }}
        />
      );
      break;
    case 'permission':
      plain = <PermissionScreen onAllow={allowCamera} onNotNow={cameraRefused} />;
      break;
    case 'home':
      plain = <HomeScreen />;
      break;
    case 'connect':
      plain = <ConnectScreen firstRun={history.length === 0} />;
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
    case 'visitor':
      // Drawn below, over the camera: the visitor screen brings its own welcome panel.
      break;
    case 'scanPrepare':
      plain = <ScanPrepareScreen />;
      break;
    case 'build':
      plain = <BuildScreen />;
      break;
    case 'ar':
    case 'scan':
      // The AR view is mounted only once the camera permission is granted: starting an
      // ARCore session without it is a known source of a black camera image.
      if (permission !== 'granted') {
        plain = <PermissionScreen onAllow={allowCamera} onNotNow={cameraRefused} />;
      }
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
          // The guided scan shows the engine's mesh lines: they are the feedback where no
          // wall planes are found (`ui-spec.md`, 3.4). In the developer tools it is a button.
          worldMeshConfig={{ accumulate: true, debugDrawEnabled: wireframe || (screen === 'scan' && scanning) }}
        />
      ) : null}
      {screen === 'ar' ? (
        <>
          <ArScreen />
          <Overlay />
        </>
      ) : null}
      {screen === 'scan' && permission === 'granted' ? <ScanScreen /> : null}
      {screen === 'visitor' ? <VisitorScreen permission={permission} permissionChecked={permissionChecked} onAllow={ask} /> : null}
      {plain ? <View style={styles.cover}>{plain}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  // Other screens cover the AR view when it is kept mounted.
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
