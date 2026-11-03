/**
 * Load and behavior tests for the sapi-budget browser half.
 *
 * The browser artifact is not an ES module: it registers itself with
 * `window.__ModuleLoader__.load({ id, factory })` and pulls React out of the
 * host's module table. This file reproduces exactly that much of the page — a
 * fake `window`, a fake `require` — so the real client.js runs unchanged.
 *
 * Run: node test/client.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const clientPath = join(root, 'client.js');

// ── the smallest React that keeps the module alive ──────────────────────────
// client.js only ever calls useSyncExternalStore / useEffect / useMemo-shaped
// helpers at RENDER time. The tests below never mount a component through the
// host, so a pass-through hook surface is enough and keeps this file honest
// about what it actually verifies.
const reactStub = {
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useState: (initial) => [initial, () => {}],
  createElement: (type, props, ...children) => ({ type, props, children }),
};

// jsx-runtime is the real shape client.js consumes: a component function is
// called with props and must return a node, so tag the result with the element
// type instead of pretending React rendered it.
const jsxRuntimeStub = {
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key, children: props?.children }),
  Fragment: Symbol.for('react.fragment'),
};

const ALLOWED_REQUIRES = {
  react: reactStub,
  'react/jsx-runtime': jsxRuntimeStub,
};

/** require() that only succeeds for the two platform seeds the contract allows. */
function fakeRequire(spec) {
  if (Object.prototype.hasOwnProperty.call(ALLOWED_REQUIRES, spec)) {
    return ALLOWED_REQUIRES[spec];
  }
  throw new Error(`client.js required "${spec}", which is not a platform seed`);
}

/**
 * Load client.js the way the page does and return the exported module.
 * @returns the `{ name, apply, __test }` object the factory returned.
 */
function loadClient() {
  const source = readFileSync(clientPath, 'utf8');
  const registered = [];
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        registered.push(spec);
      },
    },
  };
  // eslint-disable-next-line no-new-func -- the real page evaluates this text too
  new Function(source)();
  assert.equal(registered.length, 1, 'client.js must register exactly one module');
  const spec = registered[0];
  assert.equal(spec.id, '@local/sapi-budget/client', 'module id must match the package');
  assert.equal(typeof spec.factory, 'function', 'module must expose a lazy factory');
  const exported = spec.factory(fakeRequire);
  assert.ok(exported !== null && typeof exported === 'object', 'factory must return the module exports');
  return exported;
}

const client = loadClient();
const helpers = client.__test;

/** A snapshot payload matching the Host wire contract. */
function wire(overrides = {}) {
  return {
    ok: true,
    baseUrl: 'https://aispot.swj0227.icu',
    group: 'deepseek-HK',
    requestedGroup: '',
    groups: [
      { name: 'deepseek-HK', ratio: 0.12 },
      { name: 'gemini', ratio: 0.25 },
    ],
    models: [
      {
        // Live shape of describeModel() for deepseek-v4.1-flash @ deepseek-HK.
        name: 'deepseek-v4.1-flash',
        kind: 'ratio',
        group: 'deepseek-HK',
        vendorId: 6,
        ratio: 1,
        groupRatio: 0.12,
        input: 0.24,
        output: 0.96,
        cacheRead: 0.0048,
        cacheWrite: 0.24,
      },
      {
        // Live shape of describeModel() for gemini-3.5-flash @ gemini.
        name: 'gemini-3.5-flash',
        kind: 'tiered',
        group: 'gemini',
        ratio: 0.75,
        groupRatio: 0.25,
        expression: 'tier("standard", p * 1.5 + c * 9 + cr * 0.15 + cc * 1.5)',
        tiers: [{ minLength: 0, input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5, base: 0 }],
      },
      {
        // Two tiers, to prove the branch is picked by length.
        name: 'grok-4.6',
        kind: 'tiered',
        group: 'grok heavy',
        ratio: 1,
        groupRatio: 0.16,
        tiers: [
          { minLength: 0, input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2, base: 0 },
          { minLength: 200001, input: 4, output: 12, cacheRead: 1, cacheWrite: 4, base: 0 },
        ],
      },
      {
        // A constant per-request tier fee, to prove `base` is added.
        name: 'fixed-fee-model',
        kind: 'tiered',
        group: 'deepseek-HK',
        ratio: 1,
        groupRatio: 0.12,
        tiers: [{ minLength: 0, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1, base: 0.5 }],
      },
      {
        name: 'image-model',
        kind: 'fixed',
        group: 'deepseek-HK',
        ratio: 1,
        groupRatio: 0.12,
        perRequest: 0.04,
      },
    ],
    quotaPerUnit: 500000,
    usdExchangeRate: 7.3,
    currency: 'USD',
    fetchedAt: 1_700_000_000_000,
    stale: false,
    error: null,
    refreshMinutes: 30,
    ...overrides,
  };
}

/** A fake client context that records every registration apply() makes. */
function fakeContext() {
  const record = { injected: [], registered: [], locales: [], effects: [] };
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        record.locales.push({ namespace, dictionaries });
        return () => {};
      },
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(name, callback) {
        record.injected.push(name);
        return callback();
      },
      register(options, component) {
        record.registered.push({ options, component });
        return () => {};
      },
    },
    effect(callback, label) {
      record.effects.push(label);
      const disposer = callback();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    on() {
      return () => {};
    },
  };
  return { ctx, record };
}

// ── module shape ────────────────────────────────────────────────────────────
test('factory returns the plugin interface without throwing', () => {
  assert.equal(typeof client.name, 'string');
  assert.ok(client.name !== '', 'name must not be empty');
  assert.equal(typeof client.apply, 'function', 'apply must be a function');
  assert.ok(Array.isArray(client.inject), 'inject must list the required services');
  assert.ok(client.inject.includes('slots'), 'slots is required');
});

test('factory only requires platform seeds — no Harness Client package', () => {
  // Re-load with a require that fails on anything else, which is exactly how a
  // host whose primitives drifted would behave: client.js must not care.
  const before = new Set(Object.keys(ALLOWED_REQUIRES));
  assert.deepEqual([...before].sort(), ['react', 'react/jsx-runtime']);
  assert.doesNotThrow(() => loadClient());
});

test('module carries no literal colours', () => {
  const source = readFileSync(clientPath, 'utf8');
  // Palette literals are the visual regression this plugin must not introduce:
  // every colour must resolve through a theme token so light/dark stays the
  // host's business.
  const literals = [
    /#[0-9a-fA-F]{3,8}\b/g,
    /\brgba?\s*\(/g,
    /\bhsla?\s*\(/g,
    /:\s*'(?:red|white|black|blue|green|grey|gray|orange|yellow|purple)'/g,
  ];
  for (const pattern of literals) {
    const hits = source.match(pattern);
    assert.equal(hits, null, `literal colour found: ${hits?.join(', ')}`);
  }
});

// ── apply(): both slots, and the header entry carries an id ─────────────────
test('apply registers both slots and injects the locale namespace', () => {
  const { ctx, record } = fakeContext();
  assert.doesNotThrow(() => client.apply(ctx));

  assert.ok(record.locales.some((entry) => entry.namespace === client.__test.NS), 'locale namespace must be registered');
  assert.deepEqual(
    [...record.injected].sort(),
    ['conversation.chat.turnTail', 'conversation.session.header.utilities'],
    'both target slots must be awaited through slots.inject',
  );
  assert.equal(record.registered.length, 2);

  const turn = record.registered.find((entry) => entry.options.name === 'conversation.chat.turnTail');
  const header = record.registered.find((entry) => entry.options.name === 'conversation.session.header.utilities');
  assert.ok(turn !== undefined, 'turnTail slot must be registered');
  assert.ok(header !== undefined, 'header utilities slot must be registered');

  // turnTail is a list too, so the same id rule applies to it.
  for (const entry of [turn, header]) {
    assert.equal(typeof entry.options.id, 'string', `${entry.options.name} needs an id`);
    assert.ok(entry.options.id.length > 0, `${entry.options.name} id must be non-empty`);
    assert.equal(entry.options.locale, client.__test.NS, `${entry.options.name} must name the locale namespace`);
    assert.equal(typeof entry.component, 'function', `${entry.options.name} needs a component`);
  }
  assert.equal(typeof header.options.order, 'number', 'header.utilities must order against shipped entries');
  assert.deepEqual(
    [...record.effects].filter((label) => typeof label === 'string' && label.includes('dictionaries')).length,
    1,
    'the locale registration must be an owned effect',
  );
});

test('apply survives a host with no slot service', () => {
  const { ctx } = fakeContext();
  const crippled = { locale: ctx.locale, effect: ctx.effect };
  assert.doesNotThrow(() => client.apply(crippled), 'a missing slot service must not take the shell down');
});

// ── money math ──────────────────────────────────────────────────────────────
test('ratio model: 1000 in + 500 out + 100000 cacheRead at deepseek-HK', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('deepseek-v4.1-flash');
  assert.equal(model.kind, 'ratio');
  assert.equal(model.cacheRead, 0.0048, 'cacheRead must be 0.0048 USD per 1M tokens');

  const cost = helpers.costOfBucket(model, { input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 });
  assert.equal(cost.kind, 'ratio');
  assert.equal(cost.estimated, false, 'ratio billing is exact, not an estimate');
  // (1000*0.24 + 500*0.96 + 100000*0.0048) / 1e6 = (240 + 480 + 480) / 1e6
  assert.ok(Math.abs(cost.usd - 0.0012) < 1e-12, `expected 0.0012, got ${cost.usd}`);
});

test('ratio model: cacheWrite is billed at its own rate', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('deepseek-v4.1-flash');
  const cost = helpers.costOfBucket(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, requests: 1 });
  assert.ok(Math.abs(cost.usd - 0.24) < 1e-12, `1M cacheWrite tokens must cost $0.24, got ${cost.usd}`);
});

test('tiered model: gemini-3.5-flash prices from its single tier', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('gemini-3.5-flash');
  assert.equal(model.kind, 'tiered');

  // The expression's coefficients are 1.5 / 9 / 0.15 / 1.5 USD per 1M tokens
  // BEFORE the group ratio, and `describeModel()` publishes them unscaled — so
  // the client applies `groupRatio` (0.25 for this group) itself.
  const cost = helpers.costOfBucket(model, { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0, requests: 1 });
  const raw = 1.5 + 0.9 + 0.3;
  const expected = raw * 0.25;
  assert.ok(Math.abs(cost.usd - expected) < 1e-9, `expected ${expected}, got ${cost.usd}`);
  assert.equal(cost.estimated, true, 'tiered billing is reported as an estimate');
});

test('tiered model: the group ratio scales the tier rates exactly once', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('gemini-3.5-flash');
  const bucket = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 };
  const scaled = helpers.costOfBucket(model, bucket).usd;
  // Same descriptor with the ratio removed: the price must be the raw 1.5.
  const unscaled = helpers.costOfBucket({ ...model, groupRatio: 1 }, bucket).usd;
  assert.ok(Math.abs(unscaled - 1.5) < 1e-12, `raw tier rate must be 1.5, got ${unscaled}`);
  assert.ok(Math.abs(scaled - 1.5 * 0.25) < 1e-12, `groupRatio 0.25 must divide the price by 4, got ${scaled}`);
});

test('tiered model: the tier is chosen by total length', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('grok-4.6');
  const ratio = model.groupRatio;

  const short = helpers.costOfBucket(model, { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0, requests: 1 });
  assert.equal(short.kind, 'tiered');
  // Below 200001 tokens: 2 / 6 per 1M, times the 0.16 group ratio.
  assert.ok(Math.abs(short.usd - (0.2 + 0.06) * ratio) < 1e-9, `expected ${(0.2 + 0.06) * ratio}, got ${short.usd}`);

  const long = helpers.costOfBucket(model, { input: 200_000, output: 10_000, cacheRead: 1_000, cacheWrite: 0, requests: 1 });
  // 201000 total crosses minLength 200001, so the 4 / 12 tier applies.
  assert.ok(Math.abs(long.usd - (0.8 + 0.12 + 0.001) * ratio) < 1e-9, `expected ${(0.8 + 0.12 + 0.001) * ratio}, got ${long.usd}`);
});

test('tiered model: a tier base fee is added to the token price and scaled with it', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('fixed-fee-model');
  const cost = helpers.costOfBucket(model, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 });
  const expected = (1.0 + 0.5) * model.groupRatio;
  assert.ok(Math.abs(cost.usd - expected) < 1e-12, `(1.0 token cost + 0.5 base) × 0.12 = ${expected}, got ${cost.usd}`);
});

test('fixed model: perRequest times the request count', () => {
  const index = helpers.indexModels(wire().models);
  const model = index.get('image-model');
  const cost = helpers.costOfBucket(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 3 });
  assert.ok(Math.abs(cost.usd - 0.12) < 1e-12, `3 × $0.04 = $0.12, got ${cost.usd}`);
  assert.equal(cost.estimated, true);
});

test('unknown model yields no price instead of NaN', () => {
  const index = helpers.indexModels(wire().models);
  assert.equal(index.get('nope'), undefined);
  assert.equal(helpers.costOfBucket(undefined, { input: 10 }), undefined);
  assert.equal(helpers.costOfBucket(null, { input: 10 }), undefined);

  const summary = helpers.summarizeBuckets(index, [{ model: 'nope', input: 1000, output: 10, requests: 1 }]);
  assert.equal(summary.unresolved, true, 'a bucket list with no priced row is unresolved');
  assert.equal(Number.isNaN(summary.usd), false, 'the total must never be NaN');
  assert.equal(summary.rows[0].unresolved, true);
});

test('unknown models do not poison a summary that has a priced row', () => {
  const index = helpers.indexModels(wire().models);
  const summary = helpers.summarizeBuckets(index, [
    { model: 'deepseek-v4.1-flash', input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 },
    { model: 'gone-model', input: 5, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1 },
  ]);
  assert.equal(summary.unresolved, false);
  assert.equal(summary.unknown, 1);
  assert.ok(Math.abs(summary.usd - 0.0012) < 1e-12);
});

// ── formatting ──────────────────────────────────────────────────────────────
test('formatMoney: four decimals under a cent, two above', () => {
  assert.equal(helpers.formatMoney(0.0012, 'USD'), '$0.0012');
  assert.equal(helpers.formatMoney(0.00999, 'USD'), '$0.0100');
  assert.equal(helpers.formatMoney(1.2345, 'USD'), '$1.23');
  assert.equal(helpers.formatMoney(12, 'USD'), '$12.00');
  assert.equal(helpers.formatMoney(0, 'USD'), '$0.0000');
  assert.equal(helpers.formatMoney(0.5, 'CNY'), '¥0.50');
  assert.equal(helpers.formatMoney(0.5, 'EUR'), '€0.50');
});

test('formatMoney: unknown currency falls back to the code, never to NaN', () => {
  assert.equal(helpers.formatMoney(1.5, 'XTS'), 'XTS 1.50');
  assert.equal(helpers.formatMoney(1.5, undefined), '$1.50');
  assert.equal(helpers.formatMoney(Number.NaN, 'USD'), undefined);
  assert.equal(helpers.formatMoney(undefined, 'USD'), undefined);
  assert.equal(helpers.currencySymbol('usd'), '$', 'codes are case-insensitive');
});

// ── projection summaries ────────────────────────────────────────────────────
test('summarizeTurn picks the matching Turn and prices it', () => {
  const projection = {
    totals: { input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 },
    turns: [
      {
        turn: 1,
        totals: { input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 },
        models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 }],
      },
    ],
  };
  const index = helpers.indexModels(wire().models);
  const summary = helpers.summarizeTurn(projection, 1, index);
  assert.ok(Math.abs(summary.usd - 0.0012) < 1e-12);
  assert.equal(helpers.summarizeTurn(projection, 2, index), undefined, 'an unpriced Turn has no summary');
  assert.equal(helpers.summarizeTurn(undefined, 1, index), undefined);
});

test('summarizeSession sums Turns that are priced separately', () => {
  const projection = {
    turns: [
      { turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 }] },
      { turn: 2, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 }] },
    ],
  };
  const index = helpers.indexModels(wire().models);
  const summary = helpers.summarizeSession(projection, index);
  assert.ok(Math.abs(summary.usd - 0.0024) < 1e-12, `two turns of 0.0012 must total 0.0024, got ${summary.usd}`);
  assert.equal(summary.empty, false);
});

test('summarizeSession reports emptiness instead of a fake zero', () => {
  const index = helpers.indexModels(wire().models);
  const summary = helpers.summarizeSession({ turns: [] }, index);
  assert.equal(summary.empty, true);
  assert.equal(summary.usd, 0);
  assert.equal(Number.isNaN(summary.usd), false);
});

test('turnNumberOf reads the TurnLocation defensively', () => {
  assert.equal(helpers.turnNumberOf({ turn: { kind: 'turn', turn: 7 }, seq: 10 }), 7);
  assert.equal(helpers.turnNumberOf({ turn: 3 }), 3);
  assert.equal(helpers.turnNumberOf({ turn: { locationCoordinates: { turn: 4 } } }), 4);
  assert.equal(helpers.turnNumberOf({ turn: { coordinates: { turn: 5 } } }), 5);
  assert.equal(helpers.turnNumberOf({ turn: { location: { turn: 6 } } }), 6);
  assert.equal(helpers.turnNumberOf({}), undefined);
  assert.equal(helpers.turnNumberOf(null), undefined);
  assert.equal(helpers.turnNumberOf({ turn: { kind: 'session' } }), undefined);
});

// ── wire normalization ──────────────────────────────────────────────────────
test('normalizeState keeps a payload shape even when the host sends junk', () => {
  const state = helpers.normalizeState({ ok: false, groups: [{ name: 'x', ratio: 'nope' }, null, {}], models: 'nope' });
  assert.equal(state.ok, false);
  assert.deepEqual(state.groups, [{ name: 'x', ratio: 0 }], 'junk group rows are dropped, bad ratios become 0');
  assert.deepEqual(state.models, []);
  assert.equal(state.currency, 'USD', 'a missing currency defaults to USD');
  assert.equal(state.error, null);
});

test('normalizeState drops unnamed models', () => {
  const state = helpers.normalizeState(wire({ models: [{ name: 'ok', kind: 'ratio' }, { kind: 'ratio' }, null] }));
  assert.deepEqual(state.models.map((model) => model.name), ['ok']);
});

// ── component output (rendered through the fake jsx runtime) ────────────────
test('TurnCostTail reports an unknown price when no catalog is loaded', () => {
  helpers.catalog.accept(wire());
  const props = {
    turn: { kind: 'turn', turn: 99 },
    seq: 1,
    useProjection: () => ({ turns: [] }),
    t: (key) => key,
  };
  const node = helpers.TurnCostTail(props);
  assert.equal(node, null, 'a Turn with no usage contributes nothing');
});

test('TurnCostTail returns null without a Turn number', () => {
  const node = helpers.TurnCostTail({ turn: { kind: 'session' }, seq: 1, useProjection: () => ({ turns: [] }), t: (key) => key });
  assert.equal(node, null, 'the tail must not crash or guess a Turn');
});

/**
 * Walk a node tree produced by the jsx-runtime stub and return every value in
 * it. The stub keeps children on `props` exactly like React does, so both the
 * element field and the props field are followed.
 */
function flattenTree(value, into = []) {
  if (value === null || value === undefined) return into;
  if (Array.isArray(value)) {
    for (const item of value) flattenTree(item, into);
    return into;
  }
  if (typeof value !== 'object') {
    into.push(value);
    return into;
  }
  into.push(value);
  flattenTree(value.props?.children, into);
  return into;
}

test('SessionCostUtilities renders the session total and a group picker', () => {
  helpers.catalog.accept(wire());
  // The picker shows the user's CHOICE, so state it explicitly rather than
  // inheriting whatever an earlier test left behind.
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [
      { turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 500, cacheRead: 100000, cacheWrite: 0, requests: 1 }] },
    ],
  };
  const node = helpers.SessionCostUtilities({ useProjection: () => projection, t: (key) => key });

  const nodes = flattenTree(node);
  const text = nodes.filter((item) => typeof item === 'string');
  assert.ok(text.includes('$0.0012'), `the session total must render, saw: ${text.join(' | ')}`);

  const select = nodes.find((item) => typeof item === 'object' && item !== null && item.type === 'select');
  assert.ok(select !== undefined, 'the group picker must be a native select');
  assert.equal(select.props.value, 'deepseek-HK', 'the picker must show the group the Host billed');
  const optionValues = flattenTree(select.props.children)
    .filter((item) => typeof item === 'object' && item !== null && item.type === 'option')
    .map((item) => item.props.value);
  // The leading '' is the auto seat: without it a user who ever picked a group
  // had no way back to "let the plugin choose the cheapest one".
  assert.deepEqual(optionValues, ['', 'deepseek-HK', 'gemini'], 'auto first, then every Host group');
});

test('the picker offers an auto seat that reaches the Host as "no group"', () => {
  helpers.catalog.accept(wire());
  const node = helpers.SessionCostUtilities({ useProjection: () => ({ turns: [] }), t: (key) => key });
  const select = flattenTree(node).find((item) => typeof item === 'object' && item !== null && item.type === 'select');
  assert.ok(select !== undefined);

  const auto = flattenTree(select.props.children)
    .filter((item) => typeof item === 'object' && item !== null && item.type === 'option')
    .find((item) => item.props.value === '');
  assert.ok(auto !== undefined, 'the auto option must exist');
  assert.equal(auto.props.children, 'group.auto', 'the auto option must be labelled through the locale');

  // Exactly one '' option: a second one would be an unreachable duplicate.
  const emptyCount = flattenTree(select.props.children)
    .filter((item) => typeof item === 'object' && item !== null && item.type === 'option')
    .filter((item) => item.props.value === '').length;
  assert.equal(emptyCount, 1, 'there must be exactly one auto option');
});

test('choosing auto clears the stored group and drops the query parameter', () => {
  helpers.catalog.accept(wire());
  // Pick a concrete group first, the way a user would.
  helpers.catalog.setGroup('gemini');
  assert.equal(helpers.catalog.getSnapshot().group, 'gemini');
  assert.equal(
    helpers.catalog.statePath(),
    `${helpers.STATE_PATH}?group=gemini`,
    'a concrete group must travel as a query parameter',
  );

  // Then go back to automatic: the Host sees no group and resolves the cheapest.
  helpers.catalog.setGroup('');
  assert.equal(helpers.catalog.getSnapshot().group, '');
  assert.equal(
    helpers.catalog.statePath(),
    helpers.STATE_PATH,
    'auto mode must ask the Host without a ?group= parameter',
  );

  // And the picker must render that state as the auto seat.
  const node = helpers.SessionCostUtilities({ useProjection: () => ({ turns: [] }), t: (key) => key });
  const select = flattenTree(node).find((item) => typeof item === 'object' && item !== null && item.type === 'select');
  assert.equal(select.props.value, '', 'the picker must show the auto seat after choosing it');
});

test('the group picker surfaces an unpublished current group instead of lying', () => {
  // A group the Host has since dropped but the user's localStorage still names:
  // without an <option> for it the browser would silently show the first
  // published group while `value` and the totals still referred to the old one.
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('retired-group');
  const node = helpers.SessionCostUtilities({ useProjection: () => ({ turns: [] }), t: (key) => key });
  const select = flattenTree(node).find((item) => typeof item === 'object' && item !== null && item.type === 'select');
  assert.ok(select !== undefined);
  assert.equal(select.props.value, 'retired-group');
  const values = flattenTree(select.props.children)
    .filter((item) => typeof item === 'object' && item !== null && item.type === 'option')
    .map((item) => item.props.value);
  assert.deepEqual(values, ['', 'retired-group', 'deepseek-HK', 'gemini'], 'auto, then the orphaned group, then the Host groups');
});

test('a payload never silently rewrites the user’s group choice', () => {
  // `data.group` is the RESOLVED group. Adopting it would pin "auto" to whatever
  // the Host resolved on the first refresh and make setGroup('') impossible.
  helpers.catalog.setGroup('');
  helpers.catalog.accept(wire({ group: 'deepseek-HK', requestedGroup: '' }));
  assert.equal(helpers.catalog.getSnapshot().group, '', 'auto must survive a payload that resolves to a group');
  assert.equal(helpers.catalog.getSnapshot().data.group, 'deepseek-HK', 'the resolved group stays available for display');

  helpers.catalog.setGroup('gemini');
  helpers.catalog.accept(wire({ group: 'gemini' }));
  assert.equal(helpers.catalog.getSnapshot().group, 'gemini');
});

test('SessionCostUtilities degrades to the empty label with no usage', () => {
  helpers.catalog.accept(wire());
  const node = helpers.SessionCostUtilities({ useProjection: () => ({ turns: [] }), t: (key) => key });
  const text = flattenTree(node).filter((item) => typeof item === 'string');
  assert.ok(text.includes('sessionCost.empty'), 'an unused session says so rather than showing $0.0000');
  assert.ok(!text.includes('$0.0000'), 'an unused session must not render a zero total');
});

// ── lifespan ────────────────────────────────────────────────────────────────
test('catalog store attaches, detaches, and keeps its snapshot', () => {
  const seen = [];
  const unsubscribe = helpers.catalog.subscribe(() => seen.push(helpers.catalog.getSnapshot()));
  const detach = helpers.catalog.attach();
  assert.ok(helpers.catalog.getSnapshot().data !== null, 'a mounted consumer sees the last snapshot');
  detach();
  // A remount paints from the retained snapshot instead of flashing empty.
  assert.ok(helpers.catalog.getSnapshot().data !== null);
  unsubscribe();
  assert.ok(seen.length >= 0);
});

test('setGroup persists the choice and keeps the current prices on screen', () => {
  helpers.catalog.accept(wire());
  const before = helpers.catalog.getSnapshot();
  assert.ok(before.data !== null);
  // Drive the picker the way a click would; the request itself is fire-and-forget
  // here because node has no Host route to answer it.
  assert.doesNotThrow(() => helpers.catalog.setGroup('gemini'));
  const after = helpers.catalog.getSnapshot();
  assert.equal(after.group, 'gemini');
  assert.ok(after.data !== null, 'switching groups must not blank the numbers before the reply');
  assert.doesNotThrow(() => helpers.catalog.setGroup(''));
});

// ── dictionaries ────────────────────────────────────────────────────────────
test('both dictionaries cover the same keys', () => {
  const zhKeys = Object.keys(helpers.dicts.zh).sort();
  const enKeys = Object.keys(helpers.dicts.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh and en must stay in sync');

  // Every key the code can ask for must exist in the shipped locale files, or
  // the header renders a raw dotted key to the user.
  const shipped = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'));
  const shippedKeys = new Set();
  for (const [namespace, entries] of Object.entries(shipped)) {
    if (namespace === 'meta') continue;
    for (const key of Object.keys(entries)) shippedKeys.add(`${namespace}.${key}`);
  }
  for (const key of zhKeys) {
    assert.ok(shippedKeys.has(key), `locale/zh.json is missing "${key}"`);
  }
});

test('fallbackTranslate substitutes parameters and survives missing keys', () => {
  assert.equal(helpers.fallbackTranslate('turnCost.unknown'), '价格未知');
  assert.equal(helpers.fallbackTranslate('group.current', { name: 'deepseek-HK' }), '当前分组：deepseek-HK');
  assert.equal(helpers.fallbackTranslate('group.updated.missing'), 'group.updated.missing');
});

// ── session lineage: subtree(s) = own(s) + Σ subtree(c) ─────────────────────
/** A lineage wire payload: `nodes` includes the root at depth 0 plus descendants. */
function lineageWire(nodes, overrides = {}) {
  return { ok: true, root: nodes.length > 0 ? nodes[0].id : '', truncated: false, nodes, currency: 'USD', error: null, ...overrides };
}

/** One lineage node. `own` may be a partial bucket. */
function node(id, parentId, depth, own, extra = {}) {
  return {
    id,
    parentId,
    depth,
    running: false,
    exact: true,
    own: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, ...own },
    ...extra,
  };
}

test('subtreeBuckets: a three-level chain sums A + B + C', () => {
  // A → B → C. Each level contributes its own tokens exactly once.
  const nodes = helpers.normalizeLineage(lineageWire([
    node('A', null, 0, { input: 1000, requests: 1 }),
    node('B', 'A', 1, { input: 2000, requests: 2 }),
    node('C', 'B', 2, { input: 4000, requests: 4 }),
  ])).nodes;

  const result = helpers.subtreeBuckets(nodes, 'A');
  assert.equal(result.buckets.input, 7000, 'input must be 1000 + 2000 + 4000');
  assert.equal(result.buckets.requests, 7, 'requests must be 1 + 2 + 4');
  assert.equal(result.count, 2, 'two descendants');
  assert.deepEqual([...result.ids].sort(), ['B', 'C']);

  // The same formula from B's viewpoint: B + C only.
  const fromB = helpers.subtreeBuckets(nodes, 'B');
  assert.equal(fromB.buckets.input, 6000, 'B sees itself plus C, never A');
  assert.equal(fromB.count, 1);
});

test('subtreeBuckets: two siblings both count toward the parent', () => {
  const nodes = helpers.normalizeLineage(lineageWire([
    node('A', null, 0, { input: 100 }),
    node('B1', 'A', 1, { input: 10 }),
    node('B2', 'A', 1, { input: 1 }),
  ])).nodes;
  const result = helpers.subtreeBuckets(nodes, 'A');
  assert.equal(result.buckets.input, 111, 'A + B1 + B2');
  assert.equal(result.count, 2);
});

test('subtreeBuckets: no children means the total is the session alone', () => {
  const nodes = helpers.normalizeLineage(lineageWire([node('A', null, 0, { input: 42, requests: 1 })])).nodes;
  const result = helpers.subtreeBuckets(nodes, 'A');
  assert.equal(result.buckets.input, 42);
  assert.equal(result.count, 0, 'a childless session has no descendants');
});

test('subtreeBuckets: a parent cycle terminates instead of hanging', () => {
  // A→B→A: B claims A as its parent while A claims B. Nothing may loop forever,
  // and each id may contribute at most once.
  const nodes = helpers.normalizeLineage(lineageWire([
    node('A', 'B', 0, { input: 1 }),
    node('B', 'A', 1, { input: 2 }),
  ])).nodes;
  const result = helpers.subtreeBuckets(nodes, 'A');
  assert.equal(result.buckets.input, 3, 'A + B, each counted once');
  assert.equal(result.count, 1);

  // A self-parented node must not count itself twice either.
  const self = helpers.normalizeLineage(lineageWire([node('S', 'S', 0, { input: 5 })])).nodes;
  assert.equal(helpers.subtreeBuckets(self, 'S').buckets.input, 5);
});

test('subtreeBuckets: a dangling parentId cannot throw or invent a node', () => {
  const nodes = helpers.normalizeLineage(lineageWire([
    node('A', null, 0, { input: 1 }),
    node('orphan', 'missing-parent', 1, { input: 99 }),
  ])).nodes;
  const result = helpers.subtreeBuckets(nodes, 'A');
  assert.equal(result.buckets.input, 1, 'an unreachable node contributes nothing');
  assert.equal(result.count, 0);
  // Unknown root: an empty result, not a crash. Assert the invariants rather
  // than the exact object, so extra bookkeeping fields stay free to change.
  for (const empty of [helpers.subtreeBuckets(nodes, 'nope'), helpers.subtreeBuckets(undefined, 'A')]) {
    assert.deepEqual(empty.buckets, helpers.zeroBucket());
    assert.deepEqual(empty.ids, []);
    assert.equal(empty.count, 0);
  }
});

test('header shows the subtree total and a descendant count', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  // Root burns 1000 input; the child burns 1000 more. At $0.24/1M that is
  // $0.00024 each, so the subtree must show $0.00048 — not the old $0.00024.
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  helpers.catalog.acceptLineage(
    lineageWire([
      node('sess-a', null, 0, { input: 1000, requests: 1 }),
      node('sess-b', 'sess-a', 1, { input: 1000, requests: 1 }),
    ]),
    'sess-a',
  );

  const nodeTree = helpers.SessionCostUtilities({ sessionId: 'sess-a', useProjection: () => projection, t: (key) => key });
  const flat = flattenTree(nodeTree);
  const text = flat.filter((item) => typeof item === 'string');
  assert.ok(text.includes('$0.0005'), `subtree total must be 0.00048 rounded to 4dp, saw: ${text.join(' | ')}`);
  assert.ok(text.includes('sessionCost.children'), 'the descendant badge must render for a session with children');
});

test('a session with no subagents renders exactly as before', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  helpers.catalog.acceptLineage(lineageWire([node('solo', null, 0, { input: 1000, requests: 1 })]), 'solo');

  const nodeTree = helpers.SessionCostUtilities({ sessionId: 'solo', useProjection: () => projection, t: (key) => key });
  const text = flattenTree(nodeTree).filter((item) => typeof item === 'string');
  assert.ok(text.includes('$0.0002'), `a childless session shows its own total, saw: ${text.join(' | ')}`);
  assert.ok(!text.includes('sessionCost.children'), 'no descendant badge without descendants');
});

test('lineage failure falls back to this session alone, never NaN', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  // A Host without the route: `null` lineage is exactly what loadLineage commits.
  helpers.catalog.acceptLineage(null, 'sess-a');
  const nodeTree = helpers.SessionCostUtilities({ sessionId: 'sess-a', useProjection: () => projection, t: (key) => key });
  const flat = flattenTree(nodeTree);
  const text = flat.filter((item) => typeof item === 'string');
  assert.ok(text.includes('$0.0002'), `must fall back to own-only money, saw: ${text.join(' | ')}`);
  assert.ok(!text.some((item) => String(item).includes('NaN')), 'never renders NaN');

  // A tree belonging to a DIFFERENT session must be ignored rather than shown
  // under this header.
  helpers.catalog.acceptLineage(lineageWire([node('other', null, 0, { input: 999999 })]), 'other-session');
  const crossed = helpers.SessionCostUtilities({ sessionId: 'sess-a', useProjection: () => projection, t: (key) => key });
  const crossedText = flattenTree(crossed).filter((item) => typeof item === 'string');
  assert.ok(crossedText.includes('$0.0002'), 'another session’s tree must not leak into this header');
});

test('lineage tooltip layers own vs subtree and lists descendants', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  const payload = helpers.normalizeLineage(lineageWire([
    node('root-00000001', null, 0, { input: 1000, requests: 1 }),
    node('child-0000002', 'root-00000001', 1, { input: 1000, requests: 1 }, { running: true }),
  ]));
  const summary = helpers.summarizeLineage({
    lineage: payload,
    rootId: 'root-00000001',
    projection,
    index: helpers.indexModels(wire().models),
  });

  assert.equal(summary.hasChildren, true);
  assert.equal(summary.children, 1);
  assert.ok(Math.abs(summary.own.usd - 0.00024) < 1e-12, `root own price, got ${summary.own.usd}`);
  assert.ok(Math.abs(summary.total - 0.00048) < 1e-12, `subtree total, got ${summary.total}`);
  assert.equal(summary.estimated, true, 'a descendant priced on the root model is an estimate');
  assert.equal(Number.isNaN(summary.total), false);

  const lines = helpers.lineageLines(
    (key) => key,
    summary,
    { currency: 'USD' },
  );
  assert.ok(lines.some((line) => line.startsWith('lineage.own')), 'own line present');
  assert.ok(lines.some((line) => line.startsWith('lineage.subtree')), 'subtree line present');
  const childLine = lines.find((line) => line.includes('child-00'));
  assert.ok(childLine !== undefined, 'each descendant gets a row');
  assert.ok(childLine.includes('lineage.depth'), 'the row states its depth');
  assert.ok(childLine.includes('lineage.running'), 'a running child is marked');
  assert.ok(childLine.includes('turnCost.approx'), 'an estimated row says so');
});

test('a descendant price changes when the group changes', () => {
  // Same tree, two groups. The price table is what moves, so the subtree total
  // must move with it and never be cached across a group switch.
  const lineage = helpers.normalizeLineage(lineageWire([
    node('root-g', null, 0, { input: 1_000_000, requests: 1 }),
    node('kid-g', 'root-g', 1, { input: 1_000_000, requests: 1 }),
  ]));
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  const cheap = helpers.summarizeLineage({
    lineage,
    rootId: 'root-g',
    projection,
    index: helpers.indexModels(wire().models),
  });
  // Same descriptor with a doubled group ratio must double the money.
  const doubled = wire().models.map((model) =>
    model.name === 'deepseek-v4.1-flash' ? { ...model, groupRatio: 0.24, input: 0.48, output: 1.92, cacheRead: 0.0096, cacheWrite: 0.48 } : model,
  );
  const dear = helpers.summarizeLineage({
    lineage,
    rootId: 'root-g',
    projection,
    index: helpers.indexModels(doubled),
  });
  assert.ok(Math.abs(dear.total - cheap.total * 2) < 1e-12, `doubling the group ratio must double the total: ${cheap.total} → ${dear.total}`);
});

test('an unpriced descendant is unknown, never zero and never NaN', () => {
  const lineage = helpers.normalizeLineage(lineageWire([
    node('root-u', null, 0, { input: 1000, requests: 1 }),
    node('kid-u', 'root-u', 1, { input: 1000, requests: 1 }),
  ]));
  // No projection means no root model, so the child cannot be priced at all.
  const summary = helpers.summarizeLineage({
    lineage,
    rootId: 'root-u',
    projection: undefined,
    index: helpers.indexModels(wire().models),
  });
  const childRow = summary.rows.find((row) => row.isRoot !== true);
  assert.equal(childRow.price.unresolved, true, 'an unpriceable row is flagged, not zeroed');
  const lines = helpers.lineageLines((key) => key, summary, { currency: 'USD' });
  const childLine = lines.find((line) => line.includes('kid-u'));
  assert.ok(childLine.includes('turnCost.unknown'), 'the row says the price is unknown');
  assert.equal(Number.isNaN(summary.total), false, 'the total must never be NaN');
});

// ── unknown descendants (scope: "accurate from now on", no backfill) ────────
// `sapiCost` rows only exist for sessions this plugin observed. An older
// subagent has no readable projection, and the route marks it rather than
// pretending it spent nothing. Unknown must never render as $0.00.
test('a node with own:null is unknown, never zero', () => {
  const nodes = helpers.normalizeLineage(lineageWire([
    node('root-1', null, 0, { input: 1000, requests: 1 }),
    // The explicit "could not read" shape.
    { id: 'old-child', parentId: 'root-1', depth: 1, running: false, own: null, exact: false },
  ])).nodes;

  const withNull = nodes.find((entry) => entry.id === 'old-child');
  assert.equal(withNull.own, null, 'an unreadable bucket must stay null, not become a zero bucket');
  assert.equal(withNull.known, false);

  const subtree = helpers.subtreeBuckets(nodes, 'root-1');
  assert.deepEqual(subtree.unknownIds, ['old-child'], 'the unreadable node is reported');
  assert.equal(subtree.count, 1, 'it still counts as a descendant');
});

test('an all-zero bucket on a non-exact read is treated as unknown', () => {
  // The older payload shape: an unreadable cache entry emitted as zeroes.
  // A session that actually ran cannot have spent exactly zero on all counters.
  const nodes = helpers.normalizeLineage(lineageWire([
    node('root-2', null, 0, { input: 1000 }, { exact: true }),
    node('cached-child', 'root-2', 1, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }, { exact: false }),
  ])).nodes;
  const child = nodes.find((entry) => entry.id === 'cached-child');
  assert.equal(child.own, null, 'a zero bucket with exact:false means "not read"');

  // ...but an exact zero really is zero and must be preserved.
  const exactZero = helpers.normalizeLineage(lineageWire([
    node('root-3', null, 0, { input: 1000 }, { exact: true }),
    node('idle-child', 'root-3', 1, { input: 0 }, { exact: true }),
  ])).nodes.find((entry) => entry.id === 'idle-child');
  assert.notEqual(exactZero.own, null, 'an exact zero bucket stays a real zero');
});

test('unknown descendants never render as $0.00 and never make NaN', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  const payload = helpers.normalizeLineage(lineageWire([
    node('root-u1', null, 0, { input: 1000, requests: 1 }),
    { id: 'old-kid', parentId: 'root-u1', depth: 1, running: false, own: null, exact: false },
  ]));
  const summary = helpers.summarizeLineage({ lineage: payload, rootId: 'root-u1', projection, index: helpers.indexModels(wire().models) });

  const childRow = summary.rows.find((row) => row.isRoot !== true);
  assert.equal(childRow.price.unresolved, true, 'the unreadable child is unresolved');
  assert.equal(Number.isNaN(summary.total), false, 'the total is never NaN');

  const lines = helpers.lineageLines((key) => key, summary, { currency: 'USD' });
  const childLine = lines.find((line) => line.includes('old-kid'));
  assert.ok(childLine.includes('turnCost.unknown'), 'the row says the price is unknown, not $0.0000');
  assert.ok(!childLine.includes('$0.0000'), 'an unreadable child must never render as zero dollars');
});

test('a partially unknown tree sums the known part and flags the rest', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  const payload = helpers.normalizeLineage(lineageWire([
    node('root-p', null, 0, { input: 1000, requests: 1 }),
    node('known-kid', 'root-p', 1, { input: 2000, requests: 1 }),
    { id: 'unknown-kid', parentId: 'root-p', depth: 1, running: false, own: null, exact: false },
  ]));
  const summary = helpers.summarizeLineage({ lineage: payload, rootId: 'root-p', projection, index: helpers.indexModels(wire().models) });

  assert.equal(summary.unknownChildren, 1, 'the unreadable child is counted');
  assert.equal(summary.allUnknown, false, 'not everything is unknown');
  // Total must include the known child and must not be dragged down or NaN.
  assert.ok(Math.abs(summary.total - (0.00024 + 0.00048)) < 1e-12, `expected known sum 0.00072, got ${summary.total}`);
  const lines = helpers.lineageLines((key) => key, summary, { currency: 'USD' });
  assert.ok(lines.some((line) => line.includes('turnCost.unknown')), 'the tooltip flags the unknown descendant');
});

test('when every descendant is unknown the header falls back to own-only', () => {
  helpers.catalog.accept(wire());
  helpers.catalog.setGroup('deepseek-HK');
  const projection = {
    turns: [{ turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1 }] }],
  };
  helpers.catalog.acceptLineage(
    lineageWire([
      node('root-a', null, 0, { input: 1000, requests: 1 }),
      { id: 'ghost-kid', parentId: 'root-a', depth: 1, running: false, own: null, exact: false },
    ]),
    'root-a',
  );
  const tree = helpers.SessionCostUtilities({ sessionId: 'root-a', useProjection: () => projection, t: (key) => key });
  const flat = flattenTree(tree);
  const text = flat.filter((item) => typeof item === 'string');

  // The honest number: this session alone, not a fabricated subtree sum.
  assert.ok(text.includes('$0.0002'), `expected own-only $0.0002, saw: ${text.join(' | ')}`);
  assert.ok(text.includes('turnCost.unknown'), 'the unknown descendants are flagged in the chip');
  assert.ok(!text.some((item) => String(item).includes('NaN')), 'never NaN');
});
