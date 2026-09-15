import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalVoice,
  trimHistory,
  parseToolArguments,
  pickRecorderMimeType,
  resolveLocalVoiceUrl,
} from './localVoice.js';
import { summarizeViewState } from './localVoiceControl.js';
import { createLocalVoiceConfigHandler } from '../../server/providers/openai/local-voice-config.js';

const BASE = 'http://jetson-test:8008';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  };
}

function audioResponse(bytes = new Uint8Array([1, 2, 3])) {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([bytes], { type: 'audio/mpeg' }),
  };
}

/** Fake fetch keyed by path; records every call in order. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    const route = routes[path];
    if (!route) throw new TypeError('fetch failed');
    return typeof route === 'function' ? route(init, calls) : route;
  };
  return { impl, calls };
}

class FakeRecorder {
  static instances = [];
  static isTypeSupported(type) {
    return type === 'audio/webm;codecs=opus';
  }
  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || '';
    this.state = 'inactive';
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function fakeMedia() {
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }];
  return {
    tracks,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) },
  };
}

function harness(routes, overrides = {}) {
  const { impl, calls } = fakeFetch(routes);
  const statuses = [];
  const transcripts = [];
  const executed = [];
  const speech = [];
  const played = [];
  const media = fakeMedia();
  const voice = createLocalVoice({
    baseUrl: BASE,
    fetchImpl: impl,
    mediaDevices: media.mediaDevices,
    MediaRecorderImpl: FakeRecorder,
    createAudio: (url) => {
      const audio = { url, play() { played.push(url); setTimeout(() => this.onended?.(), 0); } };
      return audio;
    },
    objectUrls: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    storage: null,
    env: {},
    executeTool: async (name, args) => {
      executed.push({ name, args });
      return { ok: true, action: name };
    },
    getTools: () => [{ type: 'function', name: 'fly_to_location', parameters: {} }],
    getContext: () => ({ camera: { latitude: 1, longitude: 2 } }),
    onStatus: (state, detail) => statuses.push({ state, detail }),
    onTranscript: (entry) => transcripts.push(entry),
    onSpeech: (event) => speech.push(event),
    ...overrides,
  });
  return { voice, calls, statuses, transcripts, executed, speech, played, media };
}

test('resolveLocalVoiceUrl prefers localStorage, then env, then default', () => {
  assert.equal(resolveLocalVoiceUrl({ storage: null, env: {} }), 'http://jetson:8008');
  assert.equal(
    resolveLocalVoiceUrl({ storage: null, env: { VITE_LOCAL_VOICE_URL: 'http://a:1/' } }),
    'http://a:1',
  );
  const storage = { getItem: (key) => (key === 'gevLocalVoiceUrl' ? 'http://b:2' : null) };
  assert.equal(
    resolveLocalVoiceUrl({ storage, env: { VITE_LOCAL_VOICE_URL: 'http://a:1' } }),
    'http://b:2',
  );
});

test('pickRecorderMimeType falls back through opus webm to mp4', () => {
  assert.equal(pickRecorderMimeType(FakeRecorder), 'audio/webm;codecs=opus');
  const safari = { isTypeSupported: (type) => type === 'audio/mp4' };
  assert.equal(pickRecorderMimeType(safari), 'audio/mp4');
  assert.equal(pickRecorderMimeType({}), '');
});

test('parseToolArguments accepts objects, JSON strings and garbage', () => {
  assert.deepEqual(parseToolArguments({ a: 1 }), { a: 1 });
  assert.deepEqual(parseToolArguments('{"query":"Tokyo"}'), { query: 'Tokyo' });
  assert.deepEqual(parseToolArguments('nope'), {});
  assert.deepEqual(parseToolArguments(null), {});
});

test('health check sets availability and reports unreachable servers', async () => {
  const up = harness({ '/v1/health': jsonResponse({ ok: true, whisper: 'base', model: 'llama', tts: false }) });
  assert.equal(await up.voice.init(), true);
  assert.equal(up.voice.isAvailable(), true);
  assert.equal(up.voice.getHealth().model, 'llama');

  const down = harness({});
  assert.equal(await down.voice.init(), false);
  assert.equal(down.voice.isAvailable(), false);
  assert.deepEqual(down.statuses.at(-1), {
    state: 'unavailable',
    detail: `local voice: server unreachable at ${BASE}`,
  });
});

test('record -> transcribe -> command -> tools in order -> tts playback', async () => {
  const h = harness({
    '/v1/health': jsonResponse({ ok: true }),
    '/v1/transcribe': (init) => {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'audio/webm;codecs=opus');
      assert.ok(init.body instanceof Blob);
      return jsonResponse({ text: 'take me to Tokyo and show flights' });
    },
    '/v1/command': (init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.text, 'take me to Tokyo and show flights');
      assert.equal(body.tools[0].name, 'fly_to_location');
      assert.deepEqual(body.context, { camera: { latitude: 1, longitude: 2 } });
      assert.deepEqual(body.history, []);
      return jsonResponse({
        tool_calls: [
          { name: 'fly_to_location', arguments: { query: 'Tokyo' } },
          { name: 'toggle_layer', arguments: '{"layerId":"flights","enabled":true}' },
        ],
        say: 'Heading to Tokyo with flights on.',
      });
    },
    '/v1/tts': audioResponse(),
  });
  assert.equal(await h.voice.startRecording(), true);
  assert.equal(h.voice.isRecording(), true);
  assert.equal(h.statuses.at(-1).state, 'listening');
  const result = await h.voice.stopRecording();
  assert.equal(h.voice.isRecording(), false);
  assert.equal(h.media.tracks[0].stopped, 1);
  assert.deepEqual(
    h.calls.map((call) => call.path),
    ['/v1/transcribe', '/v1/command', '/v1/tts'],
  );
  assert.deepEqual(h.executed, [
    { name: 'fly_to_location', args: { query: 'Tokyo' } },
    { name: 'toggle_layer', args: { layerId: 'flights', enabled: true } },
  ]);
  assert.equal(result.say, 'Heading to Tokyo with flights on.');
  assert.deepEqual(h.transcripts, [
    { role: 'you', text: 'take me to Tokyo and show flights' },
    { role: 'agent', text: 'Heading to Tokyo with flights on.' },
  ]);
  assert.deepEqual(h.played, ['blob:fake']);
  assert.deepEqual(h.speech.map((event) => event.phase), ['start', 'end']);
  const states = h.statuses.map((entry) => entry.state);
  assert.deepEqual(states, ['listening', 'transcribing', 'thinking', 'executing', 'executing', 'speaking', 'idle']);
  // Tool execution happens before TTS is requested.
  assert.ok(h.calls.findIndex((call) => call.path === '/v1/tts') > 1);
});

test('tts 503 falls back to text only', async () => {
  const h = harness({
    '/v1/command': jsonResponse({ tool_calls: [], say: 'No speech synthesis here.' }),
    '/v1/tts': jsonResponse({ error: 'no tts key' }, 503),
  });
  const result = await h.voice.submitText('hello');
  assert.equal(result.say, 'No speech synthesis here.');
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.speech, [{ phase: 'unavailable', text: 'No speech synthesis here.', status: 503 }]);
  assert.deepEqual(h.transcripts.at(-1), { role: 'agent', text: 'No speech synthesis here.' });
  assert.equal(h.statuses.at(-1).state, 'idle');
  assert.equal(h.statuses.at(-1).detail, 'No speech synthesis here.');
});

test('unreachable server during a turn surfaces a visible error status', async () => {
  const h = harness({});
  const result = await h.voice.submitText('anything');
  assert.equal(result, null);
  assert.deepEqual(h.statuses.at(-1), {
    state: 'error',
    detail: `local voice: server unreachable at ${BASE}`,
  });
  assert.deepEqual(h.executed, []);
  assert.equal(h.voice.isBusy(), false);
});

test('tool failures do not abort later tool calls and are reported', async () => {
  const h = harness(
    {
      '/v1/command': jsonResponse({
        tool_calls: [{ name: 'boom', arguments: {} }, { name: 'ok_tool', arguments: {} }],
        say: '',
      }),
    },
    {
      executeTool: async (name) => {
        if (name === 'boom') throw new Error('kaput');
        return { ok: true };
      },
    },
  );
  const result = await h.voice.submitText('do things');
  assert.deepEqual(result.toolCalls.map((call) => [call.name, call.ok]), [['boom', false], ['ok_tool', true]]);
  assert.equal(h.statuses.at(-1).detail, 'boom: kaput');
  assert.equal(h.calls.some((call) => call.path === '/v1/tts'), false);
});

test('history keeps the last 6 turns and is sent with each command', async () => {
  let turn = 0;
  const seenHistoryLengths = [];
  const h = harness({
    '/v1/command': (init) => {
      const body = JSON.parse(init.body);
      seenHistoryLengths.push(body.history.length);
      turn++;
      return jsonResponse({ tool_calls: [], say: `reply ${turn}` });
    },
    '/v1/tts': jsonResponse({}, 503),
  });
  for (let index = 1; index <= 9; index++) await h.voice.submitText(`utterance ${index}`);
  assert.deepEqual(seenHistoryLengths, [0, 2, 4, 6, 8, 10, 12, 12, 12]);
  const history = h.voice.getHistory();
  assert.equal(history.length, 12);
  assert.equal(history[0].content, 'utterance 4');
  assert.equal(history.at(-1).content, 'reply 9');
  assert.deepEqual(trimHistory([1, 2, 3, 4, 5], 2), [2, 3, 4, 5]);
});

test('empty transcription ends the turn without calling the model', async () => {
  const h = harness({ '/v1/transcribe': jsonResponse({ text: '   ' }) });
  await h.voice.startRecording();
  assert.equal(await h.voice.stopRecording(), null);
  assert.deepEqual(h.calls.map((call) => call.path), ['/v1/transcribe']);
  assert.equal(h.statuses.at(-1).detail, 'No speech detected');
});

test('summarizeViewState slims the view-state tool result', () => {
  const slim = summarizeViewState({
    camera: { latitude: 35.68123456, longitude: 139.7671, heightM: 1234.56 },
    style: 'normal',
    layers: [
      { id: 'flights', enabled: true },
      { id: 'vessels', enabled: false },
    ],
    tracked: [{ label: 'UAL1' }],
  });
  assert.deepEqual(slim, {
    camera: { latitude: 35.6812, longitude: 139.7671, heightM: 1235 },
    style: 'normal',
    enabledLayers: ['flights'],
    tracked: ['UAL1'],
    scenePlayback: null,
  });
  assert.deepEqual(summarizeViewState(null), {});
});

test('local-config route reports key presence without leaking it', async () => {
  const handler = createLocalVoiceConfigHandler({
    resolveApiKey: () => 'sk-secret',
    tools: [{ type: 'function', name: 'fly_to_location' }],
  });
  const headers = {};
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: (key, value) => (headers[key] = value),
    end: (chunk) => (body = chunk),
  };
  handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(headers['Cache-Control'], 'no-store');
  const parsed = JSON.parse(body);
  assert.equal(parsed.openaiConfigured, true);
  assert.equal(parsed.tools[0].name, 'fly_to_location');
  assert.equal(body.includes('sk-secret'), false);
  handler({ method: 'POST' }, res);
  assert.equal(res.statusCode, 405);
});
