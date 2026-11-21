import { useCallback, useEffect } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';

import { t } from '../i18n';
import { BRIDGE } from '../localization/core/ways';
import { finishBridgeMeasure, startBridgeMeasure, stopBridgeMeasure, useBridge } from '../room/bridgeMeasure';
import { roomName as nameOfRoom, vpsOfRoom } from '../room/roomsStore';
import { appActions, useAppState } from '../state/appStore';
import { AppButton, Body, CoachCard, HudButton, HudPill, Sheet, SheetTitle, Small } from './kit';
import { useInsets } from './theme';

/**
 * "Link to the room": the staff member walks through the room once while the phone finds
 * it both ways - through the venue's server and through ReactVision - and the server
 * works out how the two maps lie to each other (the room's bridge;
 * `localization-server/docs/api-v2.md`, section 11). The server looks at the room from
 * three places first, then the service is asked while the staff member walks on. After that the room's one door is
 * the same whichever way a phone finds the room.
 *
 * Not in `ui-spec.md` (revision 2 knows the cloud only as a second place to keep rooms):
 * the screen and its texts are this app's own. NOT RUN: there is no ReactVision account.
 */
export function BridgeScreen() {
  const insets = useInsets();
  const phase = useBridge((s) => s.phase);
  const mapId = useBridge((s) => s.mapId);
  const looks = useBridge((s) => s.looks);
  const moveOn = useBridge((s) => s.moveOn);
  const count = useBridge((s) => s.count);
  const enough = useBridge((s) => s.enough);
  const result = useBridge((s) => s.result);
  const failure = useBridge((s) => s.failure);
  const tracking = useAppState((s) => s.trackingState);
  const roomName = nameOfRoom(mapId) || t('home.room.eyebrow');

  const close = useCallback(() => {
    stopBridgeMeasure();
    if (!appActions.back()) {
      appActions.resetTo('settings');
    }
  }, []);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close]);
  // Leaving the screen any other way ends the measurement too.
  useEffect(() => () => stopBridgeMeasure(), []);

  const again = () => {
    const place = vpsOfRoom(mapId)?.locationId;
    if (mapId && place) {
      startBridgeMeasure(mapId, place);
      appActions.requestRelocalize();
    }
  };

  const lost = tracking !== 'normal' && (phase === 'finding' || phase === 'walking');
  const cm = result?.positionErrorM === null || result?.positionErrorM === undefined ? null : Math.max(1, Math.round(result.positionErrorM * 100));

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} pointerEvents="box-none">
      <View style={styles.topRow} pointerEvents="box-none">
        <HudButton icon="close" label={t('common.close')} onPress={close} />
        <HudPill text={roomName} icon="door" />
      </View>

      <View style={styles.under} pointerEvents="box-none">
        {lost ? <CoachCard danger line1={t('ar.lost.title')} line2={t('ar.lost.body')} /> : null}
      </View>

      <View style={styles.spacer} pointerEvents="none" />

      <View style={styles.bottom} pointerEvents="box-none">
        {phase === 'finding' && !moveOn ? <CoachCard line1={t('ar.coach.find.1')} line2={t('ar.coach.find.2')} /> : null}
        {phase === 'finding' && moveOn ? (
          <CoachCard line1={t('bridge.look.1')} line2={t('bridge.look.2', { n: looks + 1, total: BRIDGE.looks })} />
        ) : null}
        {phase === 'walking' ? (
          <CoachCard
            line1={t('bridge.walk.1')}
            line2={count === 0 ? t('bridge.walk.2.none') : t('bridge.walk.2', { n: count, total: BRIDGE.samples })}
          />
        ) : null}
        {phase === 'sending' ? <CoachCard line1={t('bridge.sending')} /> : null}
        {phase === 'walking' ? (
          <AppButton label={t('bridge.finish')} onPress={() => void finishBridgeMeasure()} disabled={!enough} />
        ) : null}
      </View>

      {phase === 'done' ? (
        <Sheet onClose={close}>
          <SheetTitle>{t('bridge.done.title')}</SheetTitle>
          <Body dim>{cm === null ? t('bridge.done.body.unknown') : t('bridge.done.body', { cm })}</Body>
          {/* The estimate is a lower bound; what the server says about it is passed on as it is. */}
          {(result?.warnings ?? []).map((line) => (
            <Small key={line}>{t('bridge.warning', { text: line })}</Small>
          ))}
          <AppButton label={t('place.done')} onPress={close} />
        </Sheet>
      ) : null}

      {phase === 'failed' ? (
        <Sheet onClose={close}>
          <SheetTitle>{t('bridge.failed.title')}</SheetTitle>
          <Body dim>{t(failure === 'cloud' ? 'bridge.failed.cloud' : failure === 'disagree' ? 'bridge.failed.disagree' : 'bridge.failed.server')}</Body>
          <AppButton label={t('place.failed.again')} onPress={again} />
          <AppButton kind="text" label={t('common.close')} onPress={close} />
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  under: { marginTop: 10, gap: 8, alignItems: 'flex-start' },
  spacer: { flex: 1 },
  bottom: { gap: 10 },
});
