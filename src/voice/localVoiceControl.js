/**
 * Binds the local push-to-talk backend to the existing GEV MIC control.
 *
 * Isolated from the OpenAI Realtime path: when the local service is healthy a
 * LOCAL toggle appears in the voice heading. With LOCAL on (automatic when no
 * OpenAI key is configured on the server) the mic button and the Space key
 * drive push-to-talk against the local service; the Realtime controller sees
 * `defaultPrevented` Space events and stays out of the way.
 */
import { createLocalVoice } from './localVoice.js';
import { createActionTools } from './actionSchemas.js';
import {
  PUSH_TO_TALK_HOLD_DELAY_MS,
  shouldHandlePushToTalkKeyDown,
  isInteractiveSpaceTarget,
} from './realtimeController.js';

export const LOCAL_VOICE_CONFIG_ENDPOINT = '/api/voice/local-config';
export const LOCAL_VOICE_MODE_STORAGE_KEY = 'gevLocalVoiceMode';

const STATUS_LABEL = {
  idle: 'LOCAL',
  listening: 'LISTENING',
  transcribing: 'THINKING',
  thinking: 'THINKING',
  executing: 'EXECUTING',
  speaking: 'SPEAKING',
  error: 'ERROR',
};

/** Slim the get_current_view_state payload to what a small local model needs. */
export function summarizeViewState(state) {
  if (!state || typeof state !== 'object') return {};
  const camera = state.camera || {};
  const layers = Array.isArray(state.layers) ? state.layers : [];
  return {
    camera: {
      latitude: round(camera.latitude, 4),
      longitude: round(camera.longitude, 4),
      heightM: round(camera.heightM, 0),
    },
    style: state.style || null,
    enabledLayers: layers.filter((layer) => layer.enabled).map((layer) => layer.id),
    tracked: Array.isArray(state.tracked)
      ? state.tracked.slice(0, 5).map((entry) => entry?.label || entry?.id || entry).filter(Boolean)
      : [],
    scenePlayback: state.scenePlayback || null,
  };
}

function round(value, digits) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/** Fetch server-side tool descriptions + key status; degrade to bare schemas. */
export async function loadLocalVoiceConfig(fetchImpl = (...args) => globalThis.fetch(...args)) {
  try {
    const response = await fetchImpl(LOCAL_VOICE_CONFIG_ENDPOINT, { cache: 'no-store' });
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body?.tools) && body.tools.length) {
        return { tools: body.tools, openaiConfigured: Boolean(body.openaiConfigured) };
      }
    }
  } catch {
    /* Static hosting or preview without the plugin: fall through. */
  }
  return { tools: createActionTools(), openaiConfigured: true };
}

/**
 * @param {object} options
 * @param {object} options.ui  control.js surface (button, status, detail, localButton, root, helpDetail)
 * @param {(name: string, args: object, runOptions?: object) => Promise<any>} options.runner
 * @param {{ isActive: () => boolean, stop: Function }} options.session
 * @param {AbortSignal} [options.signal]
 */
export function attachLocalVoiceControl({
  ui,
  runner,
  session,
  signal,
  createBackend = createLocalVoice,
  loadConfig = loadLocalVoiceConfig,
  storage = globalThis.localStorage,
  windowRef = globalThis.window,
  documentRef = globalThis.document,
} = {}) {
  if (!ui?.button || typeof runner !== 'function') return null;
  const localButton = ui.localButton || null;
  let enabled = false;
  let openaiConfigured = true;
  let configPromise = null;
  let disposed = false;
  let transcriptLog = [];
  let pointerDownAt = 0;
  let stopOnPointerUp = false;
  let spaceHeld = false;
  let spaceTimer = null;

  const configTools = async () => {
    configPromise ||= loadConfig();
    return (await configPromise).tools;
  };

  const backend = createBackend({
    executeTool: (name, args) => runner(name, args, {}),
    getTools: configTools,
    getContext: async () => {
      try {
        return summarizeViewState(await runner('get_current_view_state', {}, {}));
      } catch {
        return {};
      }
    },
    onStatus: renderStatus,
    onTranscript: renderTranscript,
    onSpeech: () => {},
    storage,
  });

  function readStoredMode() {
    try {
      const value = storage?.getItem?.(LOCAL_VOICE_MODE_STORAGE_KEY);
      return value == null ? null : value === '1';
    } catch {
      return null;
    }
  }

  function writeStoredMode(value) {
    try {
      storage?.setItem?.(LOCAL_VOICE_MODE_STORAGE_KEY, value ? '1' : '0');
    } catch {
      /* Private mode. */
    }
  }

  function renderStatus(state, detail) {
    if (disposed) return;
    if (state === 'unavailable') {
      // Health check failed at init: keep the OpenAI surface untouched.
      if (enabled && ui.detail) ui.detail.textContent = detail || 'Local voice unavailable';
      return;
    }
    if (!enabled) return;
    ui.root.dataset.status = state === 'transcribing' || state === 'thinking' ? 'executing' : state;
    ui.root.dataset.localVoice = 'on';
    if (ui.status) ui.status.textContent = STATUS_LABEL[state] || STATUS_LABEL.idle;
    const text = detail || (state === 'idle' ? 'Local voice ready' : state);
    if (ui.detail) {
      ui.detail.textContent = text;
      ui.detail.title = text;
    }
    ui.button.setAttribute('aria-pressed', String(backend.isRecording()));
    if (ui.errorDetail) ui.errorDetail.textContent = state === 'error' ? text : '';
    if (state === 'error') ui.root.classList?.remove?.('error-dismissed');
  }

  function renderTranscript(entry) {
    if (disposed || !enabled) return;
    transcriptLog = [...transcriptLog.slice(-11), entry];
    if (ui.detail) {
      const line = `${entry.role}: ${entry.text}`;
      ui.detail.textContent = line;
      ui.detail.title = line;
    }
    ui.root.dispatchEvent?.(
      new CustomEvent('gev-local-voice-transcript', { detail: entry, bubbles: true }),
    );
  }

  function applyMode(next) {
    enabled = Boolean(next);
    if (localButton) localButton.setAttribute('aria-pressed', String(enabled));
    if (ui.root) {
      if (enabled) ui.root.dataset.localVoice = 'on';
      else delete ui.root.dataset.localVoice;
    }
    if (enabled) {
      if (session?.isActive?.()) session.stop();
      ui.button.title = 'Local voice (Whisper + Ollama on jetson)';
      ui.button.setAttribute(
        'aria-label',
        'Local voice — click to start/stop recording; hold Space to speak',
      );
      if (ui.helpDetail) ui.helpDetail.textContent = 'LOCAL · click or hold Space to speak · release to send';
      renderStatus('idle', `Local voice ready · ${backend.baseUrl}`);
    } else {
      ui.button.removeAttribute('title');
      ui.button.setAttribute(
        'aria-label',
        'Voice control — activate to toggle voice; hold Space to speak',
      );
      if (ui.helpDetail) ui.helpDetail.textContent = 'Hold Space to speak · tap Space to activate focused controls';
      if (!backend.isRecording()) {
        ui.root.dataset.status = 'idle';
        if (ui.status) ui.status.textContent = 'OFF';
        if (ui.detail) ui.detail.textContent = 'VOICE STANDBY';
      }
    }
  }

  function toggleMode() {
    if (!backend.isAvailable()) return;
    if (enabled && backend.isRecording()) void backend.cancelRecording();
    applyMode(!enabled);
    writeStoredMode(enabled);
  }

  // Mic button: hold (>= delay) to talk, or click to toggle recording.
  const onPointerDown = (event) => {
    if (!enabled || (event.button != null && event.button !== 0)) return;
    if (backend.isRecording()) {
      stopOnPointerUp = true;
      return;
    }
    stopOnPointerUp = false;
    pointerDownAt = Date.now();
    void backend.startRecording();
  };
  const onPointerUp = () => {
    if (!enabled) return;
    if (stopOnPointerUp || Date.now() - pointerDownAt >= PUSH_TO_TALK_HOLD_DELAY_MS) {
      stopOnPointerUp = false;
      void backend.stopRecording();
    }
  };

  // Space: window-capture so the Realtime controller sees defaultPrevented.
  const onKeyDown = (event) => {
    if (!enabled || !shouldHandlePushToTalkKeyDown(event)) return;
    if (isInteractiveSpaceTarget(documentRef?.activeElement)) return;
    event.preventDefault();
    if (event.repeat || spaceHeld) return;
    spaceHeld = true;
    clearTimeout(spaceTimer);
    spaceTimer = setTimeout(() => {
      spaceTimer = null;
      if (spaceHeld && !backend.isRecording()) void backend.startRecording();
    }, PUSH_TO_TALK_HOLD_DELAY_MS);
  };
  const onKeyUp = (event) => {
    if (!enabled || !(event.code === 'Space' || event.key === ' ')) return;
    if (!spaceHeld) return;
    spaceHeld = false;
    event.preventDefault();
    if (spaceTimer) {
      // Tap: toggle recording instead of a hold.
      clearTimeout(spaceTimer);
      spaceTimer = null;
      if (backend.isRecording()) void backend.stopRecording();
      else void backend.startRecording();
      return;
    }
    if (backend.isRecording()) void backend.stopRecording();
  };

  ui.button.addEventListener?.('pointerdown', onPointerDown);
  ui.button.addEventListener?.('pointerup', onPointerUp);
  ui.button.addEventListener?.('pointercancel', onPointerUp);
  localButton?.addEventListener?.('click', toggleMode);
  windowRef?.addEventListener?.('keydown', onKeyDown, true);
  windowRef?.addEventListener?.('keyup', onKeyUp, true);

  const ready = (async () => {
    const [available, config] = await Promise.all([
      backend.init(),
      (configPromise ||= loadConfig()),
    ]);
    if (disposed) return false;
    openaiConfigured = config.openaiConfigured;
    if (!available) {
      if (localButton) localButton.hidden = true;
      // No local service and no OpenAI key: the mic would fail either way;
      // say why in the readout so the operator knows what to start.
      if (!openaiConfigured && ui.detail)
        ui.detail.textContent = `No OpenAI key · local voice offline (${backend.baseUrl})`;
      return false;
    }
    if (localButton) {
      localButton.hidden = false;
      localButton.title = `Local voice (Whisper + Ollama) · ${backend.baseUrl}`;
    }
    const stored = readStoredMode();
    applyMode(stored == null ? !openaiConfigured : stored);
    return true;
  })();

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(spaceTimer);
    ui.button.removeEventListener?.('pointerdown', onPointerDown);
    ui.button.removeEventListener?.('pointerup', onPointerUp);
    ui.button.removeEventListener?.('pointercancel', onPointerUp);
    localButton?.removeEventListener?.('click', toggleMode);
    windowRef?.removeEventListener?.('keydown', onKeyDown, true);
    windowRef?.removeEventListener?.('keyup', onKeyUp, true);
    backend.dispose();
  }
  signal?.addEventListener?.('abort', dispose, { once: true });

  return {
    backend,
    ready,
    dispose,
    isEnabled: () => enabled,
    /** True while local mode owns the mic button (suppresses the Realtime click handler). */
    handlesButton: () => enabled,
    setEnabled: (value) => {
      if (Boolean(value) !== enabled) toggleMode();
    },
    submitText: (text) => backend.submitText(text),
    getTranscript: () => [...transcriptLog],
    isOpenAiConfigured: () => openaiConfigured,
  };
}
