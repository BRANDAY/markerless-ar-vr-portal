import { ViroARSceneNavigator } from '@reactvision/react-viro';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { PermissionsAndroid, Pressable, StyleSheet, Text, View } from 'react-native';

import { PortalARScene } from './src/ar/PortalARScene';
import { appActions } from './src/state/appStore';
import { Overlay } from './src/ui/Overlay';

type CameraPermission = 'checking' | 'granted' | 'denied';

export default function App() {
  const [permission, setPermission] = useState<CameraPermission>('checking');

  const requestCamera = useCallback(async () => {
    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
      setPermission(result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied');
    } catch (error) {
      appActions.log(`camera permission error: ${String(error)}`);
      setPermission('denied');
    }
  }, []);

  useEffect(() => {
    requestCamera();
  }, [requestCamera]);

  // The AR view is mounted only once the camera permission is granted: starting an
  // ARCore session without it is a known source of a black camera image.
  if (permission !== 'granted') {
    return (
      <View style={styles.center}>
        <StatusBar style="light" />
        <Text style={styles.title}>FESB AR Portal</Text>
        <Text style={styles.text}>
          {permission === 'checking'
            ? 'Asking for camera access...'
            : 'The camera permission is required for AR. Grant it here or in the system settings of the app.'}
        </Text>
        {permission === 'denied' ? (
          <Pressable style={styles.button} onPress={requestCamera}>
            <Text style={styles.buttonText}>Grant camera access</Text>
          </Pressable>
        ) : null}
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
