import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BRAND } from '../brand';
import { en, type TextKey } from './en';
import { hr } from './hr';
import { availableLanguages, registerLanguage, setLanguage, t } from './index';
import { LANGUAGE_NAMES, pickLanguage } from './languages';

test('t: parameters and the product names are filled in', () => {
  assert.equal(t('connect.found.title', { server: 'Museum PC' }), 'Found “Museum PC”');
  assert.equal(t('permission.title'), `${BRAND.name} needs your camera`);
  assert.ok(t('connect.none.check.pc').includes(BRAND.serverName));
  assert.equal(t('home.room.doorPlaced.noDate', { w: '0.90', h: '2.00' }), 'Door placed · 0.90 × 2.00 m');
  // A parameter nobody passed stays visible, so that a missing value is noticed.
  assert.equal(t('connect.found.title'), 'Found “{server}”');
});

test('t: another language, with English for what it does not have', () => {
  registerLanguage('xx', { 'common.back': 'Natrag' });
  setLanguage('xx');
  assert.equal(t('common.back'), 'Natrag');
  assert.equal(t('common.close'), 'Close');
  setLanguage('nope');
  assert.equal(t('common.back'), 'Back');
});

test('dictionary: the product name is never written out', () => {
  for (const [key, text] of Object.entries(en)) {
    assert.ok(!text.includes(BRAND.name), `${key} spells the name out instead of using {app}`);
  }
});

test('dictionary: no technical words (ui-spec, section 2)', () => {
  const never = /\b(portal|anchor|locali[sz]\w*|relocali[sz]\w*|tracking|pose|vps|provider|api|environment|session|capture|map id)\b/i;
  for (const [key, text] of Object.entries(en)) {
    assert.ok(!never.test(text), `${key}: "${text}"`);
  }
});

test('dictionary: sentence case, no empty texts', () => {
  for (const [key, text] of Object.entries(en)) {
    assert.ok(text.trim().length > 0, key);
    const first = text.replace(/\{\w+\}/g, 'X').replace(/^[“"]/, '').charAt(0);
    assert.ok(first === first.toUpperCase() || key === 'ar.room.fallback' || key === 'connect.address.hint', `${key} starts in lower case`);
  }
});

test('croatian: every text is there, with the same parameters', () => {
  const params = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join(' ');
  assert.deepEqual(Object.keys(hr).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en) as TextKey[]) {
    assert.ok(hr[key].trim().length > 0, key);
    assert.equal(params(hr[key]), params(en[key]), `${key}: other parameters than the English text`);
    const first = hr[key].replace(/\{\w+\}/g, 'X').replace(/^[„“"]/, '').charAt(0);
    assert.ok(first === first.toUpperCase() || key === 'ar.room.fallback' || key === 'connect.address.hint', `${key} starts in lower case`);
  }
  // only the texts whose English is a name or a pattern may be the same in both
  const same = (Object.keys(en) as TextKey[]).filter((key) => hr[key] === en[key]);
  assert.deepEqual(same.sort(), ['build.took.minutes', 'build.took.seconds', 'connection.server.short', 'place.metres', 'settings.language.english', 'settings.version']);
});

test('croatian: the app speaks it', () => {
  assert.ok(availableLanguages().includes('hr'));
  setLanguage('hr');
  assert.equal(t('common.back'), 'Natrag');
  assert.equal(t('permission.title'), `Aplikacija ${BRAND.name} treba kameru`);
  assert.equal(t('rooms.state.ready', { space: t('space.sponza.name') }), 'Spremno · Atrij palače Sponza');
  setLanguage('en');
  assert.equal(t('common.back'), 'Back');
});

test('language: the chosen one, else the phone\'s, else English', () => {
  const have = ['en', 'hr'];
  assert.equal(pickLanguage(null, 'hr_HR', have), 'hr');
  assert.equal(pickLanguage(null, 'hr-HR', have), 'hr');
  assert.equal(pickLanguage(null, 'en-GB', have), 'en');
  // a phone in a language the app does not have
  assert.equal(pickLanguage(null, 'de_DE', have), 'en');
  assert.equal(pickLanguage(null, null, have), 'en');
  // the choice in the app wins over the phone
  assert.equal(pickLanguage('en', 'hr_HR', have), 'en');
  assert.equal(pickLanguage('hr', 'en_US', have), 'hr');
  // a choice the app no longer has: the phone's again
  assert.equal(pickLanguage('it', 'hr_HR', have), 'hr');
  // every language that can be chosen has a name to be chosen by
  for (const code of have) {
    assert.ok(LANGUAGE_NAMES[code], code);
  }
});
