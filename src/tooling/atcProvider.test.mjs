import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import {
  atcProxy,
  atcRedirectDecision,
  atcStreamUpstreamUrl,
  createAtcProxyMiddleware,
  parseAtcStreamPath,
} from '../../server/providers/atc.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const KNOWN = new Set(['ksfo_twr', 'zoa_35']);
const isKnown = (mount) => KNOWN.has(mount);

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.finished = new Promise((resolve) => {
      this._resolve = resolve;
    });
  }
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
  }
  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(chunk) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    this._resolve();
    this.emit('finish');
  }
  get body() {
    return Buffer.concat(this.chunks);
  }
}

function upstreamResponse(status, body, headers = {}) {
  const webBody =
    body === null
      ? null
      : Readable.toWeb(
          typeof body === 'string' || Buffer.isBuffer(body)
            ? Readable.from([Buffer.from(body)])
            : body,
        );
  return new Response(webBody, { status, headers });
}

test('stream path parsing accepts only /stream/<mount>', () => {
  assert.equal(parseAtcStreamPath('/stream/ksfo_twr'), 'ksfo_twr');
  assert.equal(parseAtcStreamPath('/stream/KSFO_TWR/'), 'ksfo_twr');
  assert.equal(parseAtcStreamPath('/stream/ksfo%5Ftwr'), 'ksfo_twr');
  assert.equal(parseAtcStreamPath('/stream/'), null);
  assert.equal(parseAtcStreamPath('/stream'), null);
  assert.equal(parseAtcStreamPath('/stream/a/b'), null);
  assert.equal(parseAtcStreamPath('/feeds'), null);
  assert.equal(parseAtcStreamPath('/stream/%E0%A4%A'), null);
});

test('upstream URL is only built for directory mounts', () => {
  assert.equal(
    atcStreamUpstreamUrl('ksfo_twr', { isKnown }),
    'https://d.liveatc.net/ksfo_twr',
  );
  assert.equal(atcStreamUpstreamUrl('kzzz_twr', { isKnown }), null);
  assert.equal(atcStreamUpstreamUrl('../x', { isKnown }), null);
  // The real allowlist is the committed directory; a placeholder mount is unknown.
  assert.equal(atcStreamUpstreamUrl('not_a_real_mount_zz'), null);
});

test('redirects may only land on liveatc.net hosts', () => {
  const from = 'https://d.liveatc.net/ksfo_twr';
  assert.deepEqual(
    atcRedirectDecision(from, 'https://s1-fmt2.liveatc.net/ksfo_twr?nocache=1'),
    { ok: true, url: 'https://s1-fmt2.liveatc.net/ksfo_twr?nocache=1' },
  );
  assert.equal(
    atcRedirectDecision(from, 'http://s1-bos.liveatc.net/ksfo_twr').ok,
    true,
  );
  assert.equal(atcRedirectDecision(from, '/ksfo_twr').ok, true);
  assert.equal(
    atcRedirectDecision(from, 'https://evil.example/ksfo_twr').ok,
    false,
  );
  assert.equal(
    atcRedirectDecision(from, 'https://liveatc.net.evil.example/x').ok,
    false,
  );
  assert.equal(atcRedirectDecision(from, 'ftp://d.liveatc.net/x').ok, false);
  assert.equal(atcRedirectDecision(from, null).ok, false);
});

test('unknown mounts answer 404 without contacting LiveATC', async () => {
  let fetched = 0;
  const middleware = createAtcProxyMiddleware({
    isKnown,
    fetchImpl: async () => {
      fetched += 1;
      return upstreamResponse(200, 'x');
    },
  });
  for (const url of [
    '/stream/kzzz_twr',
    '/stream/..%2Fetc',
    '/stream/KSFO%20TWR',
  ]) {
    const res = new FakeResponse();
    await middleware({ url, method: 'GET' }, res, () => {});
    assert.equal(res.status, 404, url);
    assert.match(res.body.toString(), /Unknown ATC mount/);
  }
  assert.equal(fetched, 0);
  let passed = false;
  await middleware({ url: '/feeds', method: 'GET' }, new FakeResponse(), () => {
    passed = true;
  });
  assert.equal(
    passed,
    true,
    'non-stream paths fall through to the next handler',
  );
  const post = new FakeResponse();
  await middleware({ url: '/stream/ksfo_twr', method: 'POST' }, post, () => {});
  assert.equal(post.status, 405);
  assert.equal(fetched, 0);
});

test('known mounts relay MPEG bytes with audio/mpeg after following the LiveATC redirect', async () => {
  const calls = [];
  const mpeg = Buffer.from([0xff, 0xf3, 0x20, 0xc4, 0x00, 0x01, 0x02, 0x03]);
  const middleware = createAtcProxyMiddleware({
    isKnown,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://d.liveatc.net/ksfo_twr') {
        return upstreamResponse(302, null, {
          location: 'https://s1-fmt2.liveatc.net/ksfo_twr?nocache=1',
        });
      }
      return upstreamResponse(200, mpeg, { 'content-type': 'audio/mpeg' });
    },
  });
  const res = new FakeResponse();
  await middleware({ url: '/stream/ksfo_twr', method: 'GET' }, res, () => {});
  await res.finished;
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual([...res.body], [...mpeg]);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://d.liveatc.net/ksfo_twr',
      'https://s1-fmt2.liveatc.net/ksfo_twr?nocache=1',
    ],
  );
  for (const call of calls) {
    assert.equal(call.init.redirect, 'manual');
    assert.match(call.init.headers['User-Agent'], /Mozilla/);
  }
});

test('off-host redirects and upstream failures answer with JSON errors', async () => {
  const offHost = createAtcProxyMiddleware({
    isKnown,
    fetchImpl: async () =>
      upstreamResponse(302, null, {
        location: 'https://evil.example/ksfo_twr',
      }),
  });
  const res = new FakeResponse();
  await offHost({ url: '/stream/ksfo_twr', method: 'GET' }, res, () => {});
  assert.equal(res.status, 502);
  assert.match(res.body.toString(), /off liveatc\.net/);

  const missing = createAtcProxyMiddleware({
    isKnown,
    fetchImpl: async () => upstreamResponse(404, 'gone'),
  });
  const gone = new FakeResponse();
  await missing({ url: '/stream/zoa_35', method: 'GET' }, gone, () => {});
  assert.equal(gone.status, 404);

  const aborted = createAtcProxyMiddleware({
    isKnown,
    fetchImpl: async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  const timedOut = new FakeResponse();
  await aborted({ url: '/stream/ksfo_twr', method: 'GET' }, timedOut, () => {});
  assert.equal(timedOut.status, 504);
});

test('a listener leaving aborts the upstream request and releases the relay slot', async () => {
  let upstreamSignal = null;
  let cancelled = false;
  const middleware = createAtcProxyMiddleware({
    isKnown,
    maxConcurrent: 1,
    fetchImpl: async (url, init) => {
      upstreamSignal = init.signal;
      const source = new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(source, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    },
  });
  const res = new FakeResponse();
  await middleware({ url: '/stream/ksfo_twr', method: 'GET' }, res, () => {});
  assert.equal(res.status, 200);
  const second = new FakeResponse();
  await middleware(
    { url: '/stream/ksfo_twr', method: 'GET' },
    second,
    () => {},
  );
  assert.equal(
    second.status,
    503,
    'the relay slot is held while a listener is connected',
  );
  res.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    cancelled,
    true,
    'upstream body cancelled when the listener left',
  );
  // The downstream signal only guards the header phase (the body has its own
  // teardown above), so it is no longer linked once the stream is flowing.
  assert.equal(upstreamSignal.aborted, false);
  const third = new FakeResponse();
  await middleware({ url: '/stream/ksfo_twr', method: 'GET' }, third, () => {});
  assert.equal(third.status, 200, 'slot released after the listener left');
  third.emit('close');
});

test('a listener leaving before LiveATC answers aborts the pending upstream request', async () => {
  let upstreamSignal = null;
  let release;
  const middleware = createAtcProxyMiddleware({
    isKnown,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        upstreamSignal = init.signal;
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
        release = resolve;
      }),
  });
  const res = new FakeResponse();
  const pending = middleware(
    { url: '/stream/ksfo_twr', method: 'GET' },
    res,
    () => {},
  );
  await new Promise((resolve) => setImmediate(resolve));
  res.emit('close');
  await pending;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(
    res.headersSent,
    false,
    'nothing is written to a listener who already left',
  );
  assert.equal(typeof release, 'function');
});

test('composition registers exactly one ATC relay plugin with both server hooks', () => {
  const plugins = localProviderPlugins();
  const matches = plugins.filter((plugin) => plugin.name === atcProxy().name);
  assert.equal(matches.length, 1);
  assert.equal(typeof matches[0].configureServer, 'function');
  assert.equal(typeof matches[0].configurePreviewServer, 'function');
  let route = null;
  matches[0].configureServer({
    middlewares: {
      use(path) {
        route = path;
      },
    },
  });
  assert.equal(route, '/api/atc');
});
