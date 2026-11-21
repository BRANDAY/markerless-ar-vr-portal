import { StyleSheet, View } from 'react-native';

import { t } from '../i18n';
import { appActions } from '../state/appStore';
import { Row, ScreenFrame } from './kit';
import { EventLog, StatusPanel } from './Overlay';

/**
 * Developer only: the status panel and the event log on a screen of their own, for
 * reading them without the camera behind (`docs/product/ui-spec.md`, 5.9).
 */
export function DiagnosticsScreen() {
  return (
    <ScreenFrame title="Diagnostics" onBack={() => appActions.back()}>
      <View style={styles.dark}>
        <StatusPanel />
        <EventLog tall />
      </View>
    </ScreenFrame>
  );
}

/**
 * Privacy and data: the statements of the camera permission screen. The third one
 * ("You can delete a room and its video at any time") is left out until the server can
 * delete a room (spec section 9, S1).
 */
export function PrivacyScreen() {
  return (
    <ScreenFrame title={t('settings.privacy')} onBack={() => appActions.back()}>
      <Row icon="camera" tone="teal" title={t('permission.line.video')} />
      <Row icon="lock" tone="teal" title={t('permission.line.network')} />
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  dark: { borderRadius: 14, padding: 8, gap: 8, backgroundColor: '#0C111A' },
});
