import assert from 'node:assert/strict';
import test from 'node:test';
import { createCorridorCache } from '../../server/providers/corridor/cache.js';

test('corridor cache: fresh hit, single-flight, stale-on-failure, hard expiry', async () => {
  let clock = 1000;
  const cache = createCorridorCache({
    ttlMs: 100,
    staleMaxMs: 1000,
    now: () => clock,
  });
  let calls = 0;
  const ok = async () => ({ n: ++calls });
  const [a, b] = await Promise.all([cache.read('k', ok), cache.read('k', ok)]);
  assert.equal(calls, 1, 'concurrent readers share one upstream call');
  assert.equal(a.cache, 'MISS');
  assert.deepEqual(b.value, { n: 1 });

  clock += 50;
  const hit = await cache.read('k', ok);
  assert.equal(hit.cache, 'HIT');
  assert.equal(hit.delayed, false);

  clock += 100;
  const fail = async () => {
    throw new Error('upstream down');
  };
  const stale = await cache.read('k', fail);
  assert.equal(stale.cache, 'STALE');
  assert.equal(stale.delayed, true);
  assert.deepEqual(stale.value, { n: 1 });
  assert.equal(stale.error, 'upstream down');

  clock += 2000;
  await assert.rejects(() => cache.read('k', fail), /upstream down/);
  assert.throws(() => createCorridorCache({ ttlMs: 0 }), TypeError);
});
