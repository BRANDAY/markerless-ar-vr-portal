import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { en } from '../../i18n/en';
import type { ArInput } from './arView';
import {
  afterWrongPin,
  doorMayBeShown,
  gateLocked,
  hashPin,
  isPin,
  OPEN_GATE,
  PIN_LOCK_MS,
  pinMatches,
  sha256,
  startScreen,
} from './modes';
import { type VisitorInput, type VisitorSheet, visitorSheetText, visitorView } from './visitorView';

test('modes: a fresh install opens the visitor screen; staff mode opens Home (4.3)', () => {
  assert.equal(startScreen({ visitorMode: true, onboardingDone: false }), 'visitor');
  assert.equal(startScreen({ visitorMode: true, onboardingDone: true }), 'visitor');
  assert.equal(startScreen({ visitorMode: false, onboardingDone: true }), 'home');
  // staff mode was opened, the app closed before the welcome cards were through
  assert.equal(startScreen({ visitorMode: false, onboardingDone: false }), 'welcome');
});

test('modes: a door is shown only where staff saved one', () => {
  for (const source of ['manual', 'selected']) {
    assert.equal(doorMayBeShown(source), true, source);
  }
  assert.equal(doorMayBeShown('auto'), false); // a suggestion for the placing screen, not a door
  for (const source of ['none', '', null, undefined]) {
    assert.equal(doorMayBeShown(source), false);
  }
});

test('modes: SHA-256 agrees with Node for short, long and non-ASCII input', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const text of ['staff-pin:0420', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(200), 'Čiovo – ž']) {
    assert.equal(sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'), text);
  }
});

test('modes: the staff PIN is four digits, kept as a hash', () => {
  assert.equal(isPin('0420'), true);
  assert.equal(isPin('042'), false);
  assert.equal(isPin('04201'), false);
  assert.equal(isPin('04a0'), false);
  const hash = hashPin('0420');
  assert.equal(hash.length, 64);
  assert.equal(hash.includes('0420'), false);
  assert.equal(pinMatches('0420', hash), true);
  assert.equal(pinMatches('0421', hash), false);
  assert.equal(pinMatches('0420', null), false);
});

test('modes: five wrong PINs in a row lock the pad for thirty seconds', () => {
  let gate = OPEN_GATE;
  for (let i = 0; i < 4; i += 1) {
    gate = afterWrongPin(gate, 1000);
    assert.equal(gateLocked(gate, 1000), false);
  }
  gate = afterWrongPin(gate, 1000);
  assert.equal(gateLocked(gate, 1000), true);
  assert.equal(gateLocked(gate, 1000 + PIN_LOCK_MS - 1), true);
  assert.equal(gateLocked(gate, 1000 + PIN_LOCK_MS), false);
  assert.equal(gate.wrong, 0); // a fresh count after the lock
});

function visitor(over: Partial<VisitorInput>): VisitorInput {
  const base: ArInput = {
    status: 'localizing',
    meta: {},
    hasDoor: false,
    mode: 'AR',
    tracking: 'normal',
    trackingReason: '',
    source: 'room',
    connection: 'connected',
  };
  return { ...base, wifi: true, cameraRefused: false, arUnsupported: false, searchPending: false, ...over };
}

test('visitor: coach lines in a visitor’s words (5.13)', () => {
  const line = (attempt: number, stage?: 'thinking' | 'busy') => visitorView(visitor({ meta: { attempt, stage } })).coach;
  assert.deepEqual(line(1), { line1: 'ar.coach.look.1', line2: 'ar.coach.look.recording' });
  assert.deepEqual(line(2, 'thinking'), { line1: 'ar.coach.look.1', line2: 'ar.coach.look.thinking' });
  assert.deepEqual(line(6, 'busy'), { line1: 'ar.coach.look.1', line2: 'ar.coach.look.busy' });
  assert.equal(visitorView(visitor({ status: 'waiting-for-tracking' })).coach?.line1, 'ar.coach.ready.1');
  // looking for the server, loading the room
  const connecting = visitorView(visitor({ status: 'waiting-for-server', meta: { code: 'connecting' } }));
  assert.equal(connecting.coach?.line1, 'visitor.coach.moment.1');
  assert.equal(connecting.sheet, null);
  // tracking warnings replace the line
  assert.equal(
    visitorView(visitor({ meta: { attempt: 1 }, tracking: 'limited', trackingReason: 'excessive motion' })).coach?.line1,
    'ar.coach.motion.1',
  );
});

test('visitor: every dead end is a sheet', () => {
  const sheet = (over: Partial<VisitorInput>) => visitorView(visitor(over)).sheet;
  const noServer = { status: 'waiting-for-server', meta: { code: 'no-server' } };
  assert.equal(sheet(noServer), 'noServer');
  assert.equal(sheet({ ...noServer, wifi: false }), 'wifi');
  assert.equal(sheet({ status: 'waiting-for-server', meta: { code: 'server-offline' } }), 'noServer');
  assert.equal(sheet({ status: 'error', meta: { code: 'incompatible' } }), 'version');
  assert.equal(sheet({ status: 'error', meta: { code: 'no-room' } }), 'noDoor');
  assert.equal(sheet({ status: 'error', meta: { code: 'no-doorway' } }), 'noDoor');
  // ReactVision as the connection method: not reachable, or not set up
  assert.equal(sheet({ status: 'error', meta: { code: 'cloud-offline' } }), 'cloud');
  assert.equal(sheet({ status: 'error', meta: { code: 'cloud-not-set-up' } }), 'cloud');
  assert.equal(sheet({ status: 'lost', meta: { code: 'not-recognised' } }), 'notRecognised');
  assert.equal(sheet({ cameraRefused: true }), 'camera');
  assert.equal(sheet({ arUnsupported: true }), 'device');
  // while the first search for a server has not ended, no server is not a problem yet
  const pending = visitorView(visitor({ ...noServer, searchPending: true }));
  assert.equal(pending.sheet, null);
  assert.equal(pending.coach?.line1, 'visitor.coach.moment.1');
  // a standing door is not covered by a sheet about finding it
  assert.equal(sheet({ status: 'localized', hasDoor: true }), null);
});

test('visitor: door, inside and tracking loss as for staff', () => {
  assert.equal(visitorView(visitor({ status: 'localized', hasDoor: true })).situation, 'door');
  assert.equal(visitorView(visitor({ status: 'localized', hasDoor: true, mode: 'VR' })).situation, 'inside');
  assert.equal(visitorView(visitor({ status: 'lost', meta: { code: 'tracking-lost' }, hasDoor: true })).lostBanner, true);
  assert.equal(visitorView(visitor({ status: 'localizing', hasDoor: true, meta: { pending: true, attempt: 1 } })).outline, true);
});

test('visitor: every sheet has its texts, and "Try again" unless the spec says otherwise', () => {
  const sheets: VisitorSheet[] = ['noServer', 'wifi', 'version', 'noDoor', 'notRecognised', 'cloud', 'camera', 'device'];
  for (const sheet of sheets) {
    const text = visitorSheetText(sheet);
    assert.ok(en[text.title], sheet);
    assert.ok(en[text.body], sheet);
    if (text.reason) {
      assert.ok(en[text.reason], sheet);
    }
  }
  assert.equal(visitorSheetText('camera').button, 'settings');
  assert.equal(visitorSheetText('device').button, null);
  assert.equal(visitorSheetText('noDoor').button, 'retry');
});
