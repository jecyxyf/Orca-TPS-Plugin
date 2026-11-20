import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const panelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'panel.html');

/** Parse top-level (non-@media) CSS rules in cascade order so later duplicate selectors override earlier ones. */
function cascadeTopLevelCss(cssText) {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip @media / @keyframes blocks so we inspect base desktop/sidebar rules.
  let stripped = '', depth = 0, inAtBlock = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (!inAtBlock && ch === '@') inAtBlock = true;
    if (ch === '{') depth++;
    if (!inAtBlock) stripped += ch;
    if (ch === '}') {
      depth--;
      if (depth === 0 && inAtBlock) inAtBlock = false;
    }
  }
  const computed = new Map();
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of stripped.matchAll(rulePattern)) {
    const selectors = match[1].split(',').map(s => s.trim()).filter(Boolean);
    const declarations = {};
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const prop = part.slice(0, colon).trim();
      const val = part.slice(colon + 1).trim();
      if (prop && val) declarations[prop] = val;
    }
    for (const selector of selectors) {
      computed.set(selector, { ...(computed.get(selector) ?? {}), ...declarations });
    }
  }
  return computed;
}

test('per-request card TPS value keeps large 20px font and is not clobbered by model speed ranking styles', async () => {
  const html = await readFile(panelPath, 'utf8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
  assert.ok(styleMatch, 'panel.html must contain a <style> block');
  const css = cascadeTopLevelCss(styleMatch[1]);

  const speedPill = css.get('.speed');
  const speedValue = css.get('.speed-value');
  assert.ok(speedPill, '.speed rule must exist for per-request card');
  assert.ok(speedValue, '.speed-value rule must exist for per-request card');

  assert.equal(speedValue['font-size'], '20px', 'per-request TPS number must stay 20px');
  assert.equal(speedValue.color, undefined, '.speed-value must inherit var(--speed) from .speed instead of green ranking text');
  assert.equal(speedPill['margin-top'], undefined, 'per-request .speed pill must not inherit section margin-top');

  // Ranking section (#speed) and speedRow() must not reuse .speed or .speed-value classes.
  const rankingSection = html.match(/<section[^>]*\bid="speed"[^>]*>/i)?.[0] ?? '';
  assert.ok(rankingSection, 'model speed ranking section (#speed) must remain present');
  const rankingClasses = (rankingSection.match(/\bclass="([^"]*)"/i)?.[1] ?? '').split(/\s+/);
  assert.ok(!rankingClasses.includes('speed'), '#speed ranking section must not share the .speed pill class');
  assert.ok(!/value\.className\s*=\s*['"]speed-value['"]/.test(html), 'speedRow() must not assign .speed-value');
});

test('per-request card renders rocket icon, TPS value, and tokens/s unit on a single horizontal line', async () => {
  const html = await readFile(panelPath, 'utf8');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
  const css = cascadeTopLevelCss(styleMatch[1]);

  const templateMatch = html.match(/<template\s+id="record-template">([\s\S]*?)<\/template>/i);
  assert.ok(templateMatch, '#record-template must exist');
  const template = templateMatch[1];

  // Inside .speed, rocket SVG, speed-value, and speed-unit must sit in one single-row container in exact order.
  const speedBlockMatch = template.match(/<div\s+class="speed">([\s\S]*?)<\/div>/i);
  assert.ok(speedBlockMatch, '.speed container must exist in #record-template && have no nested .speed-top wrapper');
  const inner = speedBlockMatch[1];
  assert.ok(!inner.includes('speed-top'), '.speed must not split icon/value into a separate .speed-top row above unit');

  const rocketIdx = inner.indexOf('class="rocket"');
  const valueIdx = inner.indexOf('data-testid="speed-value"');
  const unitIdx = inner.indexOf('class="speed-unit"');
  assert.ok(rocketIdx >= 0 && valueIdx > rocketIdx && unitIdx > valueIdx, 'order must be icon -> TPS -> tokens/s');
  assert.match(inner, /<span\s+class="speed-unit">tokens\/s<\/span>/);

  const speedPill = css.get('.speed');
  const speedUnit = css.get('.speed-unit');
  const cardTop = css.get('.card-top');
  assert.ok(
    speedPill.display === 'inline-flex' || speedPill.display === 'flex',
    '.speed must use flex layout to place icon, TPS, and tokens/s on one line'
  );
  assert.equal(speedPill['white-space'], 'nowrap', '.speed must prevent line wrapping between TPS and tokens/s');
  assert.notEqual(speedUnit?.display, 'block', '.speed-unit must stay inline on the same row');
  assert.match(cardTop?.['grid-template-columns'] ?? '', /\bauto\s*$/, '.card-top right column must size to single-line pill');
});

test('panel resolves per-record agent label from record.provider and shows channel title in summary', async () => {
  const html = await readFile(panelPath, 'utf8');
  assert.match(html, /agentLabel\(\s*record\.provider\s*\)/, 'recordCard must pass record.provider to agentLabel');
  assert.match(html, /function\s+agentLabel\(\s*provider\s*\)/, 'agentLabel must accept per-record provider override');
  assert.match(html, /activeSession\?\.provider\s*===\s*['"]channel['"]/, 'summary must display channel title when in channel mode');
});

test('today usage connects pulses at real timestamps and animates new points once', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /const chartPadding = 4;([\s\S]*?)\n      function usageCard/.exec(html)?.[0];
  assert.ok(source);
  assert.equal(cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]).get('.ladder-chart').background, 'transparent');
  const frames = [], painters = new WeakMap(), paths = [], areas = [], stops = [];
  class TestPath {
    constructor(path) { this.points = path ? [...path.points] : []; }
    moveTo(...point) { this.points.push(point); }
    lineTo(...point) { this.points.push(point); }
    bezierCurveTo(...points) { this.points.push(points.slice(-2)); }
    closePath() { this.points.push('closed'); }
  }
  let path;
  const ctx = {
    setTransform() {}, clearRect() { paths.length = areas.length = 0; }, beginPath() { path = []; },
    createLinearGradient() { return { addColorStop(...stop) { stops.push(stop); } }; },
    save() {}, restore() {},
    stroke(line) { paths.push(line.points); },
    arc(...point) { path.push(point.slice(0, 3)); },
    fill(area) {
      if (area) areas.push({ points: area.points, opacity: this.globalAlpha });
      else paths.push(path);
    }
  };
  let width = 308;
  const chart = { width: 320, height: 60, isConnected: true,
    getBoundingClientRect: () => ({ width, height: 30 }), getContext: () => ctx };
  const draw = new Function('usagePainters', 'requestAnimationFrame', 'lifetime', 'window', 'document', 'Path2D', `
    const RECENT_STATS_MS = 300000;
    ${source.replace(/\n      function usageCard$/, '')}
    return drawSubmissionPulses;
  `)(painters, callback => frames.push(callback), { signal: { aborted: false } }, {
    devicePixelRatio: 2, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: name => name === '--usage-wave-low' ? '#60a589' : '#ff6b72' })
  }, { documentElement: {} }, TestPath);
  draw(chart, [{ submittedAt: 20_000, deltaTokens: 100 }, { submittedAt: 40_000, deltaTokens: 0 },
    { submittedAt: 93_000, deltaTokens: 200 }], 0, 40_000);
  frames.shift()(1000);
  assert.deepEqual([chart.width, chart.height], [616, 60]);
  assert.deepEqual(stops, [[0, 'transparent'], [1, '#60a589'], [0, '#60a589'], [0.58, '#60a589'], [1, '#ff6b72']]);
  assert.deepEqual(paths[0].slice(2, 7), [[24, 15], [27.25, 26], [44, 26], [93.75, 26], [97, 26]]);
  assert.deepEqual(paths[1][0], [44, 26, 1.4]);
  assert.deepEqual(areas[0].points, [...paths[0], [100.25, 26], [20.75, 26], 'closed']);
  assert.ok(areas[0].opacity > 0 && areas[0].opacity < 1);
  frames.shift()(1200);
  assert.deepEqual(paths[0][6], [97, 4]);
  assert.deepEqual(areas[0].points[6], [97, 4]);
  assert.equal(frames.length, 0);
  width = 158;
  painters.get(chart)();
  frames.shift()(1400);
  assert.deepEqual([chart.width, chart.height], [316, 60]);
  assert.deepEqual(paths[0][6], [50.5, 4]);
  assert.equal(frames.length, 0);
});

test('daily usage fills missing dates with zero across the entire selected window', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /function dailyUsagePoints\([\s\S]*?\n      \}/.exec(html)?.[0];
  assert.ok(source);
  const dailyUsagePoints = new Function(`const DAY_MS = 86400000; ${source}; return dailyUsagePoints;`)();
  const week = dailyUsagePoints([{ day: '2026-11-15', tokens: 7 }, { day: '2026-11-19', tokens: 20 }], Date.UTC(2026, 10, 14), 7);
  assert.deepEqual(week.map(point => point.tokens), [0, 7, 0, 0, 0, 20, 0]);
  assert.deepEqual([week[0].day, week.at(-1).day], ['2026-11-14', '2026-11-20']);
  const month = dailyUsagePoints([{ day: '2024-02-29', tokens: 11 }], Date.UTC(2024, 1, 1), 30);
  assert.equal(month.length, 30);
  assert.deepEqual(month.slice(-3), [{ day: '2024-02-28', tokens: 0 }, { day: '2024-02-29', tokens: 11 }, { day: '2024-03-01', tokens: 0 }]);
  assert.equal(dailyUsagePoints([], Date.UTC(2026, 10, 14), 7).filter(point => point.tokens === 0).length, 7);
  assert.deepEqual(dailyUsagePoints(undefined, Date.UTC(2026, 10, 14), 7), []);
});

test('daily usage curves pass through every point and stay within each pair of values', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /function dailyUsagePath\([\s\S]*?\n      \}/.exec(html)?.[0];
  assert.ok(source);
  class TestPath {
    segments = [];
    moveTo(...point) { this.start = point; }
    bezierCurveTo(...segment) { this.segments.push(segment); }
  }
  const dailyUsagePath = new Function('Path2D', `${source}; return dailyUsagePath;`)(TestPath);
  const points = [56, 56, 40, 30, 4, 56, 56].map((y, index) => ({ x: 4 + 52 * index, y }));
  const line = dailyUsagePath(points, point => point.x, point => point.y);
  assert.deepEqual(line.start, [4, 56]);
  assert.deepEqual(line.segments.map(segment => segment.slice(4)), points.slice(1).map(({ x, y }) => [x, y]));
  for (const [index, segment] of line.segments.entries()) {
    const [firstX, firstY, secondX, secondY, endX, endY] = segment;
    const { x: startX, y: startY } = points[index];
    assert.ok(startX < firstX && firstX < secondX && secondX < endX);
    const low = Math.min(startY, endY), high = Math.max(startY, endY);
    assert.ok([firstY, secondY].every(controlY => controlY >= low && controlY <= high));
    const next = line.segments[index + 1];
    if (next) assert.ok(Math.abs((endY - secondY) - (next[1] - endY)) < 1e-10);
  }
  assert.notEqual(line.segments[2][1], points[2].y);
  assert.equal(line.segments[3][3], 4);
});

async function loadAvatarView() {
  const html = await readFile(panelPath, 'utf8');
  const source = /\/\/ avatar-view:start([\s\S]*?)\/\/ avatar-view:end/.exec(html)?.[1];
  assert.ok(source, 'panel must keep the avatar view between avatar-view markers');
  return new Function(source + '\nreturn createAvatarView;')();
}

function fakeAvatar() {
  return {
    dataset: {}, isConnected: true, children: [],
    replaceChildren(...nodes) { this.children = nodes; },
    get shown() { return this.children[0]?.kind === 'img' ? this.children[0].src : 'red-hat'; }
  };
}

function fakeImage() {
  const listeners = {};
  return {
    kind: 'img', alt: undefined, decoding: undefined, _src: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    set src(value) { this._src = value; queueMicrotask(() => listeners[value.startsWith('data:image/') ? 'load' : 'error']?.()); },
    get src() { return this._src; }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('panel avatar view retries default avatars on new rows and reuses loaded avatars everywhere', async () => {
  const createAvatarView = await loadAvatarView();
  const image = 'data:image/png;base64,YXZhdGFy';
  const loads = [];
  let reply = null;
  const view = createAvatarView({
    fallback: () => ({ kind: 'red-hat' }),
    createImage: fakeImage,
    load: async username => { loads.push(username); return reply; },
    visible: () => true,
    Observer: null
  });

  const account = fakeAvatar(), firstRow = fakeAvatar();
  view.set(account, 'jecyxyf');
  view.set(firstRow, 'jecyxyf');
  await settle();
  assert.deepEqual(loads, ['jecyxyf'], 'one request covers every avatar of the same user');
  assert.equal(account.shown, 'red-hat');
  assert.equal(firstRow.shown, 'red-hat');

  view.set(account, 'jecyxyf');
  await settle();
  assert.deepEqual(loads, ['jecyxyf'], 'an unchanged account does not request again on its own');

  reply = image;
  firstRow.isConnected = false;
  const secondRow = fakeAvatar();
  view.set(secondRow, 'jecyxyf');
  view.set(account, 'jecyxyf', { retry: true });
  await settle();
  assert.deepEqual(loads, ['jecyxyf', 'jecyxyf'], 'a regenerated row with a default avatar requests once more');
  assert.equal(secondRow.shown, image);
  assert.equal(account.shown, image, 'a successful avatar also updates the account avatar');

  const thirdRow = fakeAvatar();
  view.set(thirdRow, 'JECYXYF');
  view.set(account, 'jecyxyf', { retry: true });
  await settle();
  assert.equal(thirdRow.shown, image, 'a loaded avatar is shown at once');
  assert.deepEqual(loads, ['jecyxyf', 'jecyxyf'], 'a loaded avatar is never requested again');

  view.set(account, '');
  assert.equal(account.shown, 'red-hat', 'signing out shows the default avatar');
});

test('panel avatar view ignores invalid images and keeps the default red hat icon', async () => {
  const createAvatarView = await loadAvatarView();
  const view = createAvatarView({
    fallback: () => ({ kind: 'red-hat' }),
    createImage: fakeImage,
    load: async () => 'https://example.test/a.png',
    visible: () => true,
    Observer: null
  });
  const avatar = fakeAvatar();
  view.set(avatar, 'alice');
  await settle();
  assert.equal(avatar.shown, 'red-hat');

  const html = await readFile(panelPath, 'utf8');
  const fallback = /<template id="ladder-avatar-fallback">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? '';
  assert.match(fallback, /data-icon="red-hat"/, 'the default avatar is the red hat icon');
  assert.match(fallback, /#d62828|#c1121f|#e63946/i, 'the red hat icon is red');
});

test('panel avatar view loads visible avatars through the observer and retries a still-default slot', async () => {
  const createAvatarView = await loadAvatarView();
  const image = 'data:image/png;base64,YXZhdGFy';
  const loads = [], observed = [];
  let reply = null, shown = true;
  class FakeObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { observed.push(target); queueMicrotask(() => this.callback([{ target, isIntersecting: true }])); }
    unobserve() {}
    disconnect() {}
  }
  const view = createAvatarView({
    fallback: () => ({ kind: 'red-hat' }),
    createImage: fakeImage,
    load: async username => { loads.push(username); return reply; },
    visible: () => shown,
    Observer: FakeObserver
  });
  const account = fakeAvatar();
  shown = false;
  view.set(account, 'alice');
  await settle();
  assert.deepEqual(loads, [], 'hidden leaderboards do not load avatars');
  shown = true;
  view.set(account, 'alice', { retry: true });
  await settle();
  assert.deepEqual(loads, ['alice']);
  assert.equal(account.shown, 'red-hat');
  reply = image;
  view.set(account, 'alice', { retry: true });
  await settle();
  assert.deepEqual(loads, ['alice', 'alice']);
  assert.equal(account.shown, image);
  view.set(account, 'alice', { retry: true });
  await settle();
  assert.deepEqual(loads, ['alice', 'alice'], 'a loaded avatar is not observed or requested again');
  assert.equal(observed.length, 3);
});
