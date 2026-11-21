import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyFailure, cloudAnchorApiFrom, readHostResult, readResolveResult } from './cloudAnchorApi';

test('host result: success needs an id', () => {
  assert.deepEqual(readHostResult({ success: true, cloudAnchorId: ' ua-1 ', state: 'Success' }), { ok: true, cloudAnchorId: 'ua-1' });
  const noId = readHostResult({ success: true, state: 'Success' });
  assert.equal(noId.ok, false);
  assert.equal(!noId.ok && noId.state, 'ErrorInternal');
  assert.deepEqual(readHostResult({ success: false, state: 'ErrorNotAuthorized', error: 'no' }), {
    ok: false,
    state: 'ErrorNotAuthorized',
    error: 'no',
  });
  assert.equal(readHostResult(undefined).ok, false);
});

test('resolve result: success needs a finite pose', () => {
  assert.deepEqual(
    readResolveResult({ success: true, state: 'Success', anchor: { anchorId: 'a', position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 1, 1] } }),
    { ok: true, pose: { position: [1, 2, 3], rotation: [0, 90, 0] } },
  );
  assert.equal(readResolveResult({ success: true, state: 'Success' }).ok, false);
  assert.equal(readResolveResult({ success: true, state: 'Success', anchor: { position: [1, null, 3], rotation: [0, 0, 0] } }).ok, false);
  assert.equal(readResolveResult({ success: true, state: 'Success', anchor: { position: [1, 'x', 3], rotation: [0, 0, 0] } }).ok, false);
  const failed = readResolveResult({ success: false, state: 'ErrorCloudIdNotFound' });
  assert.deepEqual(failed, { ok: false, state: 'ErrorCloudIdNotFound', error: 'ErrorCloudIdNotFound' });
});

test('api: null when the navigator has no cloud anchor calls', () => {
  assert.equal(cloudAnchorApiFrom(null), null);
  assert.equal(cloudAnchorApiFrom(undefined), null);
  assert.equal(cloudAnchorApiFrom({ hostCloudAnchor: () => {} }), null);
});

test('api: calls go to the navigator; a thrown error becomes a failed outcome', async () => {
  const calls: unknown[][] = [];
  const api = cloudAnchorApiFrom({
    hostCloudAnchor: async (...args: unknown[]) => {
      calls.push(['host', ...args]);
      return { success: true, cloudAnchorId: 'ua-9', state: 'Success' };
    },
    resolveCloudAnchor: async (...args: unknown[]) => {
      calls.push(['resolve', ...args]);
      throw new Error('Cloud anchors are disabled: set cloudAnchorProvider');
    },
    cancelCloudAnchorOperations: () => {
      calls.push(['cancel']);
      throw new Error('view gone');
    },
  });
  assert.ok(api);
  assert.deepEqual(await api.host('local-1', 365), { ok: true, cloudAnchorId: 'ua-9' });
  const resolved = await api.resolve('ua-9');
  assert.equal(resolved.ok, false);
  assert.equal(!resolved.ok && resolved.state, 'Exception');
  api.cancel(); // must not throw
  assert.deepEqual(calls, [['host', 'local-1', 365], ['resolve', 'ua-9'], ['cancel']]);
  assert.equal(classifyFailure('Exception', !resolved.ok ? resolved.error : '').reason, 'not-supported');
});

test('failures: what can be tried again and what cannot', () => {
  for (const state of ['ErrorResolvingLocalizationNoMatch', 'Timeout', 'ErrorNetworkFailure', 'ErrorResourceExhausted', 'ErrorInternal', 'SomethingNew']) {
    assert.equal(classifyFailure(state).retry, true, state);
  }
  for (const state of ['ErrorCloudIdNotFound', 'ErrorAnchorExpired', 'ErrorNotAuthorized', 'ErrorAuthenticationFailed', 'ErrorResolvingSdkVersionTooOld', 'ErrorNotSupported']) {
    assert.equal(classifyFailure(state).retry, false, state);
  }
  assert.equal(classifyFailure('ErrorCloudIdNotFound').reason, 'gone');
  assert.equal(classifyFailure('ErrorAnchorExpired').reason, 'gone');
  assert.equal(classifyFailure('ErrorNotAuthorized').reason, 'not-authorised');
  assert.equal(classifyFailure('ErrorHostingInsufficientVisualFeatures').reason, 'poor-view');
  assert.equal(classifyFailure('ErrorNetworkFailure').reason, 'network');
  assert.equal(classifyFailure('Exception', 'boom').reason, 'unknown');
});
