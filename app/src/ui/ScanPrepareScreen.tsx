import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { t } from '../i18n';
import { useRoomScan } from '../room/roomStore';
import { appActions } from '../state/appStore';
import { homeScreen, startScanning } from './flows';
import { AppButton, Notice, Row, ScreenFrame, Small, Title } from './kit';
import { RADIUS, TYPE, useTheme } from './theme';

/**
 * Before you scan (`docs/product/ui-spec.md`, 5.5): what makes a scan work, how long it
 * takes, and the name of a new room.
 */
export function ScanPrepareScreen() {
  const theme = useTheme();
  const target = useRoomScan((s) => s.scanTarget);
  const [name, setName] = useState(target?.label ?? '');
  const isNew = target !== null && !target.replace;

  const back = () => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  };

  return (
    <ScreenFrame
      title={t('scanPrepare.bar')}
      onBack={back}
      footer={<AppButton label={t('scanPrepare.start')} onPress={() => startScanning(name)} />}
    >
      <Title>{t('scanPrepare.title')}</Title>
      <View>
        <Row icon="light" tone="teal" title={t('scanPrepare.lights.title')} sub={t('scanPrepare.lights.body')} />
        <Row icon="door" tone="teal" title={t('scanPrepare.doorway.title')} sub={t('scanPrepare.doorway.body')} />
        <Row icon="walk" tone="teal" title={t('scanPrepare.path.title')} sub={t('scanPrepare.path.body')} />
      </View>
      <Notice>{t('scanPrepare.notice')}</Notice>
      {isNew ? (
        <View style={styles.field}>
          <Small>{t('scanPrepare.name.label')}</Small>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={target?.label ?? ''}
            placeholderTextColor={theme.ink2}
            maxLength={40}
            autoCorrect={false}
            style={[TYPE.body, styles.input, { color: theme.ink, borderColor: theme.line, backgroundColor: theme.surface }]}
          />
        </View>
      ) : null}
      <Small>{`${t('scanPrepare.host')} ${t('permission.line.video')}`}</Small>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  input: { height: 52, borderWidth: 1, borderRadius: RADIUS.button, paddingHorizontal: 14 },
});
