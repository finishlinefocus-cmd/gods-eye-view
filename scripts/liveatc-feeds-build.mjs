#!/usr/bin/env node
/**
 * Build src/layers/atc/liveatcFeeds.js — the curated LiveATC feed directory for
 * the ATC Radio layer.
 *
 * For each airport in AIRPORTS the script loads the public LiveATC airport page
 * (https://www.liveatc.net/search/?icao=<ICAO>) once, parses every feed block
 * (mount name, human label, page "Feed Status", published frequencies), then
 * probes each mount's stream (https://d.liveatc.net/<mount>, following the
 * redirect to the sN-xxx edge host) and records whether it answered with audio.
 *
 * LiveATC etiquette (do not loosen):
 *   - at most one request per second (pages far slower), sequential, desktop user agent;
 *   - one page load per airport, one short stream probe per mount;
 *   - never run at application runtime — the output is committed.
 *
 * The airport page sits behind a Cloudflare managed challenge that plain HTTP
 * clients cannot pass, so pages are loaded through headless Chrome (puppeteer,
 * already a devDependency). Stream probes use plain Node https.
 *
 * Usage:
 *   node scripts/liveatc-feeds-build.mjs            # full rebuild
 *   node scripts/liveatc-feeds-build.mjs KSFO KLAX  # subset (still rewrites file)
 *   LIVEATC_PAGE_CACHE=dir node scripts/liveatc-feeds-build.mjs
 *       reuse/save raw pages under dir (reruns without refetching)
 *   LIVEATC_CACHE_ONLY=1 LIVEATC_SKIP_PROBES=1 ... (offline: parse the cache, no probes)
 *   LIVEATC_REPROBE_OFFLINE=1 ... (keep mounts already online, re-probe the rest)
 *   LIVEATC_MERGE=1 node scripts/liveatc-feeds-build.mjs KCHA
 *       subset run that KEEPS every other airport's committed feeds (one new
 *       airport = one page load + its probes, nothing else is refetched)
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyFeedKind } from '../src/layers/atc/feedKinds.js';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'layers',
  'atc',
  'liveatcFeeds.js',
);
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const REQUEST_INTERVAL_MS = 1100;
// Airport pages sit behind Cloudflare; four page loads in four seconds earned
// an outright block ("Attention Required"), so pages are paced far slower than
// the 1 req/s ceiling and a block triggers a long back-off before one retry.
const PAGE_INTERVAL_MS = 30000;
const BLOCK_BACKOFFS_MS = [300000, 600000];
const PROBE_TIMEOUT_MS = 5000;

/** Curated major US airports: ICAO, name, WGS84 lat/lon and field elevation (ft MSL). */
export const AIRPORTS = Object.freeze([
  {
    icao: 'KSFO',
    name: 'San Francisco International',
    lat: 37.6213,
    lon: -122.379,
    elevationFt: 13,
  },
  {
    icao: 'KLAX',
    name: 'Los Angeles International',
    lat: 33.9425,
    lon: -118.4081,
    elevationFt: 128,
  },
  {
    icao: 'KJFK',
    name: 'New York John F. Kennedy International',
    lat: 40.6413,
    lon: -73.7781,
    elevationFt: 13,
  },
  {
    icao: 'KLGA',
    name: 'New York LaGuardia',
    lat: 40.7769,
    lon: -73.874,
    elevationFt: 21,
  },
  {
    icao: 'KEWR',
    name: 'Newark Liberty International',
    lat: 40.6895,
    lon: -74.1745,
    elevationFt: 18,
  },
  {
    icao: 'KORD',
    name: "Chicago O'Hare International",
    lat: 41.9742,
    lon: -87.9073,
    elevationFt: 672,
  },
  {
    icao: 'KATL',
    name: 'Atlanta Hartsfield-Jackson International',
    lat: 33.6407,
    lon: -84.4277,
    elevationFt: 1026,
  },
  {
    icao: 'KCHA',
    name: 'Chattanooga Metropolitan (Lovell Field)',
    lat: 35.0353,
    lon: -85.2038,
    elevationFt: 683,
  },
  {
    icao: 'KDAB',
    name: 'Daytona Beach International',
    lat: 29.1799,
    lon: -81.0581,
    elevationFt: 34,
  },
  {
    icao: 'KDFW',
    name: 'Dallas/Fort Worth International',
    lat: 32.8998,
    lon: -97.0403,
    elevationFt: 607,
  },
  {
    icao: 'KDEN',
    name: 'Denver International',
    lat: 39.8561,
    lon: -104.6737,
    elevationFt: 5434,
  },
  {
    icao: 'KSEA',
    name: 'Seattle-Tacoma International',
    lat: 47.4502,
    lon: -122.3088,
    elevationFt: 433,
  },
  {
    icao: 'KPHX',
    name: 'Phoenix Sky Harbor International',
    lat: 33.4373,
    lon: -112.0078,
    elevationFt: 1135,
  },
  {
    icao: 'KLAS',
    name: 'Las Vegas Harry Reid International',
    lat: 36.084,
    lon: -115.1537,
    elevationFt: 2181,
  },
  {
    icao: 'KMIA',
    name: 'Miami International',
    lat: 25.7959,
    lon: -80.287,
    elevationFt: 9,
  },
  {
    icao: 'KBOS',
    name: 'Boston Logan International',
    lat: 42.3656,
    lon: -71.0096,
    elevationFt: 20,
  },
  {
    icao: 'KIAD',
    name: 'Washington Dulles International',
    lat: 38.9531,
    lon: -77.4565,
    elevationFt: 313,
  },
  {
    icao: 'KDCA',
    name: 'Washington Reagan National',
    lat: 38.8512,
    lon: -77.0402,
    elevationFt: 15,
  },
  {
    icao: 'KMSP',
    name: 'Minneapolis-St. Paul International',
    lat: 44.8848,
    lon: -93.2223,
    elevationFt: 841,
  },
  {
    icao: 'KDTW',
    name: 'Detroit Metropolitan Wayne County',
    lat: 42.2162,
    lon: -83.3554,
    elevationFt: 645,
  },
  {
    icao: 'KCLT',
    name: 'Charlotte Douglas International',
    lat: 35.214,
    lon: -80.9431,
    elevationFt: 748,
  },
  {
    icao: 'KPHL',
    name: 'Philadelphia International',
    lat: 39.8744,
    lon: -75.2424,
    elevationFt: 36,
  },
  {
    icao: 'KSAN',
    name: 'San Diego International',
    lat: 32.7338,
    lon: -117.1933,
    elevationFt: 17,
  },
  {
    icao: 'KSLC',
    name: 'Salt Lake City International',
    lat: 40.7899,
    lon: -111.9791,
    elevationFt: 4227,
  },
  {
    icao: 'KIAH',
    name: 'Houston George Bush Intercontinental',
    lat: 29.9902,
    lon: -95.3368,
    elevationFt: 97,
  },
  {
    icao: 'KHOU',
    name: 'Houston William P. Hobby',
    lat: 29.6454,
    lon: -95.2789,
    elevationFt: 46,
  },
  {
    icao: 'KMCO',
    name: 'Orlando International',
    lat: 28.4312,
    lon: -81.3081,
    elevationFt: 96,
  },
  {
    icao: 'KTPA',
    name: 'Tampa International',
    lat: 27.9755,
    lon: -82.5332,
    elevationFt: 26,
  },
  {
    icao: 'KBWI',
    name: 'Baltimore/Washington International',
    lat: 39.1774,
    lon: -76.6684,
    elevationFt: 146,
  },
  {
    icao: 'KMDW',
    name: 'Chicago Midway International',
    lat: 41.7868,
    lon: -87.7522,
    elevationFt: 620,
  },
  {
    icao: 'KSTL',
    name: 'St. Louis Lambert International',
    lat: 38.7499,
    lon: -90.3748,
    elevationFt: 618,
  },
  {
    icao: 'KBNA',
    name: 'Nashville International',
    lat: 36.1263,
    lon: -86.6774,
    elevationFt: 599,
  },
  {
    icao: 'KAUS',
    name: 'Austin-Bergstrom International',
    lat: 30.1975,
    lon: -97.6664,
    elevationFt: 542,
  },
  {
    icao: 'KPDX',
    name: 'Portland International',
    lat: 45.5898,
    lon: -122.5951,
    elevationFt: 31,
  },
  {
    icao: 'KSJC',
    name: 'San Jose Mineta International',
    lat: 37.3639,
    lon: -121.9289,
    elevationFt: 62,
  },
  {
    icao: 'KOAK',
    name: 'Oakland International',
    lat: 37.7126,
    lon: -122.2197,
    elevationFt: 9,
  },
  {
    icao: 'KSMF',
    name: 'Sacramento International',
    lat: 38.6954,
    lon: -121.5908,
    elevationFt: 27,
  },
  {
    icao: 'KRDU',
    name: 'Raleigh-Durham International',
    lat: 35.8801,
    lon: -78.788,
    elevationFt: 435,
  },
  {
    icao: 'KPIT',
    name: 'Pittsburgh International',
    lat: 40.4915,
    lon: -80.2329,
    elevationFt: 1203,
  },
  {
    icao: 'KCLE',
    name: 'Cleveland Hopkins International',
    lat: 41.4058,
    lon: -81.8539,
    elevationFt: 791,
  },
  {
    icao: 'KMCI',
    name: 'Kansas City International',
    lat: 39.2976,
    lon: -94.7139,
    elevationFt: 1026,
  },
  {
    icao: 'KMSY',
    name: 'New Orleans Louis Armstrong International',
    lat: 29.9934,
    lon: -90.258,
    elevationFt: 4,
  },
  {
    icao: 'KSNA',
    name: 'Orange County John Wayne',
    lat: 33.6762,
    lon: -117.8675,
    elevationFt: 56,
  },
  {
    icao: 'KBUR',
    name: 'Hollywood Burbank',
    lat: 34.2007,
    lon: -118.3587,
    elevationFt: 778,
  },
  {
    icao: 'KONT',
    name: 'Ontario International',
    lat: 34.056,
    lon: -117.6012,
    elevationFt: 944,
  },
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse every feed block on a LiveATC airport page.
 * Each block is a `<table class="body">` whose header cell carries the label,
 * followed by a "Feed Status" line and a `myHTML5Popup('<mount>', ...)` link;
 * the following `<table class="freqTable">` lists facility/frequency pairs.
 */
export function parseAirportPage(html) {
  const feeds = [];
  const blockPattern =
    /<table class="body"[^>]*>([\s\S]*?)<\/table>(?:\s*<table class="freqTable"[^>]*>([\s\S]*?)<\/table>)?/g;
  let match;
  while ((match = blockPattern.exec(html))) {
    const block = match[1];
    // A live feed carries the HTML5 player link; a feed that is DOWN keeps
    // only its archive link, which names the same mount.
    const mountMatch =
      block.match(/myHTML5Popup\('([a-z0-9_]+)'/i) ||
      block.match(/archive\.php\?m=([a-z0-9_]+)/i);
    if (!mountMatch) continue;
    const mount = mountMatch[1].toLowerCase();
    const labelMatch = block.match(
      /bgcolor="lightblue"><strong>([\s\S]*?)<\/strong>/i,
    );
    const label = labelMatch ? decodeEntities(labelMatch[1]) : mount;
    const statusMatch = block.match(
      /Feed Status:<\/strong>\s*<font[^>]*><strong>([A-Z]+)<\/strong>/i,
    );
    const pageStatus = statusMatch ? statusMatch[1].toUpperCase() : 'UNKNOWN';
    const frequencies = [];
    const freqTable = match[2] || '';
    const rowPattern =
      /<tr><td class="td[01]">([\s\S]*?)<\/td><td><b>([\d.]+)<\/b><\/td><\/tr>/g;
    let row;
    while ((row = rowPattern.exec(freqTable))) {
      frequencies.push({ facility: decodeEntities(row[1]), mhz: row[2] });
    }
    if (feeds.some((feed) => feed.mount === mount)) continue;
    feeds.push({ mount, label, pageStatus, frequencies });
  }
  return feeds;
}

function requestOnce(url, { method = 'GET', timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.request(
      url,
      {
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        timeout,
        // One socket per probe, nothing pooled between them.
        agent: false,
      },
      (response) => resolve({ response, request }),
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * Probe a mount: follow redirects from d.liveatc.net and read the first bytes.
 * A single edge hiccup must not brand a live feed offline for weeks, so a
 * timeout or connection error is retried once after a short pause.
 */
export async function probeStream(mount) {
  const first = await probeStreamOnce(mount);
  if (first.online || /^http \d+$/.test(first.reason)) return first;
  await sleep(2000);
  return probeStreamOnce(mount);
}

async function probeStreamOnce(mount) {
  let url = `https://d.liveatc.net/${mount}`;
  for (let hop = 0; hop < 4; hop += 1) {
    let response;
    let request;
    try {
      ({ response, request } = await requestOnce(url));
    } catch (error) {
      return { online: false, reason: error.message, url };
    }
    const status = response.statusCode || 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      // Drop the redirect hop's socket outright: a few hundred idle
      // keep-alive sockets left behind here exhausted the descriptor table
      // mid-run and every later probe timed out.
      response.resume();
      request.destroy();
      url = new URL(response.headers.location, url).href;
      continue;
    }
    if (status !== 200) {
      response.resume();
      request.destroy();
      return { online: false, reason: `http ${status}`, url };
    }
    const contentType = String(response.headers['content-type'] || '');
    const head = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
      response.once('data', (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      });
      response.once('end', () => {
        clearTimeout(timer);
        resolve(null);
      });
      response.once('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
    request.destroy();
    const looksLikeMpeg =
      head &&
      head.length > 1 &&
      ((head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ||
        head.toString('latin1', 0, 3) === 'ID3');
    const online =
      Boolean(head) && (contentType.startsWith('audio/') || looksLikeMpeg);
    return {
      online,
      reason: online ? '' : `no audio (${contentType || 'no content-type'})`,
      url,
    };
  }
  return { online: false, reason: 'too many redirects', url };
}

function isAirportPage(html) {
  return (
    /Airport Detail/i.test(html) &&
    (/myHTML5Popup\('/.test(html) || /archive\.php\?m=/.test(html))
  );
}

/**
 * A page captured from an interactive browser session and parsed there with
 * `parseAirportPage` (when headless Chrome is blocked, a signed-in desktop
 * browser still loads the page): `<ICAO>.json` beside the HTML cache holds the
 * parsed feed list.
 */
function readParsedCache(icao, cacheDir) {
  if (!cacheDir) return null;
  const parsedPath = path.join(cacheDir, `${icao}.json`);
  if (!fs.existsSync(parsedPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(parsedPath, 'utf8'));
  return Array.isArray(parsed) ? parsed : null;
}

function isBlockedPage(html) {
  return /Attention Required!|Sorry, you have been blocked/i.test(html);
}

async function loadAirportPageOnce(browser, icao) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.goto(`https://www.liveatc.net/search/?icao=${icao}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    let html = await page.content();
    // Cloudflare's managed challenge resolves itself in headless Chrome within a
    // few seconds; wait for the real page (title "Airport Detail: ...").
    for (
      let attempt = 0;
      attempt < 8 && !isAirportPage(html) && !isBlockedPage(html);
      attempt += 1
    ) {
      await sleep(2000);
      html = await page.content();
    }
    return html;
  } finally {
    await page.close();
  }
}

async function loadAirportPage(browser, icao, cacheDir) {
  const cachePath = cacheDir ? path.join(cacheDir, `${icao}.html`) : null;
  if (cachePath && fs.existsSync(cachePath)) {
    const cached = fs.readFileSync(cachePath, 'utf8');
    if (isAirportPage(cached)) return { html: cached, fetched: false };
  }
  if (!browser) return { html: '', fetched: false };
  let html = await loadAirportPageOnce(browser, icao);
  for (const backoff of BLOCK_BACKOFFS_MS) {
    if (!isBlockedPage(html)) break;
    console.warn(
      `[liveatc] ${icao}: blocked by Cloudflare, backing off ${backoff / 1000}s`,
    );
    await sleep(backoff);
    html = await loadAirportPageOnce(browser, icao);
  }
  if (cachePath && isAirportPage(html)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, html);
  }
  return { html, fetched: true };
}

function renderModule(generatedAt, airports) {
  const body = JSON.stringify(airports, null, 2);
  return `// Generated by scripts/liveatc-feeds-build.mjs — do not edit by hand.
// Source: public LiveATC airport pages (https://www.liveatc.net/search/?icao=<ICAO>),
// one page per airport, one stream probe per mount, at generation time only.
// \`online\` reflects the stream probe at generation time; \`pageStatus\` is the
// UP/DOWN badge LiveATC showed on the page at the same moment.

export const LIVEATC_GENERATED_AT = '${generatedAt}';

export const LIVEATC_AIRPORTS = Object.freeze(${body});
`;
}

async function main() {
  const wanted = new Set(
    process.argv.slice(2).map((code) => code.toUpperCase()),
  );
  const airports = AIRPORTS.filter(
    (airport) => !wanted.size || wanted.has(airport.icao),
  );
  const cacheDir = process.env.LIVEATC_PAGE_CACHE || '';
  // Offline iteration: parse cached pages only (no browser, airports without a
  // cached page keep no feeds) and optionally skip the stream probes.
  const cacheOnly = process.env.LIVEATC_CACHE_ONLY === '1';
  const skipProbes = process.env.LIVEATC_SKIP_PROBES === '1';
  // Second pass: keep every mount the previous run found online and only
  // re-probe the rest from a fresh process (long probe runs saw the edges
  // start timing out after a few hundred sequential connections).
  const previouslyOnline = new Set();
  if (process.env.LIVEATC_REPROBE_OFFLINE === '1' && fs.existsSync(OUT)) {
    const previous = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);
    for (const airport of previous.LIVEATC_AIRPORTS || []) {
      for (const feed of airport.feeds || []) {
        if (feed.online) previouslyOnline.add(feed.mount);
      }
    }
    console.log(
      `[liveatc] re-probing offline mounts only (${previouslyOnline.size} kept online)`,
    );
  }
  if (cacheOnly && !cacheDir)
    throw new Error('LIVEATC_CACHE_ONLY needs LIVEATC_PAGE_CACHE');
  let browser = null;
  if (!cacheOnly) {
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox'],
    });
  }
  const results = [];
  const unresolved = [];
  try {
    for (const airport of airports) {
      const started = Date.now();
      let feeds = [];
      let fetched = false;
      try {
        const parsed = readParsedCache(airport.icao, cacheDir);
        if (parsed) feeds = parsed;
        else {
          const loaded = await loadAirportPage(browser, airport.icao, cacheDir);
          fetched = loaded.fetched;
          if (isBlockedPage(loaded.html))
            console.error(`[liveatc] ${airport.icao}: still blocked`);
          else feeds = parseAirportPage(loaded.html);
        }
      } catch (error) {
        console.error(
          `[liveatc] ${airport.icao}: page failed: ${error.message}`,
        );
      }
      if (!feeds.length) unresolved.push(airport.icao);
      console.log(`[liveatc] ${airport.icao}: ${feeds.length} feeds`);
      results.push({ ...airport, feeds });
      const elapsed = Date.now() - started;
      if (fetched && elapsed < PAGE_INTERVAL_MS)
        await sleep(PAGE_INTERVAL_MS - elapsed);
    }
  } finally {
    await browser?.close();
  }

  let online = 0;
  let total = 0;
  for (const airport of results) {
    const feeds = [];
    for (const feed of airport.feeds) {
      const started = Date.now();
      const probe = skipProbes
        ? { online: false, reason: 'probes skipped' }
        : previouslyOnline.has(feed.mount)
          ? { online: true, reason: '' }
          : await probeStream(feed.mount);
      total += 1;
      if (probe.online) online += 1;
      else if (!skipProbes)
        console.log(`[liveatc] ${feed.mount}: offline (${probe.reason})`);
      feeds.push({
        mount: feed.mount,
        label: feed.label,
        kind: classifyFeedKind(feed.label, feed.mount),
        online: probe.online,
        pageStatus: feed.pageStatus,
        frequencies: feed.frequencies,
      });
      const elapsed = Date.now() - started;
      const probed = !skipProbes && !previouslyOnline.has(feed.mount);
      if (probed && elapsed < REQUEST_INTERVAL_MS)
        await sleep(REQUEST_INTERVAL_MS - elapsed);
    }
    airport.feeds = feeds;
  }

  // Merge mode: a subset run splices its airports into the committed
  // directory instead of replacing it, preserving AIRPORTS order.
  let output = results;
  if (process.env.LIVEATC_MERGE === '1' && wanted.size && fs.existsSync(OUT)) {
    const previous = await import(`${pathToFileURL(OUT).href}?m=${Date.now()}`);
    const kept = new Map(
      (previous.LIVEATC_AIRPORTS || []).map((airport) => [
        airport.icao,
        airport,
      ]),
    );
    for (const airport of results) kept.set(airport.icao, airport);
    output = AIRPORTS.map((airport) => kept.get(airport.icao)).filter(Boolean);
    console.log(
      `[liveatc] merged ${results.length} airport(s) into ${output.length} committed`,
    );
  }

  const generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, renderModule(generatedAt, output));
  console.log(
    `[liveatc] wrote ${path.relative(process.cwd(), OUT)}: ${results.length} airports, ${total} feeds, ${online} online`,
  );
  if (unresolved.length)
    console.log(`[liveatc] no feeds resolved for: ${unresolved.join(' ')}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
