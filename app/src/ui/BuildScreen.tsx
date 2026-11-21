import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { t } from '../i18n';
import { cancelUploadOrBuild, resumeBuild, sendAgain } from '../room/roomServer';
import { roomName } from '../room/roomsStore';
import { type BuildProgress, isBuilding, roomActions, useRoomScan } from '../room/roomStore';
import { appActions } from '../state/appStore';
import {
  BUILD_STEPS,
  type BuildAction,
  buildProblem,
  currentStep,
  duration,
  percentOf,
  timeLine,
} from './core/buildView';
import { homeScreen, openGuidedScan, searchForServer, seeRoom } from './flows';
import { Icon } from './icons';
import { AppButton, Body, IconTile, Notice, ScreenFrame, Sheet, SheetTitle, Title } from './kit';
import { useServerView } from './ServerPanel';
import { SIZE, TYPE, useTheme } from './theme';

const ACTION_LABEL = {
  'send-again': 'build.sendAgain',
  'scan-again': 'build.scanAgain',
  'search-again': 'common.searchAgain',
  'not-now': 'common.notNow',
} as const;

/**
 * Building the map (`docs/product/ui-spec.md`, 5.7): sending the scan and the server's
 * build as one percentage with five steps, then "The map is ready" or one of the problems
 * of section 7.2. The work itself is in `room/roomServer.ts` and goes on when this screen
 * is closed.
 */
export function BuildScreen() {
  const build = useRoomScan((s) => s.build);
  const connected = useServerView().connection.state === 'connected';
  const [confirmStop, setConfirmStop] = useState(false);

  // A build that was lost sight of is taken up again when the server answers.
  useEffect(() => {
    if (connected) {
      void resumeBuild();
    }
  }, [connected]);

  // Nothing to show (the app was restarted, or the build was dealt with): Home.
  const nothing = build.phase === 'idle';
  useEffect(() => {
    if (nothing) {
      appActions.resetTo(homeScreen());
    }
  }, [nothing]);

  const name = build.target?.label || roomName(build.target?.mapId ?? null) || t('home.room.eyebrow');
  const goHome = () => appActions.resetTo(homeScreen());
  /** The result has been seen: Home shows the room again, not the build. */
  const dismiss = () => {
    roomActions.resetBuild();
    goHome();
  };

  const act = (action: BuildAction) => {
    switch (action) {
      case 'send-again':
        void sendAgain();
        break;
      case 'scan-again': {
        const target = build.target;
        roomActions.resetBuild();
        openGuidedScan('again', target);
        break;
      }
      case 'search-again':
        searchForServer();
        appActions.go('connect');
        break;
      case 'not-now':
        dismiss();
        break;
    }
  };

  if (nothing) {
    return <ScreenFrame>{null}</ScreenFrame>;
  }

  if (build.phase === 'failed' || build.phase === 'cancelled') {
    const problem = build.phase === 'failed' ? buildProblem(build.failure ?? 'internal') : null;
    const primary: BuildAction = problem?.primary ?? 'send-again';
    const secondary: BuildAction | null = problem ? problem.secondary : 'not-now';
    return (
      <ScreenFrame
        title=""
        onBack={problem?.primary === 'search-again' ? goHome : dismiss}
        footer={
          <>
            <AppButton label={t(ACTION_LABEL[primary])} onPress={() => act(primary)} />
            {secondary ? <AppButton kind="text" label={t(ACTION_LABEL[secondary])} onPress={() => act(secondary)} /> : null}
          </>
        }
      >
        <IconTile icon="alert" tone={problem ? 'danger' : 'neutral'} size={56} />
        <Title>{t(problem?.title ?? 'build.stopped.title')}</Title>
        <Body dim>{t(problem?.body ?? 'build.stopped.body')}</Body>
        {problem?.tip ? <Notice>{t(problem.tip)}</Notice> : null}
      </ScreenFrame>
    );
  }

  if (build.phase === 'done') {
    const took = duration(build.seconds ?? 0);
    const time = t(took.key, took.params);
    return (
      <ScreenFrame title={name} right={<CloseButton onPress={dismiss} />} footer={<AppButton label={t('build.done.see')} onPress={seeRoom} />}>
        <IconTile icon="check" tone="teal" size={56} />
        <Title>{t('build.done.title')}</Title>
        <Body dim>{build.frames !== null ? t('build.done.line', { time, n: build.frames }) : t('build.done.line.noFrames', { time })}</Body>
      </ScreenFrame>
    );
  }

  return (
    <>
      <ScreenFrame
        title={name}
        right={<CloseButton onPress={goHome} />}
        footer={<AppButton kind="text" label={t('common.cancel')} onPress={() => setConfirmStop(true)} />}
      >
        <Progress build={build} />
        <Notice>{t('build.notice')}</Notice>
      </ScreenFrame>
      {confirmStop && isBuilding(build) ? (
        <Sheet onClose={() => setConfirmStop(false)}>
          <SheetTitle>{t('build.cancel.title')}</SheetTitle>
          <AppButton label={t('build.cancel.keep')} onPress={() => setConfirmStop(false)} />
          <AppButton
            kind="text"
            label={t('build.cancel.stop')}
            onPress={() => {
              setConfirmStop(false);
              void cancelUploadOrBuild();
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}

function CloseButton({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.close} accessibilityRole="button" accessibilityLabel={t('common.close')}>
      <Icon name="close" color={theme.ink} />
    </Pressable>
  );
}

/** Title, time line, the one percentage and the five steps. */
function Progress({ build }: { build: BuildProgress }) {
  const theme = useTheme();
  const phase = build.phase === 'uploading' || build.phase === 'queued' || build.phase === 'lost-contact' ? build.phase : 'running';
  const percent = percentOf({ phase, uploadFraction: build.uploadFraction, jobProgress: build.jobProgress });
  const line = timeLine({
    phase,
    percent,
    uploadFraction: build.uploadFraction,
    megabytes: build.megabytes,
    queuePosition: build.queuePosition,
    etaSeconds: build.etaSeconds,
  });
  const active = currentStep(percent);
  return (
    <>
      <Title>{t('build.title')}</Title>
      <Body dim>{t(line.key, line.params)}</Body>
      <View style={styles.ringRow}>
        <View style={[styles.ring, { borderColor: theme.line }]}>
          <Text style={[TYPE.title, TYPE.numbers, { color: theme.ink }]}>{`${percent}%`}</Text>
        </View>
      </View>
      <View style={[styles.track, { backgroundColor: theme.surface2 }]}>
        <View style={[styles.fill, { backgroundColor: theme.amber, width: `${percent}%` }]} />
      </View>
      <View style={styles.steps}>
        {BUILD_STEPS.map((step, index) => {
          const done = index < active;
          const current = index === active;
          return (
            <View key={step.key} style={styles.step}>
              <View
                style={[
                  styles.mark,
                  { borderColor: done ? theme.teal : current ? theme.amber : theme.line },
                  done ? { backgroundColor: theme.tealSoft } : null,
                ]}
              >
                {done ? <Icon name="check" color={theme.teal} size={14} /> : null}
                {current ? <View style={[styles.markDot, { backgroundColor: theme.amber }]} /> : null}
              </View>
              <Text style={[current ? TYPE.rowTitle : TYPE.body, { color: done || current ? theme.ink : theme.ink2 }]}>
                {t(step.key, { n: build.megabytes })}
              </Text>
            </View>
          );
        })}
      </View>
    </>
  );
}

const RING = 132;

const styles = StyleSheet.create({
  close: { width: SIZE.touch, height: SIZE.touch, alignItems: 'center', justifyContent: 'center' },
  ringRow: { alignItems: 'center', paddingVertical: 8 },
  ring: { width: RING, height: RING, borderRadius: RING / 2, borderWidth: 6, alignItems: 'center', justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  steps: { gap: 10, paddingVertical: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  mark: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  markDot: { width: 8, height: 8, borderRadius: 4 },
});
