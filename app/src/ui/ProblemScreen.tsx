import { Linking } from 'react-native';

import { t, type TextKey } from '../i18n';
import { appActions, type ProblemKind } from '../state/appStore';
import { homeScreen, searchForServer } from './flows';
import { AppButton, Body, IconTile, Notice, ScreenFrame, Title } from './kit';
import { useServerView } from './ServerPanel';

/** Google's list of phones that can run ARCore. */
const SUPPORTED_PHONES_URL = 'https://developers.google.com/ar/devices';

/**
 * A problem that stops the user (`docs/product/ui-spec.md`, 7.1): what happened, and one
 * way forward. Problems that leave the camera usable are sheets on the AR screen instead.
 */
export function ProblemScreen({ kind }: { kind: ProblemKind }) {
  const serverName = useServerView().connection.info?.serverName ?? '';

  const back = () => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  };
  const search = () => {
    searchForServer();
    appActions.replace('connect');
  };

  let title: TextKey;
  let body: string;
  let tip: TextKey | null = null;
  let primary: { label: TextKey; onPress: () => void };
  let secondary: { label: TextKey; onPress: () => void } | null = null;
  switch (kind) {
    case 'camera':
      title = 'problem.camera.title';
      body = t('problem.camera.body');
      primary = { label: 'problem.camera.primary', onPress: () => void Linking.openSettings() };
      break;
    case 'device':
      title = 'problem.device.title';
      body = t('problem.device.body');
      primary = { label: 'problem.device.primary', onPress: () => void Linking.openURL(SUPPORTED_PHONES_URL) };
      break;
    case 'wifi':
      title = 'connect.wifi.title';
      body = t('connect.wifi.body');
      primary = { label: 'common.searchAgain', onPress: search };
      break;
    case 'version':
      title = 'connect.version.title';
      body = t('connect.version.body');
      primary = { label: 'common.searchAgain', onPress: search };
      break;
    case 'server':
      title = 'problem.server.title';
      body = serverName ? t('problem.server.body', { server: serverName }) : t('problem.server.body.unnamed');
      tip = 'problem.server.tip';
      primary = { label: 'common.searchAgain', onPress: search };
      secondary = { label: 'problem.server.secondary', onPress: () => appActions.replace('connect') };
      break;
  }

  return (
    <ScreenFrame
      onBack={back}
      title=""
      footer={
        <>
          <AppButton label={t(primary.label)} onPress={primary.onPress} />
          {secondary ? <AppButton kind="text" label={t(secondary.label)} onPress={secondary.onPress} /> : null}
        </>
      }
    >
      <IconTile icon="alert" tone="danger" size={56} />
      <Title>{t(title)}</Title>
      <Body dim>{body}</Body>
      {tip ? <Notice>{t(tip)}</Notice> : null}
    </ScreenFrame>
  );
}
