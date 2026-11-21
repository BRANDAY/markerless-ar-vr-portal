import { t } from '../i18n';
import { AppButton, Body, IconTile, Row, ScreenFrame, Title } from './kit';

/**
 * Camera permission (`docs/product/ui-spec.md`, 5.2): why the camera is needed and what
 * happens to the video, before Android's own dialog. The line about deleting a room is
 * left out until the server can delete one (spec section 9, S1).
 */
export function PermissionScreen({ onAllow, onNotNow }: { onAllow: () => void; onNotNow: () => void }) {
  return (
    <ScreenFrame
      footer={
        <>
          <AppButton label={t('permission.allow')} onPress={onAllow} />
          <AppButton kind="text" label={t('common.notNow')} onPress={onNotNow} />
        </>
      }
    >
      <IconTile icon="camera" tone="amber" size={56} />
      <Title>{t('permission.title')}</Title>
      <Body dim>{t('permission.body')}</Body>
      <Row long icon="camera" tone="teal" title={t('permission.line.video')} />
      <Row long icon="lock" tone="teal" title={t('permission.line.network')} />
    </ScreenFrame>
  );
}
