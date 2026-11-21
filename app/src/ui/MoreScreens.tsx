import { StyleSheet, View } from 'react-native';

import { t } from '../i18n';
import { DOOR_CREDITS, SOFTWARE_NOTICES, SPACE_CREDITS, type WorkCredit } from '../spaces/credits';
import { appActions } from '../state/appStore';
import { Body, Card, Eyebrow, Row, ScreenFrame, Small } from './kit';
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
      <Row long icon="camera" tone="teal" title={t('permission.line.video')} />
      <Row long icon="lock" tone="teal" title={t('permission.line.network')} />
    </ScreenFrame>
  );
}

/** One work of somebody else: what it is used for, its name, its author, its licence and source. */
function Work({ work }: { work: WorkCredit }) {
  return (
    <Card>
      <Small>{t(work.use)}</Small>
      <Body>{work.title}</Body>
      <Small>{work.by}</Small>
      <Small>{t('credits.licence', { licence: work.licence })}</Small>
      <Small>{t('credits.source', { source: work.source })}</Small>
      {work.changes ? <Small>{t(work.changes)}</Small> : null}
    </Card>
  );
}

/**
 * Credits and licences (`docs/product/ui-spec.md`, 5.12): the spaces (model, author,
 * licence), the door, and the software the app is built with. The facts are in
 * `spaces/credits.ts`.
 */
export function CreditsScreen() {
  return (
    <ScreenFrame title={t('settings.credits')} onBack={() => appActions.back()}>
      <Eyebrow>{t('spaces.title')}</Eyebrow>
      {SPACE_CREDITS.map((work) => (
        <Work key={work.title} work={work} />
      ))}
      <Eyebrow>{t('credits.door')}</Eyebrow>
      <Body dim>{t('credits.door.made')}</Body>
      {DOOR_CREDITS.map((work) => (
        <Work key={work.title} work={work} />
      ))}
      <Eyebrow>{t('credits.software')}</Eyebrow>
      <Body dim>{t('credits.software.note')}</Body>
      {SOFTWARE_NOTICES.map((item) => (
        <Row key={item.name} title={`${item.name} ${item.version}`.trim()} sub={item.by} value={item.licence} />
      ))}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  dark: { borderRadius: 14, padding: 8, gap: 8, backgroundColor: '#0C111A' },
});
