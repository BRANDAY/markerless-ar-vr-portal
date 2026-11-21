import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BRAND } from '../brand';
import { en } from './en';
import { registerLanguage, setLanguage, t } from './index';

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
