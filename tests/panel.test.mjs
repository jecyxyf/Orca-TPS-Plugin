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
