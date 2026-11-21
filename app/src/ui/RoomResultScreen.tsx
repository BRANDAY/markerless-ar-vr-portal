import { useEffect } from 'react';
import { useWindowDimensions } from 'react-native';

import { t } from '../i18n';
import { roomsActions, useRooms } from '../room/roomsStore';
import { appActions } from '../state/appStore';
import { roomResultBody } from './core/placeView';
import { homeScreen, openGuidedScan, openPlaceDoor } from './flows';
import { AppButton, Body, ScreenFrame, Title } from './kit';
import { PlanDrawing } from './PlanDrawing';
import { SPACE } from './theme';

/**
 * Room result (`docs/product/ui-spec.md`, 5.8): what the server understood about the room
 * that was just scanned, and the way on to placing the door. A doorway the server found
 * is a suggestion; nothing is saved here.
 */
export function RoomResultScreen() {
  const { width } = useWindowDimensions();
  const currentId = useRooms((s) => s.currentId);
  const detail = useRooms((s) => s.detail);

  useEffect(() => {
    void roomsActions.refresh();
  }, []);

  // Until the server has answered there is nothing to say about the room's shape.
  const plan = detail && detail.mapId === currentId ? detail : null;
  const body = plan ? roomResultBody(plan.room) : null;
  const back = () => {
    if (!appActions.back()) {
      appActions.resetTo(homeScreen());
    }
  };

  return (
    <ScreenFrame
      title={t('roomResult.bar')}
      onBack={back}
      footer={
        <>
          <AppButton label={t('home.placeDoor')} onPress={openPlaceDoor} />
          <AppButton kind="text" label={t('build.scanAgain')} onPress={() => openGuidedScan('again')} />
        </>
      }
    >
      <PlanDrawing room={plan?.room ?? null} door={null} width={width - 2 * SPACE.screen} height={260} detailed />
      <Title>{t('roomResult.title')}</Title>
      {body ? <Body dim>{t(body.key, body.params)}</Body> : null}
    </ScreenFrame>
  );
}
