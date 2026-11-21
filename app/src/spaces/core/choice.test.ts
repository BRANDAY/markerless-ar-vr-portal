import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chosenSpaceId, FILTERS_ABOVE, filtersShown, type ListedSpace, listedSpaces, withChoice } from './choice';

const space = (id: string, over: Partial<ListedSpace> = {}): ListedSpace => ({ id, kind: 'walk-in', heritage: true, developerOnly: false, ...over });

const SPACES: ListedSpace[] = [
  space('atrium'),
  space('harbour', { kind: '360' }),
  space('studio', { heritage: false }),
  space('test', { heritage: false, developerOnly: true }),
];

test('spaces: what is offered, and the chips', () => {
  assert.deepEqual(listedSpaces(SPACES, false).map((s) => s.id), ['atrium', 'harbour', 'studio']);
  assert.deepEqual(listedSpaces(SPACES, true).map((s) => s.id), ['atrium', 'harbour', 'studio', 'test']);
  assert.deepEqual(listedSpaces(SPACES, true, 'heritage').map((s) => s.id), ['atrium', 'harbour']);
  assert.deepEqual(listedSpaces(SPACES, true, '360').map((s) => s.id), ['harbour']);
  // the chips only for a long list (more than six offered)
  assert.equal(filtersShown(SPACES, true), false);
  const many = Array.from({ length: FILTERS_ABOVE + 1 }, (_, i) => space(`s${i}`));
  assert.equal(filtersShown(many, false), true);
  assert.equal(filtersShown(many.slice(1), false), false);
  // developer-only spaces do not count for a staff member
  assert.equal(filtersShown([...many.slice(1), space('dev', { developerOnly: true })], false), false);
});

test('spaces: the one chosen for the room, else the first offered', () => {
  const byRoom = { hall: 'harbour', lab: 'test', old: 'gone' };
  assert.equal(chosenSpaceId(SPACES, byRoom, 'hall', false), 'harbour');
  // no choice for this room, and no room at all
  assert.equal(chosenSpaceId(SPACES, byRoom, 'side', false), 'atrium');
  assert.equal(chosenSpaceId(SPACES, byRoom, null, false), 'atrium');
  // a developer-only space holds only while developer options are on
  assert.equal(chosenSpaceId(SPACES, byRoom, 'lab', true), 'test');
  assert.equal(chosenSpaceId(SPACES, byRoom, 'lab', false), 'atrium');
  // a space the app no longer has
  assert.equal(chosenSpaceId(SPACES, byRoom, 'old', true), 'atrium');
  // whatever the phone's file held
  for (const broken of [null, undefined, 'x', 7, ['harbour'], { hall: 3 }]) {
    assert.equal(chosenSpaceId(SPACES, broken, 'hall', false), 'atrium');
  }
  assert.equal(chosenSpaceId([], byRoom, 'hall', false), null);
  // only developer-only spaces exist: still a space behind the door
  assert.equal(chosenSpaceId([space('test', { developerOnly: true })], {}, 'hall', false), 'test');
});

test('spaces: a choice is kept per room', () => {
  const first = withChoice({}, 'hall', 'harbour');
  assert.deepEqual(first, { hall: 'harbour' });
  const second = withChoice(first, 'side', 'studio');
  assert.deepEqual(second, { hall: 'harbour', side: 'studio' });
  assert.deepEqual(withChoice(second, 'hall', 'atrium'), { hall: 'atrium', side: 'studio' });
  // the earlier record is not changed, and what is not a choice is dropped
  assert.deepEqual(first, { hall: 'harbour' });
  assert.deepEqual(withChoice({ hall: 3, side: '', lab: 'test' }, 'hall', 'atrium'), { lab: 'test', hall: 'atrium' });
  assert.deepEqual(withChoice(null, 'hall', 'atrium'), { hall: 'atrium' });
});
