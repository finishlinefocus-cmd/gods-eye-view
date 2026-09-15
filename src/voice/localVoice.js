/**
 * Local push-to-talk voice backend.
 *
 * Talks to a small HTTP service (Whisper + local LLM + optional TTS) instead of
 * OpenAI Realtime. The wire contract is fixed:
 *   GET  {base}/v1/health      -> { ok, whisper, model, tts }
 *   POST {base}/v1/transcribe  <- raw audio Blob (Content-Type = blob.type) -> { text }
 *   POST {base}/v1/command     <- { text, tools, context, history } -> { tool_calls:[{name, arguments}], say }
 *   POST {base}/v1/tts         <- { text } -> audio/mpeg (503 when no TTS is configured)
 *
 * This module is DOM-light on purpose: every browser dependency (fetch,
 * MediaRecorder, getUserMedia, Audio, URL, localStorage) is injectable so the
 * turn pipeline can be unit tested in Node.
 */

export const DEFAULT_LOCAL_VOICE_URL = 'http://jetson:8008';
export const LOCAL_VOICE_URL_STORAGE_KEY = 'gevLocalVoiceUrl';
export const LOCAL_VOICE_HISTORY_TURNS = 6;

const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

/** Resolve the service base URL: localStorage override, then Vite env, then default. */
export function resolveLocalVoiceUrl({ storage, env } = {}) {
  let stored = null;
  try {
    stored = storage?.getItem?.(LOCAL_VOICE_URL_STORAGE_KEY) || null;
  } catch {
    stored = null;
  }
  const raw = String(stored || env?.VITE_LOCAL_VOICE_URL || DEFAULT_LOCAL_VOICE_URL).trim();
  return raw.replace(/\/+$/, '');
}

/** Pick the first MediaRecorder container the browser supports (Safari lacks webm). */
export function pickRecorderMimeType(MediaRecorderImpl) {
  const supported = MediaRecorderImpl?.isTypeSupported;
  if (typeof supported !== 'function') return '';
  for (const candidate of RECORDER_MIME_CANDIDATES) {
    try {
      if (supported.call(MediaRecorderImpl, candidate)) return candidate;
    } catch {
      /* Try the next container. */
    }
  }
  return '';
}


/**
 * Minimal recorder for browsers without MediaRecorder (iOS Safari < 14.3):
 * Web Audio ScriptProcessor -> 16 kHz mono PCM -> WAV Blob. Same interface subset
 * the pipeline uses: start(), stop(), ondataavailable/onstop, state, mimeType.
 */
export function createWavRecorder(stream, AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext) {
  if (typeof AudioContextImpl !== 'function') return null;
  const ctx = new AudioContextImpl();
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const buffers = [];
  const rec = { state: 'inactive', mimeType: 'audio/wav', ondataavailable: null, onstop: null };
  proc.onaudioprocess = (e) => {
    if (rec.state !== 'recording') return;
    buffers.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  rec.start = () => {
    rec.state = 'recording';
    source.connect(proc);
    proc.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume?.();
  };
  rec.stop = () => {
    rec.state = 'inactive';
    try { source.disconnect(); proc.disconnect(); } catch { /* ignore */ }
    const inRate = ctx.sampleRate || 48000;
    const total = buffers.reduce((n, b) => n + b.length, 0);
    const mono = new Float32Array(total);
    let off = 0;
    for (const b of buffers) { mono.set(b, off); off += b.length; }
    // downsample to 16 kHz for Whisper
    const outRate = 16000;
    const ratio = inRate / outRate;
    const outLen = Math.floor(mono.length / ratio);
    const pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const v = Math.max(-1, Math.min(1, mono[Math.floor(i * ratio)] || 0));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const wav = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(wav);
    const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(wav, 44).set(pcm);
    const blob = new Blob([wav], { type: 'audio/wav' });
    try { ctx.close?.(); } catch { /* ignore */ }
    rec.ondataavailable?.({ data: blob });
    rec.onstop?.();
  };
  return rec;
}

/** Keep only the most recent `turns` user/assistant pairs. */
export function trimHistory(history, turns = LOCAL_VOICE_HISTORY_TURNS) {
  const limit = Math.max(0, turns) * 2;
  return history.length > limit ? history.slice(history.length - limit) : history;
}

/** Tool-call arguments may arrive as a JSON string; normalise to an object. */
export function parseToolArguments(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function viteEnv() {
  try {
    return import.meta.env || {};
  } catch {
    return {};
  }
}

function unreachableMessage(baseUrl) {
  return `local voice: server unreachable at ${baseUrl}`;
}

/**
 * @param {object} options
 * @param {(name: string, args: object) => Promise<any>} options.executeTool
 * @param {() => (object|Promise<object>)} [options.getContext]
 * @param {() => (Array|Promise<Array>)} [options.getTools]
 * @param {(state: string, detail?: string) => void} [options.onStatus]
 * @param {(entry: {role: 'you'|'agent', text: string}) => void} [options.onTranscript]
 * @param {(event: {phase: 'start'|'end'|'unavailable', text: string}) => void} [options.onSpeech]
 */
export function createLocalVoice({
  executeTool,
  getContext = () => ({}),
  getTools = () => [],
  onStatus = () => {},
  onTranscript = () => {},
  onSpeech = () => {},
  baseUrl,
  fetchImpl = (...args) => globalThis.fetch(...args),
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  createAudio = (url) => new globalThis.Audio(url),
  objectUrls = globalThis.URL,
  storage = globalThis.localStorage,
  env = viteEnv(),
  historyTurns = LOCAL_VOICE_HISTORY_TURNS,
  requestTimeoutMs = 60_000,
} = {}) {
  if (typeof executeTool !== 'function')
    throw new TypeError('createLocalVoice requires executeTool(name, args)');

  const url = baseUrl ? String(baseUrl).replace(/\/+$/, '') : resolveLocalVoiceUrl({ storage, env });
  const history = [];
  let health = null;
  let available = false;
  let recorder = null;
  let stream = null;
  let chunks = [];
  let busy = false;
  let toolsCache = null;
  let disposed = false;
  let currentAudio = null;

  const status = (state, detail) => {
    try {
      onStatus(state, detail);
    } catch {
      /* Observers cannot break a turn. */
    }
  };
  const transcript = (role, text) => {
    try {
      onTranscript({ role, text });
    } catch {
      /* Observers cannot break a turn. */
    }
  };

  function request(path, init = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    return fetchImpl(url + path, {
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function fetchJson(path, init) {
    let response;
    try {
      response = await request(path, init);
    } catch (error) {
      const failure = new Error(unreachableMessage(url));
      failure.cause = error;
      failure.unreachable = true;
      throw failure;
    }
    if (!response.ok) {
      const failure = new Error(`local voice: ${path} failed (${response.status})`);
      failure.status = response.status;
      throw failure;
    }
    return response.json();
  }

  async function checkHealth() {
    try {
      health = await fetchJson('/v1/health', { method: 'GET' });
      available = Boolean(health?.ok);
    } catch (error) {
      health = null;
      available = false;
      status('unavailable', error.unreachable ? unreachableMessage(url) : error.message);
    }
    return available;
  }

  async function resolveTools() {
    if (toolsCache) return toolsCache;
    const tools = await getTools();
    toolsCache = Array.isArray(tools) ? tools : [];
    return toolsCache;
  }

  async function safeContext() {
    try {
      const context = await getContext();
      return context && typeof context === 'object' ? context : {};
    } catch {
      return {};
    }
  }

  async function speak(text) {
    if (!text) return;
    let response;
    try {
      response = await request('/v1/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch {
      onSpeech({ phase: 'unavailable', text });
      return;
    }
    if (!response.ok) {
      // 503 = no TTS key on the server. The text is already on screen.
      onSpeech({ phase: 'unavailable', text, status: response.status });
      return;
    }
    let blob;
    try {
      blob = await response.blob();
    } catch {
      onSpeech({ phase: 'unavailable', text });
      return;
    }
    if (!objectUrls?.createObjectURL) {
      onSpeech({ phase: 'unavailable', text });
      return;
    }
    const objectUrl = objectUrls.createObjectURL(blob);
    onSpeech({ phase: 'start', text });
    status('speaking', text);
    try {
      await new Promise((resolve) => {
        let audio;
        try {
          audio = createAudio(objectUrl);
        } catch {
          resolve();
          return;
        }
        currentAudio = audio;
        const done = () => {
          if (currentAudio === audio) currentAudio = null;
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        try {
          const played = audio.play?.();
          if (played && typeof played.catch === 'function') played.catch(done);
        } catch {
          done();
        }
      });
    } finally {
      try {
        objectUrls.revokeObjectURL?.(objectUrl);
      } catch {
        /* Best effort. */
      }
      onSpeech({ phase: 'end', text });
    }
  }

  /** Run one text turn: /v1/command -> tool calls in order -> optional TTS. */
  async function runCommand(text) {
    const clean = String(text || '').trim();
    if (!clean) return { text: '', toolCalls: [], say: '' };
    transcript('you', clean);
    status('thinking', `you: ${clean}`);
    const [tools, context] = await Promise.all([resolveTools(), safeContext()]);
    const body = { text: clean, tools, context, history: [...history] };
    const reply = await fetchJson('/v1/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const toolCalls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : [];
    const results = [];
    for (const call of toolCalls) {
      const name = String(call?.name || '').trim();
      if (!name) continue;
      const args = parseToolArguments(call.arguments);
      status('executing', name);
      try {
        const result = await executeTool(name, args);
        results.push({ name, ok: result?.ok !== false, result });
      } catch (error) {
        results.push({ name, ok: false, error: error?.message || String(error) });
      }
    }
    const say = typeof reply?.say === 'string' ? reply.say.trim() : '';
    history.push({ role: 'user', content: clean });
    history.push({
      role: 'assistant',
      content: say,
      ...(results.length ? { tool_calls: results.map(({ name, ok }) => ({ name, ok })) } : {}),
    });
    const trimmed = trimHistory(history, historyTurns);
    if (trimmed !== history) history.splice(0, history.length - trimmed.length);
    if (say) {
      transcript('agent', say);
      await speak(say);
    }
    const failed = results.find((entry) => !entry.ok);
    status('idle', failed ? `${failed.name}: ${failed.error || 'failed'}` : say || 'Done');
    return { text: clean, toolCalls: results, say };
  }

  async function submitText(text) {
    if (busy || disposed) return null;
    busy = true;
    try {
      return await runCommand(text);
    } catch (error) {
      status('error', error.unreachable ? unreachableMessage(url) : error.message);
      return null;
    } finally {
      busy = false;
    }
  }

  async function transcribe(blob) {
    if (!blob || !blob.size) return '';
    const reply = await fetchJson('/v1/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
    return typeof reply?.text === 'string' ? reply.text.trim() : '';
  }

  async function processAudio(blob) {
    busy = true;
    try {
      status('transcribing', 'Transcribing…');
      const text = await transcribe(blob);
      if (!text) {
        status('idle', 'No speech detected');
        return null;
      }
      return await runCommand(text);
    } catch (error) {
      status('error', error.unreachable ? unreachableMessage(url) : error.message);
      return null;
    } finally {
      busy = false;
    }
  }

  function releaseStream() {
    try {
      stream?.getTracks?.().forEach((track) => track.stop());
    } catch {
      /* Best effort. */
    }
    stream = null;
  }

  async function startRecording() {
    if (disposed || busy || recorder) return false;
    const hasMediaRecorder = typeof MediaRecorderImpl === 'function';
    const hasAudioContext = typeof (globalThis.AudioContext || globalThis.webkitAudioContext) === 'function';
    if (!mediaDevices?.getUserMedia || (!hasMediaRecorder && !hasAudioContext)) {
      status('error', 'local voice: microphone recording is not supported in this browser (needs HTTPS and a modern Safari/Chrome)');
      return false;
    }
    try {
      stream = await mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      status('error', `local voice: microphone permission denied (${error?.message || error})`);
      return false;
    }
    const mimeType = hasMediaRecorder ? pickRecorderMimeType(MediaRecorderImpl) : '';
    try {
      if (hasMediaRecorder) {
        recorder = mimeType ? new MediaRecorderImpl(stream, { mimeType }) : new MediaRecorderImpl(stream);
      } else {
        recorder = createWavRecorder(stream);
        if (!recorder) throw new Error('no AudioContext');
      }
    } catch (error) {
      releaseStream();
      status('error', `local voice: recorder failed (${error?.message || error})`);
      return false;
    }
    chunks = [];
    recorder.ondataavailable = (event) => {
      if (event?.data && event.data.size > 0) chunks.push(event.data);
    };
    try {
      recorder.start();
    } catch (error) {
      recorder = null;
      releaseStream();
      status('error', `local voice: recorder failed (${error?.message || error})`);
      return false;
    }
    status('listening', 'Listening (local)…');
    return true;
  }

  function finishRecorder() {
    const active = recorder;
    if (!active) return Promise.resolve(null);
    recorder = null;
    return new Promise((resolve) => {
      active.onstop = () => {
        const type = active.mimeType || chunks[0]?.type || 'audio/webm';
        const blob = chunks.length ? new Blob(chunks, { type }) : null;
        chunks = [];
        releaseStream();
        resolve(blob);
      };
      try {
        if (active.state === 'inactive') active.onstop();
        else active.stop();
      } catch {
        chunks = [];
        releaseStream();
        resolve(null);
      }
    });
  }

  async function stopRecording() {
    if (!recorder) return null;
    const blob = await finishRecorder();
    if (!blob) {
      status('idle', 'No audio captured');
      return null;
    }
    return processAudio(blob);
  }

  async function cancelRecording() {
    if (!recorder) return;
    await finishRecorder();
    status('idle', 'Cancelled');
  }

  function dispose() {
    disposed = true;
    if (recorder) void finishRecorder();
    try {
      currentAudio?.pause?.();
    } catch {
      /* Best effort. */
    }
    currentAudio = null;
  }

  return {
    baseUrl: url,
    init: checkHealth,
    checkHealth,
    isAvailable: () => available && !disposed,
    getHealth: () => health,
    isRecording: () => Boolean(recorder),
    isBusy: () => busy,
    startRecording,
    stopRecording,
    cancelRecording,
    submitText,
    processAudio,
    getHistory: () => history.map((entry) => ({ ...entry })),
    clearHistory: () => history.splice(0, history.length),
    dispose,
  };
}
