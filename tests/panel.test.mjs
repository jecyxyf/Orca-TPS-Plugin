import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const panelPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'panel.html');

test('upload failures keep an accessible reason without a visible notice', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /const successfulUploadCodes[^\n]*\n[\s\S]*?(?=\n      function renderTransferStatus)/.exec(html)?.[0];
  assert.ok(source);
  assert.doesNotMatch(html, /ladder-sync-error|boardProblem/);
  const failure = new Function('shortClock', 'messageFor', 't', `${source}\nreturn uploadFailure;`)(
    String, code => code, (key, ...values) => [key, ...values].join(' ')
  );
  assert.equal(failure({ lastUpload: { at: 100, code: 'accepted', rollingCode: 'unavailable' }, rollingProblem: 'unavailable' }),
    'daily-upload-succeeded-rolling-failed unavailable');
  assert.equal(failure({ lastUpload: { at: 110, code: 'invalid', rollingCode: 'accepted' } }),
    'rolling-upload-succeeded-daily-failed invalid');
  assert.equal(failure({ lastUpload: { at: 115, code: 'unavailable', rollingOnly: true }, rollingProblem: 'unavailable' }),
    'rolling-upload-failed unavailable');
  assert.equal(failure({ lastUpload: { at: 118, code: 'unavailable' } }), 'last-sync-failed 118 unavailable');
  assert.equal(failure({ lastUpload: { at: 120, code: 'accepted', rollingCode: 'accepted' }, rollingProblem: null }), '');
});

test('per-request output uses tokens and aggregate usage uses millions without rounding small counts to zero', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /const formatMillionTokens = tokens => \{[\s\S]*?\n    \};/.exec(html)?.[0];
  assert.ok(source);
  assert.match(html, /data-testid="output-value"><\/span><span class="metric-unit">tokens<\/span>/);
  const format = new Function('locale', `${source}\nreturn formatMillionTokens;`)({
    number: (value, options) => new Intl.NumberFormat('en', options).format(value)
  });
  assert.equal(format(501), '0.000501 M');
  assert.equal(format(1_250_000), '1.25 M');
  assert.equal(format(0), '0 M');
  assert.equal(format(null), '—');
});

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

test('panel resolves per-record agent label from record.provider', async () => {
  const html = await readFile(panelPath, 'utf8');
  assert.match(html, /agentLabel\(\s*record\.provider\s*\)/, 'recordCard must pass record.provider to agentLabel');
  assert.match(html, /function\s+agentLabel\(\s*provider\s*\)/, 'agentLabel must accept per-record provider override');
});

test('the panel title has a logo and Current Data shows the countdown icon and update time without a refresh button', async () => {
  const html = await readFile(panelPath, 'utf8');
  const logo = /<h1\b[^>]*\bid="panel-title"[^>]*>[\s\S]*?<img\b[^>]*\bsrc="([^"]+)"[^>]*\balt=""[^>]*>\s*TPS Plugin/.exec(html);
  assert.ok(logo, 'logo must be left of the title');
  const png = await readFile(path.resolve(path.dirname(panelPath), logo[1]));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(html, /<div class="panel-header">\s*<p\b[^>]*\bid="updated-wrap"[\s\S]*?id="updated-icon"[\s\S]*?<svg\b[\s\S]*?<span\b[^>]*\bid="updated"[^>]*>—<\/span>\s*<\/p>\s*<\/div>/);
  assert.match(html, /@keyframes spin-once/);
  assert.match(html, /\.current-updated-icon\.is-spinning svg/);
  assert.doesNotMatch(html, /<button\b[^>]*\bid="refresh"|current-refresh/);
  assert.doesNotMatch(html, /recent-requests|request-speed-note/);
});

test('Personal Stats and the Leaderboard show calendar mode first and select it by default', async () => {
  const html = await readFile(panelPath, 'utf8');
  const toolbar = /<section\b[^>]*\bid="usage"[^>]*>\s*<div class="war-mode">([\s\S]*?)\n      <section class="war"/.exec(html)?.[1];
  assert.ok(toolbar);
  const expectedModes = [['calendar', 'true'], ['hourly', 'false']];
  assert.deepEqual([...toolbar.matchAll(/data-usage-mode="([^"]+)" aria-pressed="([^"]+)"/g)]
    .map(match => match.slice(1)), expectedModes);
  assert.match(toolbar, /usage-mode-tabs/);
  assert.equal((toolbar.match(/<svg\b/g) ?? []).length, 2);
  const warTotals = /<div class="war-totals">([\s\S]*?)<\/div>\s*<\/section>/.exec(html)?.[1] ?? '';
  assert.equal((warTotals.match(/class="war-stat-icon\b/g) ?? []).length, 3);
  assert.doesNotMatch(warTotals, /class="war-label"/);
  assert.match(html, /\.war-totals\s*\{[^}]*grid-auto-flow:\s*column/);
  assert.match(html, /\.war-value\.speed-max\s*\{\s*color:\s*var\(--speed\)/);
  assert.deepEqual([...html.matchAll(/data-ladder-mode="([^"]+)" aria-pressed="([^"]+)"/g)]
    .map(match => match.slice(1)), expectedModes);
  assert.match(html, /usageMode = 'calendar'/);
  assert.match(html, /rankingMode = 'calendar'/);
  assert.doesNotMatch(html, /war-mode-help|war-mode-hint|usage-update-(?:help|hint)/);
});

test('today usage draws a full zero line and animates real-time pulses once', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /const chartVerticalPadding = 4;[\s\S]*?(?=\n      function renderRows)/.exec(html)?.[0];
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
  let path, savedAlpha;
  const ctx = {
    globalAlpha: 1,
    setTransform() {}, clearRect() { paths.length = areas.length = 0; }, beginPath() { path = []; },
    createLinearGradient() { return { addColorStop(...stop) { stops.push(stop); } }; },
    save() { savedAlpha = this.globalAlpha; },
    restore() { this.globalAlpha = savedAlpha; },
    stroke(line) { paths.push(line.points); },
    arc(...point) { path.push(point.slice(0, 3)); },
    fill(area) {
      if (area) areas.push({ points: area.points, opacity: this.globalAlpha, style: this.fillStyle });
      else paths.push(path);
    }
  };
  let width = 300;
  const chart = { width: 320, height: 60, isConnected: true,
    getBoundingClientRect: () => ({ width, height: 30 }), getContext: () => ctx };
  function createElement(tag) {
    return { ...(tag === 'canvas' ? chart : {}), children: [], setAttribute() {},
      append(...children) { this.children.push(...children); } };
  }
  const { draw, pulseX, usageCard } = new Function('usagePainters', 'requestAnimationFrame', 'lifetime', 'window', 'document', 'Path2D', `
    const RECENT_STATS_MS = 300000, rankDays = 1;
    const usageChartLabel = () => 'Recent usage', toolText = () => '', t = key => key;
    const formatMillionTokens = tokens => tokens + ' M', speedText = speed => speed + ' tokens/s';
    ${source}
    return { draw: drawSubmissionPulses, pulseX, usageCard };
  `)(painters, callback => frames.push(callback), { signal: { aborted: false } }, {
    devicePixelRatio: 2, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: name => name === '--usage-wave-low' ? '#60a589' : '#ff6b72' })
  }, { documentElement: {}, createElement }, TestPath);
  assert.equal(pulseX({ submittedAt: 1_000 }, 1_000, width), 0);
  assert.equal(pulseX({ submittedAt: 301_000 }, 1_000, width), width);
  draw(chart, [{ submittedAt: 20_000, deltaTokens: 100 }, { submittedAt: 40_000, deltaTokens: 0 },
    { submittedAt: 93_000, deltaTokens: 200 }], 0, 40_000);
  frames.shift()(1000);
  assert.deepEqual([chart.width, chart.height], [600, 60]);
  assert.deepEqual(stops, [[0, '#60a589'], [1, '#ff6b72']]);
  assert.deepEqual([paths[0][0], paths[0].at(-1)], [[0, 26], [300, 26]]);
  assert.deepEqual(paths[0].slice(2, 7), [[20, 15], [23.25, 26], [40, 26], [89.75, 26], [93, 26]]);
  assert.deepEqual(paths[1][0], [40, 26, 1.4]);
  assert.deepEqual(areas[0].points, [...paths[0], [300, 26], [0, 26], 'closed']);
  assert.equal(areas[0].opacity, 0.5);
  assert.equal(areas[0].style, ctx.strokeStyle);
  assert.equal(ctx.globalAlpha, 1);
  frames.shift()(1200);
  assert.deepEqual(paths[0][6], [93, 4]);
  assert.deepEqual(areas[0].points[6], [93, 4]);
  assert.equal(frames.length, 0);
  width = 150;
  painters.get(chart)();
  frames.shift()(1400);
  assert.deepEqual([chart.width, chart.height], [300, 60]);
  assert.deepEqual(paths[0][6], [46.5, 4]);
  assert.equal(frames.length, 0);
  const empty = usageCard({}, 301_000, Infinity);
  const [emptyChart, emptyMeta] = empty.children;
  assert.equal(emptyMeta.children.at(-1).textContent, '0 tokens/s');
  assert.equal(emptyChart.title, 'Recent usage\n0 M · 0 tokens/s');
  frames.shift()(1600);
  assert.deepEqual(paths, [[[0, 26], [150, 26]]]);
  assert.equal(frames.length, 0);
});

test('usage rankings omit the subtitle beneath the period selector', async () => {
  const html = await readFile(panelPath, 'utf8');
  assert.doesNotMatch(html, /ladder-recent-caption|leaderboard-cutoff/);
  assert.match(html, /chart\.setAttribute\('aria-label', usageChartLabel\(\)\)/);
});

test('the speed ranking uses S medals for the first three places', async () => {
  const html = await readFile(panelPath, 'utf8');
  const speed = /const speedPeriod = \{[^\n]*\};/.exec(html)?.[0];
  const podium = /const podium = \[[^\n]*\];/.exec(html)?.[0];
  const render = /function medal\(rank, period\) \{[\s\S]*?\n      \}/.exec(html)?.[0];
  const period = /const period = speedBoard \? speedPeriod : periods\.find\(entry => entry\.days === rankDays\);/.exec(html)?.[0];
  assert.ok(speed && podium && render && period);
  const document = { createElement() {
    return {
      attributes: {}, dataset: {}, children: [], style: { setProperty() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      append(...children) { this.children.push(...children); },
      cloneNode() { return { ...this }; }
    };
  } };
  const t = (key, ...args) => [key, ...args].join(' ');
  const badgeFor = new Function('document', 't', `
    ${speed}
    ${podium}
    ${render}
    const periods = [{ days: 30, mark: '30', title: 'thirty-day-period' }];
    return (rank, rankDays) => {
      const speedBoard = rankDays === 0;
      ${period}
      return medal(rank, period);
    };
  `)(document, t);
  for (const [index, color] of ['gold', 'silver', 'bronze'].entries()) {
    const badge = badgeFor(index + 1, 0);
    assert.equal(badge.dataset.place, index + 1);
    assert.equal(badge.children.at(-1).children[0].textContent, 'S');
    assert.equal(badge.attributes['aria-label'], `medal-position leaderboard-speed-tab ${color}-medal`);
  }
  assert.equal(badgeFor(4, 0), null);
  assert.equal(badgeFor(1, 30).children.at(-1).children[0].textContent, '30');
  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.ladder-rows .ladder-speed-row:not(:has(.ladder-medal))')['--ladder-row-size'], '32px');
});

test('non-interactive transfer indicators sit beside the last successful times', async () => {
  const html = await readFile(panelPath, 'utf8');
  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.ladder-toolbar')['grid-template-areas'], '"title . action last"');
  assert.equal(css.get('.ladder-rank-toolbar')['grid-template-areas'], '"title toggle action last"');
  assert.equal(css.get('.ladder-transfer').background, 'transparent');
  assert.equal(css.get('.ladder-transfer')['justify-content'], 'flex-end');
  assert.equal(css.get('.ladder-toolbar')['--ladder-toolbar-action-width'], '40px');
  assert.equal(css.get('.ladder-toolbar')['--ladder-toolbar-icon-size'], '16px');
  assert.equal(css.get('.ladder-toolbar')['--ladder-toolbar-label-size'], '13px');
  assert.equal(css.get('.ladder-toolbar-value')['font-size'], css.get('.ladder-toolbar .section-title')['font-size']);
  assert.equal(css.get('.ladder-toolbar-value')['grid-area'], 'last');
  assert.match(html, /\.ladder-rank-toolbar\.is-off :is\(\.ladder-transfer, \.ladder-toolbar-value\) \{ display: none; \}/);
  assert.equal(css.get('.ladder-personal-data')['scrollbar-gutter'], 'stable');
  assert.equal(css.get('.ladder-personal-data')['max-block-size'], '208px');
  assert.equal(css.get('.ladder-personal-data')['padding-block-end'], '8px');
  assert.equal(css.get('.ladder-rank-card')['scrollbar-gutter'], 'stable');
  assert.equal(css.get('.ladder-transfer[aria-busy="true"] .ladder-transfer-spinner').animation, 'spin 1s linear infinite');
  assert.equal(css.get('.ladder-transfer.is-failed .ladder-transfer-error').color, 'var(--error)');
  assert.doesNotMatch(html, /ladder-(?:sync|refresh)-countdown/);
  assert.doesNotMatch(html, /id="ladder-(?:sync-now|update)"|request\('sync'\)/);
  for (const [id, timeId, tooltip] of [
    ['upload-state', 'sync-result', 'last-upload-time'],
    ['download-state', 'refresh-time', 'last-sync-time']
  ]) {
    const pair = new RegExp(`(<span[^>]*id="ladder-${id}"[\\s\\S]*?<\\/span>)\\s*` +
      `(<time[^>]*id="ladder-${timeId}"[^>]*>)`).exec(html);
    assert.ok(pair, `${id} must sit directly beside its timestamp`);
    const [, indicator, time] = pair;
    assert.match(time, new RegExp(`data-i18n-title="${tooltip}"`));
    assert.match(indicator, /role="img" aria-busy="false"/);
    assert.doesNotMatch(indicator, /tabindex|onclick/);
    assert.doesNotMatch(html, new RegExp(`element\\('${id}'\\)\\.addEventListener`));
    assert.match(indicator, /class="ladder-transfer-icon"/);
    assert.match(indicator, /class="ladder-transfer-spinner"/);
    assert.match(indicator, /class="ladder-transfer-error"/);
  }
});

test('leaderboard upload and download indicate active transfers independently', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /const successfulUploadCodes[\s\S]*?(?=\n      function scheduleUploadUnlock)/.exec(html)?.[0];
  assert.ok(source);
  const indicators = Object.fromEntries(['upload-state', 'download-state'].map(id => {
    const attrs = new Map(), classes = new Set();
    return [id, {
      attrs, classes, classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } },
      setAttribute: (name, value) => attrs.set(name, value),
      getAttribute: name => attrs.get(name)
    }];
  }));
  const show = new Function('element', 'state', `
    const { rankingPending, rankingProblem } = state;
    const t = (key, ...args) => [key, ...args].join(' ');
    const messageFor = t;
    const shortClock = String;
    ${source}
    renderUploadStatus(state.snapshot, state.signedIn !== false, state.time ?? 1000);
    renderDownloadStatus();
  `);
  const upload = indicators['upload-state'], download = indicators['download-state'];
  const state = indicator => [indicator.attrs.get('aria-busy'), indicator.title];
  const isFailed = indicator => indicator.classes.has('is-failed');
  const render = current => show(id => indicators[id], current);
  render({ snapshot: { uploading: true } });
  assert.deepEqual(state(upload), ['true', 'uploading']);
  assert.deepEqual(state(download), ['false', 'period-rankings']);
  render({ rankingPending: true });
  assert.deepEqual(state(upload), ['false', 'data-upload']);
  assert.deepEqual(state(download), ['true', 'sync-in-progress']);
  const locked = { board: { lockedUntil: 1500 } };
  render({ snapshot: locked });
  assert.equal(isFailed(upload), true);
  render({ snapshot: locked, time: 1500 });
  assert.equal(isFailed(upload), false);
  render({ signedIn: false, snapshot: { uploading: true } });
  assert.deepEqual(state(upload), ['false', 'data-upload']);
  assert.deepEqual(state(download), ['false', 'period-rankings']);

  const lastUpload = { at: 1000, code: 'unavailable' };
  render({ snapshot: { lastUpload } });
  assert.equal(isFailed(upload), true);
  assert.equal(isFailed(download), false);
  assert.equal(upload.attrs.get('aria-label'), 'data-upload · last-sync-failed 1000 unavailable');

  render({ snapshot: { uploading: true, lastUpload }, rankingProblem: 'unavailable' });
  assert.equal(isFailed(upload), false);
  assert.equal(isFailed(download), true);
  assert.equal(download.attrs.get('aria-label'), 'period-rankings · unavailable');

  render({ snapshot: { lastUpload }, rankingPending: true, rankingProblem: 'unavailable' });
  assert.equal(isFailed(upload), true);
  assert.equal(isFailed(download), false);
  assert.deepEqual(state(download), ['true', 'sync-in-progress']);

  render({ snapshot: { lastUpload: { at: 2000, code: 'accepted' } } });
  assert.equal(isFailed(upload), false);
  assert.equal(isFailed(download), false);
});

test('upload lock expiry uses one timer outside the periodic ranking check', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /function scheduleUploadUnlock\([\s\S]*?\n      \}/.exec(html)?.[0];
  const interval = /const interval = setInterval\(\(\) => \{[\s\S]*?\n      \}, 1000\);/.exec(html)?.[0];
  assert.ok(source && interval);
  assert.doesNotMatch(interval, /renderUploadStatus|scheduleUploadUnlock/);

  const timers = new Map();
  let issued = 0, renders = 0;
  const schedule = new Function('setTimeout', 'clearTimeout', 'render', `
    let uploadUnlockAt, uploadUnlockWake;
    ${source}
    return scheduleUploadUnlock;
  `)((callback, delay) => {
    timers.set(++issued, { callback, delay });
    return issued;
  }, id => timers.delete(id), () => { renders++; });

  schedule(undefined, 1000);
  assert.equal(timers.size, 0);
  schedule(1500, 1000);
  schedule(1500, 1200);
  assert.equal(issued, 1);
  assert.equal(timers.get(1).delay, 500);

  schedule(1800, 1200);
  assert.deepEqual([...timers.keys()], [2]);
  assert.equal(timers.get(2).delay, 600);
  const wake = timers.get(2).callback;
  timers.delete(2);
  wake();
  schedule(1800, 1800);
  assert.equal(renders, 1);
  assert.equal(timers.size, 0);

  schedule(1990, 1800);
  schedule(undefined, 1850);
  assert.equal(timers.size, 0);
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
    get shown() {
      const [node] = this.children;
      return node?.kind === 'img' ? node.src : node?.kind;
    }
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
    fallback: () => ({ kind: 'black-hat' }),
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
  assert.equal(account.shown, 'black-hat');
  assert.equal(firstRow.shown, 'black-hat');

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
  assert.equal(account.shown, 'black-hat', 'signing out shows the default avatar');
});

test('panel avatar view ignores invalid images and keeps the default black hat icon', async () => {
  const createAvatarView = await loadAvatarView();
  const view = createAvatarView({
    fallback: () => ({ kind: 'black-hat' }),
    createImage: fakeImage,
    load: async () => 'https://example.test/a.png',
    visible: () => true,
    Observer: null
  });
  const avatar = fakeAvatar();
  view.set(avatar, 'alice');
  await settle();
  assert.equal(avatar.shown, 'black-hat');

  const html = await readFile(panelPath, 'utf8');
  const fallback = /<template id="ladder-avatar-fallback">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? '';
  assert.match(fallback, /data-icon="black-hat"/);
  assert.match(fallback, /<ellipse[^>]*fill="#101114"/, 'the hat brim is black');
  assert.match(fallback, /<path[^>]*fill="#17191c"/, 'the hat crown is black');
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
    fallback: () => ({ kind: 'black-hat' }),
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
  assert.equal(account.shown, 'black-hat');
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

test('top-right header places language picker beside settings gear and modal offers background upload with full-panel editor', async () => {
  const html = await readFile(panelPath, 'utf8');
  const titleBar = /<div class="title-bar"[^>]*>([\s\S]*?)<div class="panel-tabs"/.exec(html)?.[1] ?? '';
  assert.match(titleBar, /id="language-picker"/);
  assert.match(titleBar, /<button[^>]*id="settings-toggle"[^>]*aria-controls="settings-dialog"[^>]*data-i18n-title="theme-title"/);
  assert.ok(titleBar.indexOf('id="language-picker"') < titleBar.indexOf('id="settings-toggle"'));
  assert.match(html, /<div class="panel-bg-layer" id="panel-bg-layer"[^>]*><img class="panel-bg-img" id="panel-bg-img"/);

  const dialog = /<div[^>]*id="settings-dialog"[^>]*role="dialog"[^>]*aria-modal="true"[\s\S]*?(?=\n\s*<div[^>]*id="bg-editor")/.exec(html)?.[0] ?? '';
  assert.ok(dialog, 'settings modal dialog must exist');
  assert.match(dialog, /id="settings-heading"[^>]*data-i18n="theme-title"/);
  assert.match(dialog, /id="settings-close"/);
  assert.match(dialog, /id="settings-style-section"/);
  assert.doesNotMatch(dialog, /id="settings-style-label"|data-i18n="settings-style"/);
  assert.match(dialog, /id="settings-bg-upload"[\s\S]*?<svg\b/);
  assert.match(dialog, /id="settings-bg-edit"[\s\S]*?<svg\b/);
  assert.match(dialog, /id="settings-bg-reset"[\s\S]*?<svg\b/);
  assert.match(dialog, /id="settings-bg-input"[^>]*accept="[^"]*\.svg[^"]*\.jpg[^"]*\.png/);
  assert.match(dialog, /id="settings-color-card"[\s\S]*?<div class="settings-bg-row">[\s\S]*?data-i18n="settings-font-color"[\s\S]*?<div class="settings-color-row">[\s\S]*?id="settings-color-unselected"[\s\S]*?id="settings-color-selected"[\s\S]*?id="settings-color-reset"/);
  assert.match(dialog, /id="settings-color-unselected"[^>]*type="color"/);
  assert.match(dialog, /id="settings-color-selected"[^>]*type="color"/);
  assert.doesNotMatch(dialog, /settings-color-(?:un)?selected-reset/);
  assert.match(dialog, /id="settings-color-icon"[^>]*type="color"/);
  assert.match(dialog, /id="settings-color-icon-reset"/);
  assert.match(dialog, /id="settings-record-card-style"[\s\S]*?id="settings-card-color"[^>]*type="color"[\s\S]*?id="settings-card-reset"[\s\S]*?id="settings-card-opacity"[^>]*type="range"[^>]*min="0"[^>]*max="100"/);
  assert.doesNotMatch(dialog, /id="language-picker"|settings-timezone|settings-bg-zoom|settings-bg-preview/);

  const editor = /<div[^>]*id="bg-editor"[^>]*role="dialog"[\s\S]*?(?=\n\s*<template id="ladder-avatar-fallback">)/.exec(html)?.[0] ?? '';
  assert.ok(editor, 'full-panel background editor must exist');
  assert.match(editor, /id="bg-editor-reset-pos"/);
  assert.match(editor, /id="bg-editor-cancel"/);
  assert.match(editor, /id="bg-editor-save"/);

  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.settings-backdrop').position, 'fixed');
  assert.equal(css.get('.bg-editor').position, 'fixed');
  assert.equal(css.get('.panel-bg-layer').position, 'fixed');
  assert.equal(css.get('.panel-bg-img')['object-fit'], 'cover');
  assert.equal(css.get('html').background, 'var(--page)');
  assert.equal(css.get('.settings-toggle').background, 'transparent');
  assert.equal(css.get('.settings-toggle').color, 'var(--icon-color, var(--tab-unselected, var(--muted)))');
  assert.equal(css.get('.settings-close').background, 'transparent');
  assert.equal(css.get('.settings-close').color, 'var(--icon-color, var(--muted))');
  assert.equal(css.get('.settings-bg-btn').background, 'transparent');
  assert.equal(css.get('.settings-bg-btn').color, 'var(--icon-color, var(--muted))');
  assert.match(html, /root\.setProperty\('--ink', value\)[\s\S]*?root\.setProperty\('--purple', value\)[\s\S]*?root\.setProperty\('--muted',[\s\S]*?root\.setProperty\('--tab-unselected', value\)/);
  assert.match(html, /root\.setProperty\('--blue', value\)[\s\S]*?root\.setProperty\('--tab-selected', value\)/);
  assert.match(html, /setProperty\('--icon-color', value\)/);
  assert.equal(css.get('#current-scroll')['scrollbar-gutter'], 'stable');
  assert.equal(css.get('#current-scroll')['padding-inline-end'], '6px');
  assert.equal(css.get('.records')['justify-items'], 'center');
  assert.equal(css.get('.record-card').width, '95%');
  assert.match(css.get('.record-card').background, /--record-card-bg/);
  assert.match(css.get('.record-card').background, /--record-card-opacity/);
  assert.match(css.get('.war').background, /--record-card-bg/);
  assert.match(css.get('.heat').background, /--record-card-bg/);
  assert.match(css.get('.ladder-card').background, /--record-card-bg/);
  assert.match(css.get('.empty').background, /--record-card-bg/);

  assert.equal(css.get('.metrics')['grid-template-columns'], 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)');
  const cardCode = /function formatTps\(record\) \{[\s\S]*?(?=\n      \/\/ 用量战况)/.exec(html)?.[0] ?? '';
  assert.ok(cardCode);
  assert.doesNotMatch(cardCode, /≈/);
  const template = /<template id="record-template">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(template, /data-testid="agent"|class="agent"/);
  assert.match(template, /class="model-icon"[^>]*data-testid="harness-icon"[\s\S]*?<use[^>]*href="#harness-default"/);
  for (const id of ['claude', 'claude-desktop', 'codex', 'gemini', 'grokbuild', 'opencode', 'openclaw', 'hermes', 'pi', 'mcode', 'kimi', 'omp', 'antigravity', 'copilot', 'workbuddy', 'dsh', 'default']) {
    assert.match(html, new RegExp(`<symbol id="harness-${id}"`));
  }
  const sprite = /<svg id="harness-sprite"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
  assert.doesNotMatch(sprite, /#f7f8fa|color="#202938"/);
  const codex = /<symbol id="harness-codex"[\s\S]*?<\/symbol>/.exec(sprite)?.[0] ?? '';
  assert.doesNotMatch(codex, /fill="#fff"/);
  assert.match(html, /harnessIconId\(record\.provider\)/);
  assert.equal(css.get('.identity')['grid-template-columns'], 'auto minmax(0, 1fr)');
  assert.equal(css.get('.model-icon')['grid-row'], '1 / 3');
  assert.equal(css.get('.model-icon svg').width, '36px');
  assert.equal(css.get('.model')['font-size'], '15px');
  assert.equal(css.get('.speed').background, 'transparent');
  assert.match(template, /<div class="identity">\s*<span class="model-icon"[\s\S]*?<div class="model-line">[\s\S]*?<\/div>\s*<time class="timestamp" data-testid="timestamp"><\/time>\s*<\/div>\s*<div class="speed">/);
  assert.doesNotMatch(template, /class="meta-line"|class="card-right"/);
  assert.match(template, /data-testid="subagent-badge"[\s\S]*?<svg\b/);
  assert.match(template, /data-testid="proxy-badge"[\s\S]*?<svg\b/);
  assert.match(template, /<dl class="metrics">[\s\S]*?data-testid="output-value"[\s\S]*?class="metric ttft" data-testid="ttft"[\s\S]*?data-testid="ttft-value"[\s\S]*?data-testid="duration-value"[\s\S]*?data-testid="cache-value"/);
  assert.equal((template.match(/class="metric-icon"/g) ?? []).length, 4);
  assert.doesNotMatch(template, /🤖|📦|⏳|🍪|metric-label/);
  assert.equal(css.get('.record-card').position, 'relative');
  assert.match(html, /@keyframes card-insert/);
  assert.match(html, /@keyframes aurora-sweep/);
  assert.match(html, /@keyframes aurora-flash/);
  assert.match(html, /@keyframes star-float/);
  assert.match(html, /@keyframes dust-float/);
  assert.match(html, /const CARD_DUST = \[/);
  assert.match(html, /function decorateNewCard\(card\)/);
  assert.match(html, /function recordIdentity\(record\)/);
  assert.equal(css.get('.record-card .output').color, '#0066e6');
  assert.equal(css.get('html.dark .record-card .output').color, '#64b0ff');
  assert.equal(css.get('.settings-color-row')['justify-content'], 'flex-start');
  assert.equal(css.get('.settings-sheet')['--surface'], '#262628');
  assert.equal(css.get('.settings-sheet')['--ink'], '#ffffff');
  assert.equal(css.get('.settings-sheet')['--icon-color'], '#ffffff');
  assert.equal(css.get('.language-picker')['--ink'], '#1c1c1e');
  assert.equal(css.get('html.dark .language-picker')['--ink'], '#ffffff');
});

test('panel title links to the repository and shows an animated star badge beside the version', async () => {
  const html = await readFile(panelPath, 'utf8');
  const repoUrl = 'https://github.com/jecyxyf/Orca-TPS-Plugin';
  const brand = /<div class="panel-brand">([\s\S]*?)<div class="title-actions">/.exec(html)?.[1] ?? '';
  assert.match(brand, new RegExp(`<a[^>]*id="panel-repo-link"[^>]*href="${repoUrl}"[^>]*target="_blank"`));
  assert.match(brand, new RegExp(`id="panel-version"[\\s\\S]*?<a[^>]*id="panel-star-link"[^>]*href="${repoUrl}"[^>]*target="_blank"`));
  assert.match(brand, /<svg[^>]*class="panel-star-svg"[\s\S]*?star-core[\s\S]*?star-spark/);
  assert.match(html, /@keyframes star-pulse/);
  assert.match(html, /@keyframes star-sparkle/);
});

