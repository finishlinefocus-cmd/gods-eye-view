/**
 * @module corridor/card
 * @description The clicked-feature card for the corridor layer: a small
 * floating panel that shows an alert, incident, vehicle, gauge (with a 24 h
 * sparkline), air-quality area, or a traffic-camera still refreshed on a
 * cadence. One card exists per layer instance; it is created lazily and
 * removed on destroy.
 */
export const CAMERA_FRAME_REFRESH_MS = 15000;

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );

const fmtTime = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || '—';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * Draw a sparkline of {t, v} points onto a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{t:number,v:number}>} points
 * @param {string} color
 */
export function drawSparkline(canvas, points, color = '#3fb0ff') {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  if (!points || points.length < 2) {
    ctx.fillStyle = 'rgba(232,234,237,0.4)';
    ctx.font = '10px monospace';
    ctx.fillText('no 24 h series', 6, height / 2);
    return;
  }
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tSpan = t1 - t0 || 1;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = 4 + ((p.t - t0) / tSpan) * (width - 8);
    const y = height - 6 - ((p.v - min) / span) * (height - 12);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(232,234,237,0.55)';
  ctx.font = '9px monospace';
  ctx.fillText(max.toFixed(2), 4, 10);
  ctx.fillText(min.toFixed(2), 4, height - 1);
}

/** Markup for each record kind. Returns { title, meta, body } strings. */
export function cardContent(kind, record) {
  const e = escapeHtml;
  switch (kind) {
    case 'alert':
      return {
        title: e(record.event),
        meta: `${e(record.severity)} · ${e(record.sender)}`,
        body:
          `<p>${e(record.headline)}</p>` +
          `<p class="corridor-card-dim">${e(record.areaDesc)}</p>` +
          `<p>Expires ${e(fmtTime(record.expires))}</p>`,
      };
    case 'incident':
      return {
        title: e(record.subtype || record.type || 'Incident'),
        meta: `${e(record.source)}${record.direction ? ' · ' + e(record.direction) : ''}${record.closure ? ' · CLOSURE' : ''}`,
        body:
          `<p>${e(record.description)}</p>` +
          (record.impact
            ? `<p class="corridor-card-dim">${e(record.impact)}</p>`
            : '') +
          `<p>Updated ${e(fmtTime(record.updatedAt))}</p>`,
      };
    case 'transit':
      return {
        title: `${e(record.agencyName || record.agency)} · route ${e(record.routeId || '?')}`,
        meta: e(record.destination || record.label || record.id),
        body:
          `<p>Heading ${Number.isFinite(record.heading) ? Math.round(record.heading) + '°' : '—'}` +
          (Number.isFinite(record.speedMph)
            ? ` · ${Math.round(record.speedMph)} mph`
            : '') +
          `</p>`,
      };
    case 'gauge':
      return {
        title: e(record.name),
        meta: `${e(record.lid)}${record.usgsId ? ' · USGS ' + e(record.usgsId) : ''} · ${e(record.floodCategory.replaceAll('_', ' '))}`,
        body:
          `<p>Stage ${record.stage ?? '—'} ${e(record.stageUnit)}` +
          (record.flow !== null && record.flow !== undefined
            ? ` · Flow ${record.flow} ${e(record.flowUnit)}`
            : '') +
          `</p><p class="corridor-card-dim">Observed ${e(fmtTime(record.observedAt))}</p>` +
          `<canvas class="corridor-card-spark" width="260" height="60" aria-label="24 hour stage"></canvas>`,
      };
    case 'air':
      return {
        title: `${e(record.name)} · AQI ${record.worstAqi}`,
        meta: `${e(record.worstCategory)} · ${e(record.worstParameter)} · AirNow / US EPA`,
        body:
          '<ul class="corridor-card-list">' +
          record.readings
            .map(
              (r) => `<li>${e(r.parameter)} ${r.aqi} · ${e(r.category)}</li>`,
            )
            .join('') +
          `</ul><p class="corridor-card-dim">${e(record.observedAt)}</p>`,
      };
    case 'camera':
      return {
        title: e(record.name || record.id),
        meta: `${e(record.source)}${record.roadway ? ' · ' + e(record.roadway) : ''}${record.direction ? ' ' + e(record.direction) : ''}`,
        body:
          `<div class="corridor-card-frame"><img alt="Traffic camera still" /></div>` +
          `<p class="corridor-card-dim">Still refreshes every ${CAMERA_FRAME_REFRESH_MS / 1000} s</p>`,
      };
    default:
      return { title: e(kind), meta: '', body: '' };
  }
}

/** Create the card controller bound to a document. */
export function createCorridorCard({
  documentRef = globalThis.document,
  onClose,
} = {}) {
  let root = null;
  let frameTimer = null;
  let current = null;

  function ensure() {
    if (root || !documentRef) return root;
    root = documentRef.createElement('aside');
    root.className = 'corridor-card';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Corridor feature');
    root.innerHTML =
      '<header class="corridor-card-head"><div><h3 class="corridor-card-title"></h3><div class="corridor-card-meta"></div></div>' +
      '<button type="button" class="corridor-card-close" aria-label="Close">×</button></header>' +
      '<div class="corridor-card-body"></div>';
    root
      .querySelector('.corridor-card-close')
      .addEventListener('click', () => hide());
    documentRef.body.appendChild(root);
    return root;
  }

  function stopFrames() {
    if (frameTimer) clearInterval(frameTimer);
    frameTimer = null;
  }

  /**
   * Show a record. `extras.frameUrl(bust)` supplies camera stills;
   * `extras.series` is a promise of { series: { points, unit } } for gauges.
   */
  function show(kind, record, extras = {}) {
    const node = ensure();
    if (!node) return;
    stopFrames();
    current = { kind, id: record?.id ?? record?.lid ?? null };
    const { title, meta, body } = cardContent(kind, record);
    node.querySelector('.corridor-card-title').innerHTML = title;
    node.querySelector('.corridor-card-meta').innerHTML = meta;
    node.querySelector('.corridor-card-body').innerHTML = body;
    node.dataset.kind = kind;
    node.style.setProperty(
      '--corridor-card-accent',
      extras.accent || '#9ad0ff',
    );
    node.hidden = false;
    if (kind === 'camera' && typeof extras.frameUrl === 'function') {
      const img = node.querySelector('img');
      const load = () => {
        const url = extras.frameUrl(Date.now());
        if (url) img.src = url;
      };
      img.addEventListener('error', () => img.classList.add('is-broken'));
      img.addEventListener('load', () => img.classList.remove('is-broken'));
      load();
      frameTimer = setInterval(load, CAMERA_FRAME_REFRESH_MS);
    }
    if (kind === 'gauge' && extras.series?.then) {
      const token = current;
      extras.series
        .then((payload) => {
          if (current !== token || !root || root.hidden) return;
          const canvas = root.querySelector('canvas');
          drawSparkline(canvas, payload?.series?.points || [], extras.accent);
        })
        .catch(() => {
          if (current !== token || !root) return;
          drawSparkline(root.querySelector('canvas'), []);
        });
    }
  }

  function hide() {
    stopFrames();
    current = null;
    if (root) root.hidden = true;
    onClose?.();
  }

  function destroy() {
    stopFrames();
    current = null;
    root?.remove();
    root = null;
  }

  return {
    show,
    hide,
    destroy,
    isOpen: () => Boolean(root && !root.hidden),
    currentId: () => current?.id ?? null,
  };
}
