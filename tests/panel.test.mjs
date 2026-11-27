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

test('per-request output uses tokens and aggregate usage formats millions to two decimal places', async () => {
  const html = await readFile(panelPath, 'utf8');
  const source = /const formatMillionTokens = tokens => \{[\s\S]*?\n    \};/.exec(html)?.[0];
  assert.ok(source);
  assert.match(html, /data-testid="output-value"><\/span><span class="metric-unit">tokens<\/span>/);
  const format = new Function('locale', `${source}\nreturn formatMillionTokens;`)({
    number: (value, options) => new Intl.NumberFormat('en', options).format(value)
  });
  assert.equal(format(501), '0.00 M');
  assert.equal(format(700_612), '0.70 M');
  assert.equal(format(1_250_000), '1.25 M');
  assert.equal(format(0), '0.00 M');
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

  // Model distribution section (#model-dist) and speedRow() must not reuse .speed or .speed-value classes.
  const rankingSection = html.match(/<section[^>]*\bid="model-dist"[^>]*>/i)?.[0] ?? '';
  assert.ok(rankingSection, 'model distribution section (#model-dist) must exist');
  const rankingClasses = (rankingSection.match(/\bclass="([^"]*)"/i)?.[1] ?? '').split(/\s+/);
  assert.ok(!rankingClasses.includes('speed'), '#model-dist section must not share the .speed pill class');
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
  assert.match(html, /const agentLabel = provider => AGENT_LABELS\[provider \|\| current\?\.activeSession\?\.provider\]/,
    'agentLabel must accept per-record provider override');
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
  const toolbar = /<section class="war" id="war"[^>]*>\s*<div class="war-controls">([\s\S]*?)<div class="war-tabs war-period-tabs"/.exec(html)?.[1];
  assert.ok(toolbar);
  const expectedModes = [['calendar', 'true'], ['hourly', 'false']];
  assert.deepEqual([...toolbar.matchAll(/data-usage-mode="([^"]+)" aria-pressed="([^"]+)"/g)]
    .map(match => match.slice(1)), expectedModes);
  assert.match(toolbar, /usage-mode-tabs/);
  assert.equal((toolbar.match(/<svg\b/g) ?? []).length, 2);
  const warTotals = /<div class="war-totals">([\s\S]*?)<\/div>\s*<\/section>/.exec(html)?.[1] ?? '';
  assert.equal((warTotals.match(/class="war-stat-icon\b/g) ?? []).length, 3);
  assert.doesNotMatch(warTotals, /class="war-label"/);
  assert.match(warTotals, /id="war-requests"[\s\S]*?id="war-requests-unit"[^>]*data-i18n="requests-unit"/);
  assert.match(warTotals, /class="war-stat-icon requests"[\s\S]*?M4 9h16/);
  assert.match(html, /\.war-totals\s*\{[^}]*grid-auto-flow:\s*column/);
  assert.match(html, /\.war-value\.speed-max\s*\{\s*color:\s*var\(--speed\)/);
  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.war-value')['font-size'], '20px');
  assert.equal(css.get('.war-value small')['font-size'], '11px');
  assert.equal(css.get('.war-stat-icon').width, '18px');
  assert.equal(css.get('.war-stat-icon svg').width, '17px');
  assert.equal(css.get('.war-agent-icon').width, '22px');
  assert.equal(css.get('.war-agent-icon svg').width, '20px');
  assert.equal(css.get('.war-model')['font-size'], '15px');
  assert.equal(css.get('.war-amount')['font-size'], '15px');
  assert.equal(css.get('.rank-tps')['font-size'], '15px');
  assert.equal(css.get('.rank-tps small')['font-size'], '11px');
  assert.equal(css.get('.rank-index')['font-size'], '13px');
  assert.equal(css.get('.war-meta')['font-size'], '12px');
  assert.equal(css.get('.war-meta-item svg').width, '13px');
  assert.equal(css.get('.war-period-tabs .war-tab')['font-size'], '13px');
  assert.equal(css.get('.usage-mode-tabs .war-tab').width, '32px');
  assert.equal(css.get('.usage-mode-tabs svg').width, '16px');
  assert.match(html, /@media \(max-width: 339px\)[\s\S]*?\.war-period-tabs \.war-tab \{ padding: 5px 3px; font-size: 12px; \}/);
  assert.match(html, /@media \(max-width: 339px\)[\s\S]*?\.war-value \{ font-size: 17px; \}/);
  assert.doesNotMatch(html, /speed-note|model-speed-description|model-speed-insufficient-samples|model-list-truncated|class="war-agent"/);
  assert.match(html, /id="war-share-bar"/);
  assert.deepEqual([...html.matchAll(/data-model-sort="([^"]+)" aria-pressed="([^"]+)"/g)]
    .map(match => match.slice(1)), [['usage', 'true'], ['speed', 'false']]);
  assert.equal(css.get('.model-sort-tabs')['grid-template-columns'], 'repeat(2, auto)');
  assert.equal(css.get('.model-sort-tabs')['margin-inline-start'], 'auto');
  assert.equal(css.get('.model-sort-tabs .war-tab').width, '32px');
  assert.equal(css.get('.model-sort-tabs svg').width, '16px');
  assert.ok(html.indexOf('.war-tabs {') < html.indexOf('.model-sort-tabs {'), '.model-sort-tabs must follow .war-tabs in cascade');
  const sortTabs = /<div class="war-tabs model-sort-tabs"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
  assert.equal((sortTabs.match(/<svg\b/g) ?? []).length, 2);
  assert.match(html, /const harnessBadge = \(provider, size = 18\) =>/);
  assert.match(html, /el\('span\.rank-index'[\s\S]*?\.\.\.icons\.values\(\),[\s\S]*?el\('span\.war-model'[\s\S]*?el\('span\.rank-tps'/);
  assert.match(html, /function warMetaMetric\(kind/);
  assert.match(html, /requests:\s*\['M4 9h16'/);
  assert.match(html, /speed:\s*\['M13 2 4 14h7l-1 8 9-12h-7l1-8Z'\]/);
  assert.match(html, /const requestsMetric = count => warMetaMetric\('requests'[\s\S]*?warMetaMetric\('speed'/);
  assert.doesNotMatch(html, /id="heat-sub"|id="heat-months"|id="heat-scroll"|class="heat-foot"|class="heat-legend"|heat-month-tile/);
  assert.match(html, /const HEAT_DAYS = 365;/);
  assert.match(html, /date\.setDate\(today\.getDate\(\) - offset\)/);
  assert.match(html, /t\('heatmap-active-days'/);
  assert.equal(css.get('#usage')['grid-template-rows'], 'auto minmax(150px, 1fr) auto');
  assert.equal(css.get('.heat').height, 'clamp(220px, 32dvh, 296px)');
  assert.equal(css.get('#war')['justify-content'], 'center');
  assert.equal(css.get('.usage-breakdown').display, 'contents');
  assert.equal(css.get('.heat-star-grid')['grid-template-columns'], 'repeat(23, minmax(0, 1fr))');
  assert.equal(css.get('.heat-cell')['border-radius'], '50%');
  assert.equal(css.get('.heat-cell')['clip-path'], undefined);
  assert.equal(css.get('.heat-cell.lv4')?.['clip-path'], undefined);
  assert.equal(css.get('.heat-tip')['white-space'], 'nowrap');
  assert.equal(css.get('.heat-tip').width, 'max-content');
  assert.match(html, /heatTip\.hidden = !cell[\s\S]*?heatTip\.style\.left = '0px';[\s\S]*?heatTip\.offsetWidth/);
  assert.match(html, /@keyframes star-fall\b[\s\S]*?@keyframes star-twinkle\b[\s\S]*?@keyframes star-ripple\b/);
  assert.match(html, /restartClass\(byId\('heat-grid'\), 'is-waking'\)/);
  assert.match(html, /clearTimeout\(starIntroTimer\)/);
  assert.match(css.get('.heat-cell.lv2').animation, /star-twinkle/);
  for (const name of ['star-twinkle', 'star-twinkle-bright']) {
    const frames = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n    \\}`).exec(html)?.[1] ?? '';
    assert.match(frames, /opacity[\s\S]*transform/, `${name} keeps its brightness and size pulse`);
    assert.doesNotMatch(frames, /box-shadow/, `${name} must not repaint a shadow every frame`);
  }
  assert.match(html, /\.heat-cell\.lv2::after, \.heat-cell\.lv3::after, \.heat-cell\.lv4::after \{[^}]*box-shadow: 0 0 8px rgb\(96 165 250 \/ 85%\);[^}]*animation: star-glow /);
  assert.match(html, /\.heat-cell\.lv4::after \{\s*box-shadow: 0 0 11px rgb\(125 211 252 \/ 98%\), 0 0 18px rgb\(56 189 248 \/ 75%\);/);
  assert.match(html, /@keyframes star-glow \{\s*0%, 100% \{ opacity: 0; \}\s*50% \{ opacity: 1; \}/);
  assert.match(html, /\.heat-cell\.is-still::after, \.heat-star-grid\.is-waking \.heat-cell::after \{ animation: none; opacity: 0; \}/);
  for (const level of ['.heat-cell.lv2', '.heat-cell.lv3', '.heat-cell.lv4']) {
    assert.match(css.get(level).animation, /calc\(var\(--star-dur, [\d.]+s\) \/ var\(--star-speed, 1\)\)/);
  }
  assert.equal(css.get('.heat-cell.is-still').animation, 'none');
  assert.match(html, /html\.is-motion-paused \*[\s\S]*?animation-play-state: paused !important;/);
  assert.match(html, /const paused = document\.hidden \|\| !panelInView;[\s\S]*?classList\.toggle\('is-motion-paused', paused\);[\s\S]*?dispatchEvent\(new Event\('tps-motion-changed'\)\)/);
  assert.match(html, /new IntersectionObserver\(/);
  assert.match(css.get('.heat-cell:hover::after').animation, /star-ripple/);
  assert.match(html, /class="ladder-controls-head"/);
  assert.equal(css.get('.ladder-total').background, 'transparent');
  assert.equal(css.get('.ladder-tabs .war-tab')['font-size'], '13px');
  assert.equal(css.get('.ladder-recent-meta').order, '-1');
  assert.equal(css.get('.ladder-recent-meta')['flex-direction'], 'row');
  assert.deepEqual([...html.matchAll(/data-ladder-mode="([^"]+)" aria-pressed="([^"]+)"/g)]
    .map(match => match.slice(1)), expectedModes);
  assert.match(html, /usageMode = 'calendar'/);
  assert.match(html, /rankingMode = 'calendar'/);
  assert.doesNotMatch(html, /RelativeTimeFormat/);
  assert.match(html, /usageRange === 'year' \? \(windows\?\.past365 \?\? windows\?\.year\) : windows\?\.\[usageRange\]/);
  const formatPeriodSrc = /function formatUsagePeriod\([\s\S]*?\n    \}/.exec(html)?.[0];
  assert.ok(formatPeriodSrc);
  const formatFor = lang => new Function('locale', 'document', `${formatPeriodSrc}\nreturn formatUsagePeriod;`)(
    { number: (value, options) => new Intl.NumberFormat(lang, options).format(value) },
    { documentElement: { lang } }
  );
  assert.equal(formatFor('zh-CN')(365, false), '365天');
  assert.equal(formatFor('zh-TW')(365, false), '365天');
  assert.equal(formatFor('zh-TW')(1, true), '24時');
  assert.equal(formatFor('ko')(365, false), '365일');
  assert.equal(formatFor('en')(365, false), '365 days');
  assert.doesNotMatch(html, /war-mode-help|war-mode-hint|usage-update-(?:help|hint)/);
});

test('model usage rows show the speed icon with a value or a dash', async () => {
  const html = await readFile(panelPath, 'utf8');
  const sources = [
    /const numeric = [^\n]+/,
    /function number\(value, fraction = 0\) \{[\s\S]*?\n      \}/,
    /function speedText\(tps\) \{[\s\S]*?\n      \}/,
    /const SVG_NS = [^\n]+/,
    /function el\(spec[\s\S]*?\n    \}/,
    /function warMetaMetric\([\s\S]*?\n      \}/,
    /const requestsMetric = [\s\S]*?\);\r?\n/,
    /function usageRow\([\s\S]*?\n      \}/
  ].map(pattern => pattern.exec(html)?.[0]);
  assert.ok(sources.every(Boolean));

  const createElement = () => ({
    children: [],
    append(...children) { this.children.push(...children); },
    setAttribute() {}
  });
  const locale = { number: (value, options) => new Intl.NumberFormat('en-US', options).format(value) };
  const render = new Function('document', 'locale', 'metricSvg', 'harnessBadge', [
    'const t = String, formatCount = String, formatMillionTokens = String;',
    ...sources,
    'return usageRow;'
  ].join('\n'))({ createElement }, locale, kind => ({ kind }), createElement);

  const row = { model: 'example', provider: 'codex', requests: 2, tokens: 1_000 };
  for (const [value, expected] of [[undefined, '-'], [0, '-'], [72.5, '73 tokens/s'], [0.5, '0.5 tokens/s']]) {
    const speeds = value === undefined ? new Map() : new Map([[row.model, value]]);
    const [, meta] = render(row, speeds).children;
    const [, metric] = meta.children;
    assert.ok(metric, 'every model row must include the speed metric');
    const [icon, text] = metric.children;
    assert.equal(icon.kind, 'speed');
    assert.equal(text.textContent, expected);
  }

  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.war-meta-item.is-speed')['min-width'], 'min(var(--war-speed-width, 0px), 55%)');
  assert.equal(css.get('.rank-tps')['min-width'], 'min(var(--war-speed-width, 0px), 45%)');
  const alignFn = /function alignWarSpeedIcons\(\) \{[\s\S]*?\n      \}/.exec(html)?.[0];
  assert.ok(alignFn, 'alignWarSpeedIcons helper must exist');
  const props = new Map();
  const warRows = {
    style: {
      removeProperty(name) { props.delete(name); },
      setProperty(name, value) { props.set(name, value); }
    },
    querySelectorAll() {
      return [68.2, 74.1, 21.4].map(width => ({ getBoundingClientRect: () => ({ width }) }));
    }
  };
  new Function('byId', 'usageGroup', `${alignFn}; alignWarSpeedIcons();`)(() => warRows, { hidden: false });
  assert.equal(props.get('--war-speed-width'), '75px');
  assert.match(html, /alignWarSpeedIcons\(\);\s*renderHeatmap\(today\);/);
  assert.match(html, /warResizeObserver[\s\S]*?alignWarSpeedIcons\(\)/);
});

test('Personal Stats counts up top totals and shows model deltas before counting to targets', async () => {
  const html = await readFile(panelPath, 'utf8');
  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.war-delta').position, 'absolute');
  assert.equal(css.get('.war-delta')['font-size'], '12px');
  assert.match(css.get('.war-delta').animation, /^war-delta-pop 3\.2s /);
  assert.match(css.get('.war-row-flash').animation, /^war-jackpot-bg 2\.4s /);
  assert.match(html, /@keyframes war-delta-pop\b/);
  assert.match(html, /@keyframes war-jackpot-sweep\b/);
  assert.match(html, /@keyframes war-harness-jump\b/);
  assert.match(html, /\.war-row\.is-jackpot \.war-agent-icon,\s*\.record-card\.is-entering \.model-icon \{[^}]*animation: war-harness-jump 1\.6s ease-out 1;/);
  assert.match(html, /@keyframes war-value-surge\b/);
  assert.match(html, /const USAGE_COUNT_MS = 2000;/);

  const helpers = /const USAGE_COUNT_MS = [\s\S]*?(?=\n      const usageGroup = byId\('usage'\);)/.exec(html)?.[0];
  const funcs = /function setNodeText\([\s\S]*?(?=\n      const usageRangeTabs = )/.exec(html)?.[0];
  const syncFn = /function syncUsageTotal\([\s\S]*?\n      \}/.exec(html)?.[0];
  const domHelpers = [/const SVG_NS = [^\n]+/, /function el\(spec[\s\S]*?\n    \}/, /function restartClass\([\s\S]*?\n    \}/]
    .map(pattern => pattern.exec(html)?.[0]);
  assert.ok(helpers && funcs && syncFn && domHelpers.every(Boolean));

  const frames = [];
  const makeNode = (text = '') => {
    const classes = new Set();
    const node = {
      isConnected: true,
      children: [],
      firstChild: text ? { nodeType: 3, nodeValue: text } : null,
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      get textContent() { return this.firstChild ? this.firstChild.nodeValue : ''; },
      set textContent(v) { this.firstChild = { nodeType: 3, nodeValue: v }; this.children = []; },
      append(...items) { this.children.push(...items); },
      prepend(item) { this.firstChild = item; this.children.unshift(item); },
      querySelectorAll(sel) {
        if (sel === '.war-delta') return this.children.filter(c => c.className === 'war-delta');
        if (sel === '.war-row-flash') return this.children.filter(c => c.className === 'war-row-flash');
        return [];
      },
      addEventListener() {},
      setAttribute(name, value) { if (name === 'class') this.className = value; },
      remove() {}
    };
    return node;
  };
  let now = 1000;
  const document = {
    createElement: () => makeNode(),
    createTextNode: text => ({ nodeType: 3, nodeValue: text })
  };
  const usageGroup = makeNode();
  usageGroup.hidden = false;
  const run = new Function('document', 'usageGroup', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'numeric', `
    let disposed = false;
    ${domHelpers.join('\n')}
    ${helpers}
    ${funcs}
    ${syncFn}
    return { activeUsageCounters, syncUsageTotal, scheduleUsageCounter, stepUsageCounters, attachWarDelta, attachWarRowFlash, setNodeText, stopUsageAnimations };
  `)(document, usageGroup, cb => { frames.push(cb); return frames.length; }, () => {}, { now: () => now }, v => typeof v === 'number' && Number.isFinite(v) && v >= 0);

  const totalEl = makeNode('100.00 M');
  run.syncUsageTotal('total:tokens', totalEl, 110_000_000, 100_000_000, true, v => `${(v / 1e6).toFixed(2)} M`, (a, b) => b > a);
  assert.equal(totalEl.textContent, '100.00 M');
  assert.equal(totalEl.classList.contains('is-counting'), true);
  assert.equal(totalEl.children.filter(c => c.className === 'war-delta').length, 0);

  const rowEl = makeNode();
  const rowAmount = makeNode('50.00 M');
  run.attachWarRowFlash(rowEl);
  run.attachWarDelta(rowAmount, '+10.00 M');
  run.scheduleUsageCounter('row:tokens:m', { node: rowAmount, from: 50_000_000, to: 60_000_000, apply: v => run.setNodeText(rowAmount, `${(v / 1e6).toFixed(2)} M`) });
  assert.equal(rowEl.classList.contains('is-jackpot'), true);
  assert.equal(rowEl.children.filter(c => c.className === 'war-row-flash').length, 1);
  assert.equal(rowAmount.children.filter(c => c.className === 'war-delta')[0].textContent, '+10.00 M');
  assert.equal(rowAmount.classList.contains('is-counting'), true);

  now = 1900;
  frames.shift()(now);
  assert.ok(parseFloat(totalEl.textContent) > 100 && parseFloat(totalEl.textContent) < 110);
  assert.ok(parseFloat(rowAmount.firstChild.nodeValue) > 50 && parseFloat(rowAmount.firstChild.nodeValue) < 60);
  assert.equal(rowAmount.children.filter(c => c.className === 'war-delta').length, 1);

  now = 3200;
  frames.shift()(now);
  assert.equal(totalEl.textContent, '110.00 M');
  assert.equal(rowAmount.firstChild.nodeValue, '60.00 M');
  assert.equal(totalEl.classList.contains('is-counting'), false);
  assert.equal(rowAmount.classList.contains('is-counting'), false);
  assert.equal(run.activeUsageCounters.size, 0);
  assert.match(html, /if \(byId\('usage'\)\.hidden\) stopUsageAnimations\(true\);/);
  assert.match(html, /usageViewSnapshots\.set\(viewKey,/);
});

test('today usage renders a heartbeat ECG stage with royal characters driven by recent activity', async () => {
  const html = await readFile(panelPath, 'utf8');
  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.ladder-chart').background, 'transparent');
  assert.equal(css.get('.ladder-chart').height, '42px');
  assert.match(html, /if \(rankDays === 7\)[\s\S]*?dailyUsagePath\(points, x, y\)[\s\S]*?const cols = points\.length, dotRows = 6;/);
  assert.match(html, /function stepChartAnimation\(now\)[\s\S]*?function scheduleChartAnimation\(\)/);
  assert.match(html, /const triggerChartIntro = \(\) => \{\s*if \(rankDays > 1\) chartIntroAt = /);
  assert.match(html, /addEventListener\('tps-motion-changed'/);
  assert.match(html, /\.hb-stage:not\(\.is-in-view\) \*, #leaderboard\[hidden\] \.hb-stage \* \{ animation-play-state: paused !important; \}/);
  assert.match(html, /@keyframes ch-sprint-bob\b[\s\S]*?@keyframes ecg-sweep\b/);

  const hbBlock = /const ROYAL_TIERS = [\s\S]*?(?=\n      const usageChartLabel = )/.exec(html)?.[0];
  const usageCardSrc = /function usageCard\([\s\S]*?\n      \}/.exec(html)?.[0];
  const toolLabelSrc = /function toolLabel\([\s\S]*?\n      \}/.exec(html)?.[0];
  const elSrc = /function el\(spec[\s\S]*?\n    \}/.exec(html)?.[0];
  assert.ok(hbBlock && usageCardSrc && toolLabelSrc && elSrc);

  const observed = [];
  function createEl() {
    const attrs = new Map();
    return {
      attributes: attrs, dataset: {}, children: [], style: { setProperty() {} },
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(k, v) {
        attrs.set(k, v);
        if (k === 'title') this.title = v;
      },
      getAttribute(k) { return attrs.get(k); },
      append(...items) { this.children.push(...items); },
      addEventListener() {}
    };
  }
  const IntersectionObserver = function() {
    return { observe(target) { observed.push(target); }, disconnect() {} };
  };
  const { recentHeartbeatBpm, poseFromBpm, usageCard } = new Function(
    'document', 'group', 'IntersectionObserver', 'SVG_NS', 't', 'formatMillionTokens', 'speedText', 'shortClock', 'toolText', 'createHarnessIconBadge', 'usageChartLabel', `
      const RECENT_STATS_MS = 300000, DAY_MS = 86400000, rankDays = 1, rankingMode = 'calendar';
      const locale = { date: () => '11/26' }, usagePainters = new WeakMap();
      function dailyUsagePoints() { return []; }
      function dailyUsagePath() { return {}; }
      ${elSrc}
      ${toolLabelSrc}
      ${hbBlock}
      ${usageCardSrc}
      return { recentHeartbeatBpm, poseFromBpm, usageCard };
    `
  )(
    { createElement: createEl, createElementNS: () => createEl() },
    { querySelector: () => ({}) },
    IntersectionObserver,
    'http://www.w3.org/2000/svg',
    key => key,
    v => `${v} M`,
    v => `${v} tokens/s`,
    () => '12:00:00',
    (m, c) => `${m} · ${c}`,
    () => createEl(),
    () => 'Recent usage'
  );

  const now = 1_000_000;
  assert.equal(recentHeartbeatBpm([], now), 0);
  assert.equal(poseFromBpm(0).key, 'flat');
  assert.equal(poseFromBpm(1).key, 'idle');
  assert.equal(poseFromBpm(45).key, 'idle');
  assert.equal(poseFromBpm(50).key, 'idle');
  assert.equal(poseFromBpm(51).key, 'walk');
  assert.equal(poseFromBpm(78).key, 'walk');
  assert.equal(poseFromBpm(100).key, 'walk');
  assert.equal(poseFromBpm(101).key, 'run');
  assert.equal(poseFromBpm(108).key, 'run');
  assert.equal(poseFromBpm(150).key, 'run');
  assert.equal(poseFromBpm(151).key, 'sprint');
  const sprintBpm = recentHeartbeatBpm([
    { submittedAt: now - 40_000 }, { submittedAt: now - 20_000 }, { submittedAt: now - 5_000 }
  ], now);
  assert.ok(sprintBpm >= 151 && sprintBpm <= 200, 'dense recent uploads trigger sprinting BPM within cap');
  assert.equal(poseFromBpm(sprintBpm).key, 'sprint');
  const cappedBpm = recentHeartbeatBpm(Array.from({ length: 6 }, (_, i) => ({ submittedAt: now - (i + 1) * 5_000 })), now);
  assert.equal(cappedBpm, 200, 'rocket heartbeat BPM is capped at 200');

  const empty = usageCard({ rank: 1, recent: { points: [] } }, now, Infinity);
  const [emptyMeta, emptyStage] = empty.children;
  assert.equal(emptyMeta.children[0].children.length, 0, 'missing model and CLI omits placeholder dashes');
  assert.equal(emptyMeta.children.at(-1).textContent, '0 tokens/s');
  assert.equal(emptyStage.title, 'Recent usage\n0 M · 0 tokens/s');
  assert.equal(observed.length, 1);

  const active = usageCard({
    rank: 1,
    recent: { topModel: 'claude-opus', topCli: 'claude', points: [{ submittedAt: now - 10_000, deltaTokens: 100, avgTps: 88 }] }
  }, now, Infinity);
  assert.match(active.children[1].children[0].children[0].innerHTML, /pose-walk|ch-body/);
  assert.equal(active.children[1].children[2].title, 'pose-walk');
  assert.equal(active.children[1].children[2].children.length, 1);

  const rocket = usageCard({
    rank: 1,
    recent: { topModel: 'claude-opus', topCli: 'claude', points: [
      { submittedAt: now - 40_000, deltaTokens: 100, avgTps: 120 },
      { submittedAt: now - 20_000, deltaTokens: 100, avgTps: 120 },
      { submittedAt: now - 5_000, deltaTokens: 100, avgTps: 120 }
    ] }
  }, now, Infinity);
  assert.match(rocket.children[1].children[0].children[0].innerHTML, /ch-flame/);

  const car = usageCard({
    rank: 2,
    recent: { topModel: 'claude-opus', topCli: 'claude', points: [
      { submittedAt: now - 90_000, deltaTokens: 100, avgTps: 90 },
      { submittedAt: now - 15_000, deltaTokens: 100, avgTps: 90 }
    ] }
  }, now, Infinity);
  assert.match(car.children[1].children[0].children[0].innerHTML, /ch-wheel/);
});

test('usage rankings omit the subtitle beneath the period selector', async () => {
  const html = await readFile(panelPath, 'utf8');
  assert.doesNotMatch(html, /ladder-recent-caption|leaderboard-cutoff/);
  assert.match(html, /el\('canvas\.ladder-chart', \{[^}]*'aria-label': usageChartLabel\(\)/);
});

test('leaderboard ranks assign royal tier badges and speed tab marks top three with S', async () => {
  const html = await readFile(panelPath, 'utf8');
  const tiers = /const ROYAL_TIERS = \[[\s\S]*?\];/.exec(html)?.[0];
  const tierOf = /const royalTierOf = [^\n]+;/.exec(html)?.[0];
  const badgeFn = /function rankBadge\(rank, speedBoard = false\) \{[\s\S]*?\n      \}/.exec(html)?.[0];
  const elFn = /function el\(spec[\s\S]*?\n    \}/.exec(html)?.[0];
  assert.ok(tiers && tierOf && badgeFn && elFn);

  const document = { createElement() {
    const attrs = {};
    return {
      attributes: attrs, dataset: {},
      setAttribute(k, v) { attrs[k] = v; },
      append() {}
    };
  } };
  const makeBadge = new Function('document', 't', `
    ${elFn}
    ${tiers}
    ${tierOf}
    ${badgeFn}
    return rankBadge;
  `)(document, key => key);

  assert.equal(makeBadge(1, false).textContent, 'tier-challenger');
  assert.equal(makeBadge(2, false).textContent, 'tier-grandmaster');
  assert.equal(makeBadge(3, false).textContent, 'tier-master');
  assert.equal(makeBadge(8, false).textContent, 'tier-diamond');
  assert.equal(makeBadge(24, false).textContent, 'tier-emerald');
  assert.equal(makeBadge(48, false).textContent, 'tier-platinum');
  assert.equal(makeBadge(88, false).textContent, 'tier-gold');
  assert.equal(makeBadge(1, true).textContent, 'S · tier-challenger');
  assert.equal(makeBadge(3, true).textContent, 'S · tier-master');
  assert.equal(makeBadge(4, true).textContent, 'tier-diamond');
  assert.equal(makeBadge(0, false), null);

  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.ladder-user-stats').display, 'grid');
  assert.equal(css.get('.ladder-rows .ladder-speed-row')['--ladder-row-size'], '28px');
  assert.equal(css.get('.rank-badge').height, '18px');
  assert.equal(css.get('.rank-badge')['justify-content'], 'center');
  assert.equal(css.get('.rank-badge')['min-width'], 'var(--ladder-badge-width, 0px)');
  assert.equal(css.get('.ladder-user-stat .ladder-badge-slot .rank-badge').height, '18px');
  assert.match(html, /function alignLadderBadges\(container\)/);
  assert.match(html, /alignLadderBadges\(element\('rows'\)\)/);
  assert.match(html, /alignLadderBadges\(element\('personal-ranks'\)\)/);
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
  assert.equal(css.get('.ladder-user-stat').display, 'flex');
  assert.equal(css.get('.ladder-user-stat').background, 'transparent');
  assert.equal(css.get('.ladder-controls-actions').display, 'flex');
  assert.equal(css.get('.ladder-upload-sub').display, 'inline-flex');
  assert.equal(css.get('.ladder-logout-btn').width, '28px');
  assert.match(html, /id="ladder-controls"[\s\S]*?id="ladder-upload-wrap"[\s\S]*?id="ladder-logout"[\s\S]*?id="ladder-personal-data"/);
  assert.match(html, /<section class="ladder-rank-card"/);
  assert.equal(css.get('.ladder-rank-card').padding, '2px 0 0');
  assert.equal(css.get('.ladder-rows').display, 'flex');
  assert.equal(css.get('.ladder-rows li')['border-radius'], '16px');
  assert.equal(css.get('.hb-stage').background, undefined);
  assert.equal(css.get('.ladder-transfer.is-spinning .ladder-transfer-spinner').animation, 'spin 1s linear infinite');
  assert.match(html, /transferSpinTimers\.set\(indicator, setTimeout\([\s\S]*?classList\.add\('is-spinning'\)[\s\S]*?\}, 1000\)\)/);
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
      attrs, classes, classList: {
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
        add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)
      },
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
  assert.equal(upload.classes.has('is-spinning'), false, 'short transfers keep the static icon');
  assert.deepEqual(state(download), ['false', 'period-rankings']);
  render({ rankingPending: true });
  assert.deepEqual(state(upload), ['false', 'data-upload']);
  assert.equal(upload.classes.has('is-spinning'), false);
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
  assert.match(dialog, /id="settings-record-card-style"[\s\S]*?id="settings-star-twinkle"[\s\S]*?data-i18n="settings-star-twinkle"[\s\S]*?id="settings-star-reset"[^>]*disabled[\s\S]*?class="settings-star-grid"/);
  assert.match(dialog, /id="settings-star-ratio"[^>]*type="range" min="0" max="100" step="10" value="100"/);
  assert.match(dialog, /id="settings-star-speed"[^>]*type="range" min="0" max="2" step="0\.1" value="1"/);
  assert.match(dialog, /id="settings-star-ratio-value">100%</);
  assert.match(dialog, /id="settings-star-speed-value">1\.0×</);
  assert.match(html, /const STAR_RATIO_KEY = 'tps:panel-star-ratio';\s*const STAR_SPEED_KEY = 'tps:panel-star-speed';/);
  assert.match(html, /function applyStarTwinkle\(\{ ratio, speed \}, persist = false\)[\s\S]*?Math\.max\(0, rawSpeed\)[\s\S]*?root\.dataset\.starRatio = String\(starSpeed === 0 \? 0 : starRatio\)[\s\S]*?setProperty\('--star-speed'[\s\S]*?dispatchEvent\(new Event\('tps-star-twinkle-changed'\)\)/);
  assert.match(html, /starReset\.addEventListener\('click', \(\) => applyStarTwinkle\(\{ ratio: 100, speed: 1 \}, true\)\)/);
  assert.match(html, /function applyStarRatio\(\)[\s\S]*?\.filter\(\(\{ cell \}\) => \/\\blv\[2-4\]\\b\/\.test\(cell\.className\)\)[\s\S]*?const twinkling = Math\.round\(lit\.length \* ratio \/ 100\);[\s\S]*?cell\.classList\.toggle\('is-still', index >= twinkling\)/);
  assert.match(html, /addEventListener\('tps-star-twinkle-changed', applyStarRatio/);
  assert.match(dialog, /id="settings-star-twinkle"[\s\S]*?id="settings-harness-motion"[\s\S]*?data-i18n="settings-harness-motion"[\s\S]*?id="settings-harness-reset"[^>]*disabled[\s\S]*?id="settings-harness-interval"[^>]*type="range" min="0" max="10" step="1" value="5"[\s\S]*?id="settings-harness-interval-value">5s</);
  assert.match(html, /const HARNESS_INTERVAL_KEY = 'tps:panel-harness-interval';/);
  assert.match(html, /function applyHarnessInterval\(value, persist = false\)[\s\S]*?dataset\.harnessInterval = String\(harnessInterval\)[\s\S]*?dispatchEvent\(new Event\('tps-harness-interval-changed'\)\)/);
  assert.match(html, /harnessReset\.addEventListener\('click', \(\) => applyHarnessInterval\(5, true\)\)/);
  assert.match(html, /const HARNESS_IDLE_ACTIONS = \['is-acting-hop', 'is-acting-wiggle', 'is-acting-peek', 'is-acting-spin', 'is-acting-jiggle'\];/);
  for (const name of ['hop', 'wiggle', 'peek', 'spin', 'jiggle']) {
    assert.match(html, new RegExp(`@keyframes harness-idle-${name}\\b`));
  }
  assert.match(html, /function triggerHarnessIdleAction\(\)[\s\S]*?clearHarnessIdle\(\)/);
  assert.doesNotMatch(dialog, /id="language-picker"|settings-timezone|settings-bg-zoom|settings-bg-preview/);

  const editor = /<div[^>]*id="bg-editor"[^>]*role="dialog"[\s\S]*?(?=\n\s*<template id="ladder-avatar-fallback">)/.exec(html)?.[0] ?? '';
  assert.ok(editor, 'full-panel background editor must exist');
  assert.doesNotMatch(editor, /id="bg-editor-stage"|id="bg-editor-img"|id="bg-crop-box"/);
  assert.match(editor, /id="bg-editor-reset-pos"/);
  assert.match(editor, /id="bg-editor-cancel"/);
  assert.match(editor, /id="bg-editor-save"/);
  assert.match(html, /async function readOriginalBg\(/);
  assert.match(html, /async function writeOriginalBg\(/);
  assert.match(html, /async function saveCroppedBgToStore\(/);
  assert.match(html, /function computeBgLayout\(/);
  assert.match(html, /const sourceUrl = useOriginal \? origUrl : croppedBgUrl;/);
  assert.doesNotMatch(html, /if \(hasBgImage\) void readOriginalBg\(\)/, 'original image loads only when editing');

  const css = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(css.get('.settings-backdrop').position, 'fixed');
  assert.equal(css.get('.settings-backdrop').background, 'transparent');
  assert.equal(css.get('.settings-backdrop')['backdrop-filter'], undefined, 'the panel behind settings stays sharp');
  assert.doesNotMatch(html, /html\.dark \.settings-backdrop/);
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
  assert.equal(css.get('.war-controls').display, 'grid');
  assert.equal(css.get('.war-period-tabs').width, '100%');
  assert.equal(css.get('.usage-breakdown .section-title')['font-size'], '14px');
  assert.equal(css.get('.model-dist-head')['border-bottom'], '1px solid var(--line)');
  assert.equal(css.get('.rank-tps').background, 'transparent');
  assert.equal(css.get('.stacked-bar').height, '11px');
  assert.equal(css.get('.heat-head')['border-bottom'], '1px solid var(--line)');

  assert.equal(css.get('.metrics')['grid-template-columns'], 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)');
  const cardCode = /function formatTps\(record\) \{[\s\S]*?(?=\n      \/\/ 用量战况)/.exec(html)?.[0] ?? '';
  assert.ok(cardCode);
  assert.doesNotMatch(html, /≈/);
  const template = /<template id="record-template">([\s\S]*?)<\/template>/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(template, /data-testid="agent"|class="agent"/);
  assert.match(template, /class="model-icon"[^>]*data-testid="harness-icon"[\s\S]*?<use[^>]*href="#harness-default"/);
  const sprite = await readFile(path.join(path.dirname(panelPath), 'harness-icons.svg'), 'utf8');
  assert.match(html, /<svg id="harness-sprite"[^>]*><\/svg>/);
  assert.match(html, /if \(typeof icons === 'string'\) byId\('harness-sprite'\)\.innerHTML = icons;/);
  for (const id of ['claude', 'claude-desktop', 'codex', 'gemini', 'grokbuild', 'opencode', 'openclaw', 'hermes', 'pi', 'mcode', 'kimi', 'omp', 'antigravity', 'copilot', 'workbuddy', 'dsh', 'default']) {
    assert.match(sprite, new RegExp(`<symbol id="harness-${id}"`));
  }
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
  assert.match(template, /class="metric output"[\s\S]*?M12 15V3m-4 4 4-4 4 4/);
  assert.match(template, /class="metric cache"[\s\S]*?M3 5v14a9 3 0 0 0 18 0V5/);
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
  assert.doesNotMatch(/@keyframes star-pulse \{[\s\S]*?\n    \}/.exec(html)?.[0] ?? '', /filter/);
  const brandCss = cascadeTopLevelCss(html.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.equal(brandCss.get('.panel-star-svg .star-core').animation, 'star-pulse 2.8s ease-in-out 3 both');
  assert.equal(brandCss.get('.panel-star-svg .star-spark').animation, 'star-sparkle 2.8s ease-in-out 3 both');
  assert.match(html, /\.panel-star-link:hover \.star-core[^{]*\{ animation-iteration-count: infinite; \}/);
  assert.match(html, /@keyframes star-sparkle/);
});

