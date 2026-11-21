import assert from 'node:assert/strict';
import { test } from 'node:test';

import { photoName, readScreenshot } from './photo';

test('photo: the file is named after the product and the local time', () => {
  assert.equal(photoName('Vrata', new Date(2026, 10, 21, 9, 5, 7)), 'vrata-20261121-090507');
  assert.equal(photoName('FESB AR Portal', new Date(2026, 0, 2, 23, 59, 0)), 'fesb-ar-portal-20260102-235900');
  // a name without a usable letter still gives a file name
  assert.equal(photoName('***', new Date(2026, 0, 2, 3, 4, 5)), 'photo-20260102-030405');
});

test('photo: what the AR view answers', () => {
  assert.deepEqual(readScreenshot({ success: true, url: '/storage/emulated/0/Pictures/vrata-1.png', errorCode: 0 }, true), {
    ok: true,
    uri: 'file:///storage/emulated/0/Pictures/vrata-1.png',
    inGallery: true,
  });
  // a location that already is one stays as it is
  assert.equal((readScreenshot({ success: true, url: 'content://media/1' }, true) as { uri: string }).uri, 'content://media/1');
  const failed = readScreenshot({ success: false, url: '', errorCode: 2 }, true);
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? '' : failed.reason, /code 2/);
  assert.equal(readScreenshot({ success: true }, false).ok, false); // nothing was written
  assert.equal(readScreenshot(undefined, false).ok, false);
});
