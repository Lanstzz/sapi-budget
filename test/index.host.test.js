/**
 * Regression tests for the sapi-budget host half.
 *
 * Everything here runs offline: the provider catalog is served by a stubbed
 * `globalThis.fetch`, so `fetchCatalog` and `PricingSnapshot` are exercised for
 * real instead of being mocked away. Node's built-in test runner and `assert`
 * are the only tools — this package declares no dependencies, and a test that
 * needed one could not run in the profile it ships to.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Config,
  LINEAGE_MAX_DEPTH,
  LINEAGE_MAX_NODES,
  LINEAGE_ROUTE,
  PRICE_PARAMETERS,
  PRICE_OUTPUT_SCHEMA,
  PROJECTION_KEY,
  REFRESH_ROUTE,
  STATE_ROUTE,
  TOOL_NAME,
  bucketsFromUsage,
  buildLineage,
  bucketsFromView,
  compileParameters,
  lineageRows,
  createCatalogService,
  groupFromRequest,
  lineagePayload,
  modelOf,
  normalizeConfig,
  priceToolDefinition,
  sapiCostDefinition,
  sessionFromRequest,
  usageOf,
} from '../index.js';

// ───────────────────────────────────────────────────────────────────────────
// Provider fixture
// ───────────────────────────────────────────────────────────────────────────

/**
 * A catalog shaped like the live AiSpot provider: one expression-billed model
 * with a single tier, one with two tiers, and one classic ratio model whose
 * group carries a 0.12 multiplier. The numbers are the provider's published
 * ones, so the assertions below double as known-answer regressions.
 */
const PRICING_FIXTURE = {
  pricing_version: 'fixture-1',
  data: [
    {
      model_name: 'gemini-3.5-flash',
      model_ratio: 0,
      completion_ratio: 1,
      quota_type: 0,
      vendor_id: 1,
      enable_groups: ['gemini'],
      billing_expr: 'p * 1.5 + c * 9 + cr * 0.15',
    },
    {
      model_name: 'grok-4.6',
      model_ratio: 0,
      completion_ratio: 1,
      quota_type: 0,
      vendor_id: 1,
      enable_groups: ['grok heavy'],
      billing_expr: 'len <= 200000 ? p * 2 + c * 12 : p * 4 + c * 24',
    },
    {
      model_name: 'deepseek-v4.1-flash',
      model_ratio: 1,
      completion_ratio: 4,
      cache_ratio: 0.02,
      quota_type: 0,
      vendor_id: 1,
      enable_groups: ['deepseek-HK'],
    },
  ],
  group_ratio: { gemini: 1, 'grok heavy': 1, 'deepseek-HK': 0.12 },
};

const STATUS_FIXTURE = {
  data: { quota_per_unit: 500000, usd_exchange_rate: 7.3, quota_display_type: 'USD', system_name: 'fixture' },
};

/** One Response carrying fixture JSON, as the provider would answer. */
function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Install a `globalThis.fetch` that answers the three public provider
 * endpoints with the fixtures above.
 *
 * @param overrides - optional `{ pricing, status, groups }` replacements, or a
 *   function called per URL to force failures.
 * @returns a restore function.
 */
function stubProviderFetch(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (typeof overrides === 'function') {
      const forced = overrides(target);
      if (forced !== undefined) return forced;
    }
    if (target.endsWith('/api/pricing')) return jsonResponse(overrides.pricing ?? PRICING_FIXTURE);
    if (target.endsWith('/api/status')) return jsonResponse(overrides.status ?? STATUS_FIXTURE);
    if (target.endsWith('/api/user/groups')) return jsonResponse(overrides.groups ?? { data: {} });
    return new Response('not found', { status: 404 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** A catalog service backed by the fixture provider. */
async function fixtureService(options = {}) {
  const service = createCatalogService(normalizeConfig({ baseUrl: 'https://fixture.invalid', ...options }), undefined);
  await service.ensure();
  return service;
}

// ───────────────────────────────────────────────────────────────────────────
// pricing.js known-answer regressions
// ───────────────────────────────────────────────────────────────────────────

test('pricing: gemini-3.5-flash is one tier at 1.5 / 9 / 0.15 / 1.5', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const snapshot = service.snapshot;
    assert.ok(snapshot, 'catalog must load');
    const model = snapshot.models.get('gemini-3.5-flash');
    assert.ok(model, 'fixture must contain gemini-3.5-flash');
    const described = snapshot.describeModel(model, 'gemini');
    assert.equal(described.kind, 'tiered');
    assert.equal(described.tiers.length, 1, 'gemini-3.5-flash bills in exactly one tier');
    const tier = described.tiers[0];
    assert.equal(tier.input, 1.5);
    assert.equal(tier.output, 9);
    assert.equal(tier.cacheRead, 0.15);
    // The expression never mentions `cc`, so a cache write costs the input rate.
    assert.equal(tier.cacheWrite, 1.5);
    assert.equal(tier.minLength, 0);
  } finally {
    restore();
  }
});

test('pricing: grok-4.6 has two tiers split at length 200000', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const snapshot = service.snapshot;
    const described = snapshot.describeModel(snapshot.models.get('grok-4.6'), 'grok heavy');
    assert.equal(described.kind, 'tiered');
    assert.equal(described.tiers.length, 2, 'the conditional expression has two regimes');
    assert.equal(described.tiers[0].minLength, 0);
    assert.equal(described.tiers[0].input, 2);
    assert.equal(described.tiers[0].output, 12);
    assert.equal(described.tiers[1].minLength, 200001);
    assert.equal(described.tiers[1].input, 4);
    assert.equal(described.tiers[1].output, 24);
  } finally {
    restore();
  }
});

test('pricing: costOf(deepseek-v4.1-flash, deepseek-HK) is $0.0012', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const cost = service.snapshot.costOf('deepseek-v4.1-flash', 'deepseek-HK', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100000,
    });
    assert.ok(cost, 'the fixture must be able to price this request');
    // (1000 × 0.24 + 500 × 0.96 + 100000 × 0.0048) / 1e6
    assert.ok(Math.abs(cost.usd - 0.0012) < 1e-9, `expected 0.0012, got ${cost.usd}`);
    assert.equal(cost.kind, 'ratio');
    assert.equal(cost.estimated, false);
  } finally {
    restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Projection: fold semantics
// ───────────────────────────────────────────────────────────────────────────

/** One `assistant/message` settlement. */
function messageEvent({ turn, step, model, usage, stream }) {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 0,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', model } },
      ...usage === undefined ? {} : { usage },
      stream: stream ?? [],
    },
  };
}

/** A usage chunk embedded in a provider stream. */
const usageChunk = (usage) => ({ type: 'chunk', chunk: { type: 'usage', usage } });

/** Fold a sequence of events through the definition. */
function fold(definition, events) {
  return events.reduce((state, event) => definition.apply(state, event), definition.init());
}

test('projection: an ignored event returns the SAME state reference', () => {
  const definition = sapiCostDefinition();
  const seeded = fold(definition, [
    messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 10, outputTokens: 5 } }),
  ]);
  // `Object.is` on the returned reference is the host's change gate: a fresh
  // object here would notify every subscriber on every unrelated event.
  for (const event of [
    { type: 'user/message', data: { message: { role: 'user', content: [] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'x', content: [] } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/attempt', data: { turn: 2, step: 0, stream: [] } },
    { type: 'llm/retry-started', data: { retryId: 'r', turn: 99, step: 0, retry: 1 } },
    null,
    { type: 'assistant/message' },
    { type: 'assistant/message', data: { turn: 'one', step: 0, stream: [] } },
  ]) {
    const next = definition.apply(seeded, event);
    assert.equal(next, seeded, `event ${JSON.stringify(event?.type)} must not change state`);
  }
});

test('projection: a repeated turn+step sample replaces instead of accumulating', () => {
  const definition = sapiCostDefinition();
  const partial = messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } });
  const settled = messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 400, outputTokens: 40 } });
  const state = fold(definition, [partial, settled]);
  assert.equal(state.totals.input, 400, 'the later sample for the same step wins, it does not add');
  assert.equal(state.totals.output, 40);
  assert.equal(state.totals.requests, 1, 'one step is one request, not two');

  const view = definition.wire.view(state);
  assert.equal(view.totals.input, 400);
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0].models.length, 1);
  assert.equal(view.turns[0].models[0].model, 'gemini-3.5-flash');
});

test('projection: distinct steps within a turn accumulate', () => {
  const definition = sapiCostDefinition();
  const state = fold(definition, [
    messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } }),
    messageEvent({ turn: 1, step: 1, model: 'gemini-3.5-flash', usage: { inputTokens: 200, outputTokens: 20 } }),
    messageEvent({ turn: 2, step: 0, model: 'deepseek-v4.1-flash', usage: { inputTokens: 7, outputTokens: 3 } }),
  ]);
  assert.equal(state.totals.input, 307);
  assert.equal(state.totals.output, 33);
  assert.equal(state.totals.requests, 3);
  const view = definition.wire.view(state);
  assert.deepEqual(view.turns.map((row) => row.turn), [1, 2]);
  assert.equal(view.turns[0].totals.input, 300);
  assert.equal(view.turns[1].totals.input, 7);
});

test('projection: llm/retry-started clears the replacement slot', () => {
  const definition = sapiCostDefinition();
  const first = messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } });
  const retry = { type: 'llm/retry-started', data: { retryId: 'r1', turn: 1, step: 0, retry: 1 } };
  const second = messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } });

  const afterRetry = fold(definition, [first, retry]);
  assert.equal(afterRetry.last, null, 'the retried attempt must not replace the failed attempt');

  const state = fold(definition, [first, retry, second]);
  assert.equal(state.totals.input, 200, 'both attempts are billed, so both count');
  assert.equal(state.totals.requests, 2);
});

test('projection: assistant/attempt reads the last usage chunk of its stream', () => {
  const definition = sapiCostDefinition();
  const attempt = {
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 0,
      stream: [
        { type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } },
        usageChunk({ inputTokens: 11, outputTokens: 2 }),
        { type: 'chunk', chunk: { type: 'text-delta', text: ' there' } },
        usageChunk({ inputTokens: 33, outputTokens: 4 }),
      ],
    },
  };
  assert.deepEqual(usageOf(attempt), { inputTokens: 33, outputTokens: 4 }, 'the LAST usage chunk wins');
  const state = definition.apply(definition.init(), attempt);
  assert.equal(state.totals.input, 33);
  assert.equal(state.totals.output, 4);
});

test('projection: assistant/attempt inherits the turn\'s last known model', () => {
  const definition = sapiCostDefinition();
  const state = fold(definition, [
    messageEvent({ turn: 3, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 10, outputTokens: 1 } }),
    { type: 'assistant/attempt', data: { turn: 3, step: 1, stream: [usageChunk({ inputTokens: 20, outputTokens: 2 })] } },
  ]);
  const view = definition.wire.view(state);
  assert.equal(view.turns.length, 1, 'both samples belong to the same turn');
  assert.equal(view.turns[0].models.length, 1, 'the attempt joined the message\'s model bucket');
  assert.equal(view.turns[0].models[0].model, 'gemini-3.5-flash');
  assert.equal(view.totals.input, 30);
});

test('projection: message.source.model is read only for a model source', () => {
  assert.equal(modelOf(messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: {} })), 'gemini-3.5-flash');
  const notAModel = { data: { message: { source: { kind: 'tool', model: 'nope' } } } };
  assert.equal(modelOf(notAModel), undefined);
  assert.equal(modelOf({ data: { message: {} } }), undefined);
  assert.equal(modelOf({}), undefined);
});

test('projection: cache tokens land in their own buckets', () => {
  assert.deepEqual(bucketsFromUsage({ inputTokens: 5, outputTokens: 6 }), {
    input: 5,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 1,
  });
  assert.deepEqual(bucketsFromUsage({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }), {
    input: 5,
    output: 6,
    cacheRead: 7,
    cacheWrite: 8,
    requests: 1,
  });
});

test('projection: wire view is pure JSON and never publishes money', () => {
  const definition = sapiCostDefinition();
  const state = fold(definition, [
    messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } }),
  ]);
  const before = JSON.stringify(state);
  const view = definition.wire.view(state);
  assert.equal(JSON.stringify(state), before, 'the view must not mutate its input');

  // Round-trips through JSON unchanged: no Map, no undefined, no functions.
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  const fields = new Set(Object.keys(view.totals));
  assert.deepEqual([...fields].sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'requests']);
  assert.equal(view.totals.usd, undefined, 'the projection publishes tokens only');
  assert.equal(view.usd, undefined);
  assert.equal(JSON.stringify(view).includes('usd'), false, 'no money field may appear anywhere in the view');
});

test('projection: the definition declares key, stateVersion, and both schemas', () => {
  const definition = sapiCostDefinition();
  assert.equal(definition.key, PROJECTION_KEY);
  assert.equal(definition.key, 'sapiCost');
  assert.equal(definition.stateVersion, 1);
  assert.equal(typeof definition.init, 'function');
  assert.equal(typeof definition.apply, 'function');
  assert.equal(typeof definition.stateSchema.parse, 'function');
  assert.equal(typeof definition.wire.viewSchema.parse, 'function');
  // The registry validates every restored checkpoint and every published view.
  const state = definition.init();
  assert.doesNotThrow(() => definition.stateSchema.parse(state));
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(definition.wire.view(state)));
  assert.throws(() => definition.stateSchema.parse(null), TypeError);
  assert.throws(() => definition.wire.viewSchema.parse({ turns: 'nope' }), TypeError);
});

// ───────────────────────────────────────────────────────────────────────────
// Config and parameter compilation
// ───────────────────────────────────────────────────────────────────────────

test('config: defaults, coercion, and the standard-schema protocol', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    baseUrl: 'https://aispot.swj0227.icu',
    group: '',
    currency: 'USD',
    refreshMinutes: 30,
  });
  assert.deepEqual(normalizeConfig({ baseUrl: 'https://example.test///', group: ' gemini ', currency: '', refreshMinutes: -1 }), {
    baseUrl: 'https://example.test',
    group: 'gemini',
    currency: 'USD',
    refreshMinutes: 0,
  });
  // cordis 0.2.x resolves config through `'~standard'.validate`, not `.parse()`.
  const resolved = Config['~standard'].validate({ baseUrl: 'https://example.test' });
  assert.equal(resolved.issues, undefined);
  assert.equal(resolved.value.baseUrl, 'https://example.test');
  assert.equal(resolved.value.refreshMinutes, 30);
  assert.doesNotThrow(() => Config.parse({ group: 'g' }));
});

test('tool: authoring-form parameters compile to raw JSON Schema', () => {
  const compiled = compileParameters(PRICE_PARAMETERS);
  assert.equal(compiled.type, 'object');
  assert.equal(compiled.additionalProperties, false);
  assert.deepEqual(compiled.required, ['model'], 'required lives on the property in authoring form, not in a top-level array');
  assert.equal(compiled.properties.model.type, 'string');
  assert.equal(compiled.properties.model.required, undefined, 'the authoring marker must not survive compilation');
  assert.equal(typeof compiled.properties.model.description, 'string');
  assert.deepEqual(
    Object.keys(compiled.properties).sort(),
    ['cacheReadTokens', 'cacheWriteTokens', 'group', 'inputTokens', 'model', 'outputTokens'],
  );
});

test('tool: the definition carries output.schema and a render function', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const definition = priceToolDefinition(service);
    assert.equal(definition.name, TOOL_NAME);
    assert.equal(definition.name, 'sapi_price');
    assert.notEqual(definition.name, 'run_code', 'the PTC transport name is reserved');
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20);

    // `register()` throws unless output is `{ schema, render }`.
    assert.equal(typeof definition.output, 'object');
    assert.equal(definition.output.schema, PRICE_OUTPUT_SCHEMA);
    assert.equal(typeof definition.output.render, 'function');

    const value = await definition.execute({ model: 'gemini-3.5-flash', group: 'gemini' });
    assert.equal(value.ok, true);
    const rendered = definition.output.render({}, value);
    assert.ok(Array.isArray(rendered));
    assert.deepEqual(Object.keys(rendered[0]).sort(), ['text', 'type']);
    assert.equal(rendered[0].type, 'text');
    assert.ok(rendered[0].text.includes('gemini-3.5-flash'));
    assert.ok(rendered[0].text.includes('1.5'), 'the input rate must appear');
  } finally {
    restore();
  }
});

test('tool: prices a concrete request and rejects an unknown model', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const definition = priceToolDefinition(service);
    const priced = await definition.execute({
      model: 'deepseek-v4.1-flash',
      group: 'deepseek-HK',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100000,
    });
    assert.equal(priced.ok, true);
    assert.ok(Math.abs(priced.usd - 0.0012) < 1e-9);
    assert.equal(priced.kind, 'ratio');

    const missing = await definition.execute({ model: 'does-not-exist' });
    assert.equal(missing.ok, false);
    assert.ok(missing.text.includes('does-not-exist'));
    // The result must always satisfy the declared output schema.
    for (const value of [priced, missing]) {
      assert.equal(typeof value.ok, 'boolean');
      assert.equal(typeof value.text, 'string');
    }
  } finally {
    restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Catalog service: stale-on-failure
// ───────────────────────────────────────────────────────────────────────────

test('catalog: a failed refresh keeps the previous snapshot and flags stale', async () => {
  let fail = false;
  const restore = stubProviderFetch((url) => (fail ? new Response('boom', { status: 500 }) : undefined));
  try {
    const service = await fixtureService();
    const good = service.statePayload('');
    assert.equal(good.ok, true);
    assert.equal(good.stale, false);
    assert.equal(good.error, null);
    assert.equal(good.models.length, 3);
    assert.ok(good.fetchedAt > 0);

    fail = true;
    await service.refresh();
    const stale = service.statePayload('');
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, true);
    assert.equal(typeof stale.error, 'string');
    // The price table survives: a stale catalog beats no catalog.
    assert.equal(stale.models.length, 3, 'the previous catalog must not be cleared');
    assert.equal(stale.fetchedAt, good.fetchedAt, 'the surviving snapshot keeps its fetch time');
    assert.equal(service.snapshot, service.snapshot, 'the snapshot instance is retained');
  } finally {
    restore();
  }
});

test('catalog: state payload matches the wire contract', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const payload = service.statePayload('deepseek-HK');
    for (const field of [
      'ok', 'baseUrl', 'group', 'requestedGroup', 'groups', 'models',
      'quotaPerUnit', 'usdExchangeRate', 'currency', 'fetchedAt', 'stale', 'error',
    ]) {
      assert.ok(Object.hasOwn(payload, field), `payload must carry ${field}`);
    }
    assert.equal(payload.group, 'deepseek-HK');
    assert.equal(payload.requestedGroup, 'deepseek-HK');
    assert.equal(payload.quotaPerUnit, 500000);
    assert.equal(payload.fetchedAt > 0, true);
    assert.ok(Array.isArray(payload.groups));
    assert.ok(payload.groups.every((entry) => typeof entry.name === 'string' && typeof entry.ratio === 'number'));
    // `PricingSnapshot.models` is a Map, so the payload must already be an array.
    assert.ok(Array.isArray(payload.models));
    assert.ok(payload.models.some((model) => model.name === 'deepseek-v4.1-flash'));
    assert.equal(JSON.parse(JSON.stringify(payload)).models.length, payload.models.length, 'the payload must be JSON-clean');
  } finally {
    restore();
  }
});

test('catalog: an unknown requested group falls back to a real provider group', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const resolved = service.resolveGroup('no-such-group');
    assert.ok(['gemini', 'grok heavy', 'deepseek-HK'].includes(resolved), `expected a real group, got ${resolved}`);
  } finally {
    restore();
  }
});

test('catalog: groupFromRequest reads ?group= defensively', () => {
  assert.equal(groupFromRequest(new Request('http://x/api/sapi-budget/state?group=gemini')), 'gemini');
  assert.equal(groupFromRequest(new Request('http://x/api/sapi-budget/state'), 'fallback'), 'fallback');
  assert.equal(groupFromRequest(new Request('http://x/api/sapi-budget/state?group='), 'fallback'), 'fallback');
  // A stub with no parseable URL must not throw.
  assert.equal(groupFromRequest({}, 'fallback'), 'fallback');
});

// ───────────────────────────────────────────────────────────────────────────
// Plugin registration against a stub host
// ───────────────────────────────────────────────────────────────────────────

/**
 * A fake Cordis context that records what the plugin registers.
 *
 * `inject(names, callback)` runs the callback synchronously against a child
 * stub exposing exactly the named services, mirroring how a fully populated
 * host resolves them, and `effect(factory)` records the factory's disposer so
 * teardown can be exercised.
 */
function createHostStub({ services = ['connection', 'tools', 'sessionProjections'], sessionController, sessions, projections } = {}) {
  const record = {
    routes: [],
    tools: [],
    projections: [],
    effects: [],
    injects: [],
    warnings: [],
  };
  const disposers = [];

  const makeContext = (available) => {
    const ctx = {
      logger() {
        return {
          info() {},
          warn(message) {
            record.warnings.push(String(message));
          },
          debug() {},
          error() {},
        };
      },
      effect(factory, label) {
        record.effects.push(label);
        const produced = factory();
        if (typeof produced === 'function') disposers.push(produced);
        return typeof produced === 'function' ? produced : () => {};
      },
      inject(names, callback) {
        record.injects.push(names);
        if (!names.every((name) => available.has(name))) return;
        const child = makeContext(available);
        const servicesForChild = {};
        for (const name of names) servicesForChild[name] = serviceFor(name, child);
        callback(Object.assign(child, servicesForChild));
      },
      // `ctx.get(name)` is how the plugin reads optional services it did not
      // inject, so the stub answers with whatever the test supplied.
      get(name) {
        if (name === 'sessionController') return sessionController;
        if (name === 'sessions') return sessions;
        if (name === 'sessionProjections') return projections;
        return undefined;
      },
    };
    return ctx;
  };

  const serviceFor = (name, ctx) => {
    if (name === 'connection') {
      return {
        fetch: {
          register(route) {
            record.routes.push(route);
            return () => {};
          },
        },
      };
    }
    if (name === 'tools') {
      return {
        register(definition) {
          record.tools.push(definition);
          return () => {};
        },
      };
    }
    if (name === 'sessionProjections') {
      return {
        register(definition) {
          record.projections.push(definition);
          return () => {};
        },
      };
    }
    return undefined;
  };

  const available = new Set(services);
  const ctx = makeContext(available);
  return {
    ctx,
    record,
    /** Run every disposer this stub collected, newest first. */
    dispose() {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Lineage fixtures
// ───────────────────────────────────────────────────────────────────────────

/**
 * The real workspace lineage, reproduced exactly as `sessionController.list()`
 * reports it: `parentSessionId` is RENAMED from `header.parentSession` and is
 * OMITTED (not null) on a root session. Four unrelated sessions share the store
 * so the "descendants only" rule has something to exclude.
 *
 * Ground truth (from `.oracle-lineage.py`, which reads the raw logs):
 *   ea8afcd1 own input 939268  /  26d113be 745828  /  c00add4d 899301
 */
const ROOT_ID = 'session-ea8afcd1-3b43-4dc5-9974-f3029f638c67';
const CHILD_A = '26d113be-f5bf-4e3b-80da-50598b7c540b';
const CHILD_B = 'c00add4d-277c-456c-bfaf-8b1937780738';

const buckets = (input, output, cacheRead, requests) => ({ input, output, cacheRead, cacheWrite: 0, requests });

/** One `list()` summary, in the host's real shape. */
const summary = (sessionId, parentSessionId, view, running = false) => ({
  sessionId,
  updatedAt: 1,
  agentAvailable: true,
  formatStatus: 'current',
  running,
  blank: false,
  // Omitted entirely for a root, exactly as the host does it.
  ...parentSessionId === null ? {} : { parentSessionId },
  origin: parentSessionId === null ? undefined : 'subagent',
  cwd: '/tmp',
  // May legitimately be undefined; the plugin must not assume it exists.
  ...view === undefined ? {} : { projections: { values: { sapiCost: { totals: view } } } },
});

/** The real three-session chain plus unrelated sessions. */
function realLineageSummaries() {
  return [
    summary(ROOT_ID, null, buckets(939268, 211980, 35187072, 315)),
    summary(CHILD_A, ROOT_ID, buckets(745828, 149065, 20226176, 164), true),
    summary(CHILD_B, ROOT_ID, buckets(899301, 148643, 40146048, 249)),
    // Unrelated roots: they must never appear in ROOT_ID's tree.
    summary('session-unrelated-1', null, buckets(1, 1, 1, 1)),
    summary('session-unrelated-2', null, buckets(2, 2, 2, 2)),
    summary('session-unrelated-3', 'session-unrelated-1', buckets(3, 3, 3, 3)),
    summary('session-unrelated-4', null, buckets(4, 4, 4, 4)),
  ];
}

/** A minimal `sessionController` stub exposing `list()`. */
const controllerOf = (summaries) => ({ list: async () => summaries });

/** Import the plugin entry lazily so each test starts from a clean module. */
async function loadPlugin() {
  return import('../index.js');
}

test('registration: routes, tool, and projection all reach the host', async () => {
  const restore = stubProviderFetch();
  const host = createHostStub();
  try {
    const plugin = await loadPlugin();
    plugin.apply(host.ctx, { baseUrl: 'https://fixture.invalid' });
    // The catalog warms asynchronously; let the stubbed fetch settle.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(host.record.injects, [['connection'], ['tools'], ['sessionProjections']]);

    // ── routes ──
    assert.equal(host.record.routes.length, 3);
    const state = host.record.routes.find((route) => route.path === STATE_ROUTE);
    const refresh = host.record.routes.find((route) => route.path === REFRESH_ROUTE);
    const lineage = host.record.routes.find((route) => route.path === LINEAGE_ROUTE);
    assert.ok(state, 'the state route must be registered');
    assert.ok(refresh, 'the refresh route must be registered');
    assert.ok(lineage, 'the lineage route must be registered');
    assert.equal(state.path, '/api/sapi-budget/state');
    assert.deepEqual(state.methods, ['GET']);
    assert.equal(refresh.path, '/api/sapi-budget/refresh');
    assert.deepEqual(refresh.methods, ['POST']);
    assert.equal(lineage.path, '/api/sapi-budget/lineage');
    assert.deepEqual(lineage.methods, ['GET']);
    for (const route of [state, refresh, lineage]) {
      assert.equal(route.requestBody, 'buffered');
      assert.equal(typeof route.fetch, 'function');
    }

    // ── routes answer with the contract payload ──
    const stateResponse = await state.fetch(new Request('http://host/api/sapi-budget/state?group=gemini'));
    assert.equal(stateResponse.status, 200);
    assert.match(stateResponse.headers.get('content-type'), /application\/json/);
    const body = await stateResponse.json();
    assert.equal(body.ok, true);
    assert.equal(body.group, 'gemini');
    assert.ok(Array.isArray(body.models) && body.models.length > 0);

    const refreshResponse = await refresh.fetch(new Request('http://host/api/sapi-budget/refresh', { method: 'POST' }));
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json();
    assert.equal(refreshed.ok, true);
    assert.ok(Array.isArray(refreshed.groups));

    // ── tool ──
    assert.equal(host.record.tools.length, 1);
    const tool = host.record.tools[0];
    assert.equal(tool.name, TOOL_NAME);
    assert.equal(typeof tool.output, 'object', 'register() throws without an output declaration');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.output.schema, 'object');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.properties.model.type, 'string');
    assert.deepEqual(tool.parameters.required, ['model']);
    assert.equal(typeof tool.execute, 'function');

    // ── projection ──
    assert.equal(host.record.projections.length, 1);
    const projection = host.record.projections[0];
    assert.equal(projection.key, 'sapiCost');
    assert.equal(projection.stateVersion, 1);
    assert.equal(typeof projection.stateSchema.parse, 'function');
    assert.equal(typeof projection.wire.viewSchema.parse, 'function');
    assert.equal(typeof projection.wire.view, 'function');
    assert.doesNotThrow(() => projection.wire.viewSchema.parse(projection.wire.view(projection.init())));
  } finally {
    restore();
    host.dispose();
  }
});

test('registration: a host without optional services stays quiet', async () => {
  const restore = stubProviderFetch();
  const host = createHostStub({ services: [] });
  try {
    const plugin = await loadPlugin();
    assert.doesNotThrow(() => plugin.apply(host.ctx, {}));
    assert.equal(host.record.routes.length, 0);
    assert.equal(host.record.tools.length, 0);
    assert.equal(host.record.projections.length, 0);
  } finally {
    restore();
    host.dispose();
  }
});

test('registration: a connection without fetch.register does not throw', async () => {
  const restore = stubProviderFetch();
  const host = createHostStub();
  const plugin = await loadPlugin();
  try {
    // A dsh older than the exact-route registry exposes no `fetch.register`.
    const ctx = Object.assign({}, host.ctx);
    ctx.inject = (names, callback) => {
      if (!names.includes('connection')) return;
      callback(Object.assign({}, ctx, { connection: { fetch: {} }, effect: host.ctx.effect }));
    };
    assert.doesNotThrow(() => plugin.apply(ctx, {}));
  } finally {
    restore();
  }
});

test('registration: the projection registered by the plugin folds a session', async () => {
  const restore = stubProviderFetch();
  const host = createHostStub();
  try {
    const plugin = await loadPlugin();
    plugin.apply(host.ctx, { baseUrl: 'https://fixture.invalid' });
    const projection = host.record.projections[0];
    const events = [
      messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100000 } }),
      messageEvent({ turn: 1, step: 1, model: 'gemini-3.5-flash', usage: { inputTokens: 200, outputTokens: 100 } }),
    ];
    const state = events.reduce((current, event) => projection.apply(current, event), projection.init());
    const view = projection.wire.viewSchema.parse(projection.wire.view(state));
    assert.equal(view.totals.input, 1200);
    assert.equal(view.totals.output, 600);
    assert.equal(view.totals.cacheRead, 100000);
    assert.equal(view.totals.requests, 2);
    assert.equal(view.turns.length, 1);
    assert.equal(view.turns[0].turn, 1);
  } finally {
    restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Checkpoint fidelity
// ───────────────────────────────────────────────────────────────────────────

test('projection: a restored checkpoint keeps folding replacement and model inheritance', () => {
  const definition = sapiCostDefinition();
  const seeded = fold(definition, [
    messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } }),
  ]);
  // The registry validates a stored row with `stateSchema.parse` before it
  // resumes folding from it.
  const restored = definition.stateSchema.parse(JSON.parse(JSON.stringify(seeded)));

  // The replacement slot survives, so the same step still replaces.
  const replaced = definition.apply(
    restored,
    messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 400, outputTokens: 40 } }),
  );
  assert.equal(replaced.totals.input, 400);
  assert.equal(replaced.totals.requests, 1);

  // And the turn's last model survives, so an attempt can still inherit it.
  const inherited = definition.apply(
    restored,
    { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [usageChunk({ inputTokens: 5, outputTokens: 1 })] } },
  );
  assert.equal(definition.wire.view(inherited).turns[0].models.length, 1);
  assert.equal(definition.wire.view(inherited).turns[0].models[0].model, 'gemini-3.5-flash');
});

test('projection: the published view never leaks internal bookkeeping', () => {
  const definition = sapiCostDefinition();
  const state = fold(definition, [
    messageEvent({ turn: 1, step: 0, model: 'gemini-3.5-flash', usage: { inputTokens: 100, outputTokens: 10 } }),
  ]);
  assert.equal(state.turns[0].lastModel, 'gemini-3.5-flash', 'the fold keeps it internally');
  const parsed = definition.wire.viewSchema.parse(definition.wire.view(state));
  assert.equal(JSON.stringify(parsed).includes('lastModel'), false, 'the wire contract is {turn, totals, models}');
  assert.deepEqual(Object.keys(parsed.turns[0]).sort(), ['models', 'totals', 'turn']);
});

// ───────────────────────────────────────────────────────────────────────────
// Lineage route
// ───────────────────────────────────────────────────────────────────────────

test('lineage (a): a three-level chain A→B→C yields depth 0/1/2 with correct parents', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const summaries = [
      summary('A', null, buckets(100, 10, 1, 1)),
      summary('B', 'A', buckets(200, 20, 2, 2), true),
      summary('C', 'B', buckets(300, 30, 3, 3)),
    ];
    const payload = await lineagePayload(
      { service, list: controllerOf(summaries).list, sessions: undefined, projections: undefined },
      'A',
    );
    assert.equal(payload.ok, true);
    assert.equal(payload.root, 'A');
    assert.equal(payload.truncated, false);
    assert.deepEqual(payload.nodes.map((node) => node.id), ['A', 'B', 'C']);
    assert.deepEqual(payload.nodes.map((node) => node.depth), [0, 1, 2]);
    assert.deepEqual(payload.nodes.map((node) => node.parentId), [null, 'A', 'B']);
    assert.equal(payload.nodes[1].running, true);
    assert.equal(payload.nodes[0].running, false);
    assert.deepEqual(payload.nodes[0].own, buckets(100, 10, 1, 1));
    assert.deepEqual(payload.nodes[2].own, buckets(300, 30, 3, 3));
  } finally {
    restore();
  }
});

test('lineage (b): only the requested session\'s descendants are returned', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const summaries = realLineageSummaries();
    const payload = await lineagePayload(
      { service, list: controllerOf(summaries).list, sessions: undefined, projections: undefined },
      ROOT_ID,
    );
    assert.deepEqual(payload.nodes.map((node) => node.id).sort(), [CHILD_A, CHILD_B, ROOT_ID].sort());
    // An unrelated root and another session's child must not leak in.
    for (const unrelated of ['session-unrelated-1', 'session-unrelated-2', 'session-unrelated-3', 'session-unrelated-4']) {
      assert.equal(payload.nodes.some((node) => node.id === unrelated), false, `${unrelated} must not appear`);
    }
    // And the same tree read from a child shows the child plus its own descendants only.
    const fromChild = await lineagePayload(
      { service, list: controllerOf(summaries).list, sessions: undefined, projections: undefined },
      CHILD_A,
    );
    assert.deepEqual(fromChild.nodes.map((node) => node.id), [CHILD_A]);
    assert.equal(fromChild.nodes[0].depth, 0);
    assert.equal(fromChild.nodes[0].parentId, ROOT_ID, 'the child still reports its real parent');
  } finally {
    restore();
  }
});

test('lineage (c): a parent-pointer cycle terminates and reports truncated', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    // A→B→C→A: an unguarded walk would never finish.
    const cyclic = [
      summary('A', 'C', buckets(1, 1, 1, 1)),
      summary('B', 'A', buckets(2, 2, 2, 2)),
      summary('C', 'B', buckets(3, 3, 3, 3)),
    ];
    const payload = await lineagePayload(
      { service, list: controllerOf(cyclic).list, sessions: undefined, projections: undefined },
      'A',
    );
    assert.equal(payload.truncated, true);
    assert.deepEqual(payload.nodes.map((node) => node.id), ['A', 'B', 'C'], 'each session appears exactly once');
  } finally {
    restore();
  }
});

test('lineage (c2): the depth and node bounds are enforced, not just cycles', async () => {
  // `buildLineage` consumes `lineageRows()` output, so normalize exactly as the
  // route does instead of inventing a second row shape here.
  const deep = [summary('n0', null, buckets(1, 0, 0, 1))];
  for (let index = 1; index < LINEAGE_MAX_DEPTH + 5; index += 1) {
    deep.push(summary(`n${index}`, `n${index - 1}`, buckets(1, 0, 0, 1)));
  }
  const deepWalk = buildLineage('n0', lineageRows(deep));
  assert.equal(deepWalk.truncated, true, 'descending past the depth bound must flag truncation');
  assert.equal(deepWalk.nodes.length, LINEAGE_MAX_DEPTH + 1, 'the walk stops at the depth bound');

  // A fan-out wider than the node bound.
  const wide = [summary('root', null, buckets(1, 0, 0, 1))];
  for (let index = 0; index < LINEAGE_MAX_NODES + 50; index += 1) {
    wide.push(summary(`w${index}`, 'root', buckets(1, 0, 0, 1)));
  }
  const wideWalk = buildLineage('root', lineageRows(wide));
  assert.equal(wideWalk.truncated, true);
  assert.equal(wideWalk.nodes.length, LINEAGE_MAX_NODES, 'the node array is capped');
});

test('lineage (d): a missing sessionController degrades to an empty tree, never throws', async () => {
  const restore = stubProviderFetch();
  const host = createHostStub();
  try {
    const plugin = await loadPlugin();
    // No `sessionController` in `ctx.get`, exactly like an older host.
    plugin.apply(host.ctx, { baseUrl: 'https://fixture.invalid' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const route = host.record.routes.find((candidate) => candidate.path === LINEAGE_ROUTE);
    assert.ok(route, 'the route is registered even when the service is absent');
    const response = await route.fetch(new Request(`http://host/api/sapi-budget/lineage?session=${ROOT_ID}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.root, '');
    assert.deepEqual(body.nodes, []);
    assert.equal(body.truncated, false);

    // Directly: no `list` at all.
    const service = await fixtureService();
    const direct = await lineagePayload({ service, list: undefined }, ROOT_ID);
    assert.deepEqual(direct.nodes, []);
  } finally {
    restore();
    host.dispose();
  }
});

test('lineage (d2): a throwing sessionController also degrades instead of failing the route', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const payload = await lineagePayload(
      { service, list: async () => { throw new Error('store unavailable'); } },
      ROOT_ID,
    );
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.nodes, []);
  } finally {
    restore();
  }
});

test('lineage (e): a missing or unknown ?session= yields ok:true with no nodes', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const list = controllerOf(realLineageSummaries()).list;
    for (const requested of ['', undefined, null, 'no-such-session', '   ']) {
      const payload = await lineagePayload({ service, list }, requested);
      assert.equal(payload.ok, true, `request ${JSON.stringify(requested)} must not error`);
      assert.equal(payload.root, '');
      assert.deepEqual(payload.nodes, []);
    }
    // Defense in depth: an unknown id must not expose any other session's tree.
    const unknown = await lineagePayload({ service, list }, 'session-unrelated-1x');
    assert.deepEqual(unknown.nodes, []);
  } finally {
    restore();
  }
});

test('lineage (f): the payload publishes tokens only, never money', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const payload = await lineagePayload(
      { service, list: controllerOf(realLineageSummaries()).list },
      ROOT_ID,
    );
    // Requires the catalog fields to be present, so the client can price.
    for (const field of ['baseUrl', 'currency', 'quotaPerUnit', 'usdExchangeRate', 'fetchedAt', 'stale', 'error']) {
      assert.ok(Object.hasOwn(payload, field), `lineage must carry ${field}`);
    }
    for (const node of payload.nodes) {
      assert.deepEqual(Object.keys(node).sort(), ['depth', 'exact', 'id', 'own', 'parentId', 'running']);
      assert.deepEqual(Object.keys(node.own).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'requests']);
      // No subtree: the client owns that arithmetic.
      assert.equal(node.subtree, undefined);
    }
    // `usdExchangeRate` is a required catalog RATE, not a per-node amount, so
    // the forbidden-key check runs over the nodes only.
    const serializedNodes = JSON.stringify(payload.nodes);
    for (const forbidden of ['usd', 'cost', 'price', 'subtree']) {
      assert.equal(serializedNodes.includes(forbidden), false, `nodes must not carry ${forbidden}`);
    }
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('"totalCost"'), false);
    assert.deepEqual(JSON.parse(serialized), payload, 'the payload must be JSON-clean');
  } finally {
    restore();
  }
});

test('lineage: the root is read exactly from the attached session projection', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    // The cached summary deliberately carries a STALE value for the root.
    const summaries = [
      summary(ROOT_ID, null, buckets(1, 1, 1, 1)),
      summary(CHILD_A, ROOT_ID, buckets(745828, 149065, 20226176, 164)),
    ];
    const exact = buckets(939268, 211980, 35187072, 315);
    const payload = await lineagePayload(
      {
        service,
        list: controllerOf(summaries).list,
        // `ctx.sessions.get` returns the attached session; the projections
        // registry then answers precisely for it.
        sessions: { get: (id) => (id === ROOT_ID ? { id } : undefined) },
        projections: { snapshot: (session) => (session.id === ROOT_ID ? { asOfSeq: 9, values: { sapiCost: { totals: exact } } } : { asOfSeq: 0, values: {} }) },
      },
      ROOT_ID,
    );
    const root = payload.nodes.find((node) => node.id === ROOT_ID);
    assert.equal(root.exact, true);
    assert.deepEqual(root.own, exact, 'the exact read must override the cached hint');
    // A non-root node can never claim exactness.
    const child = payload.nodes.find((node) => node.id === CHILD_A);
    assert.equal(child.exact, false);
    assert.deepEqual(child.own, buckets(745828, 149065, 20226176, 164));
  } finally {
    restore();
  }
});

test('lineage: an unreadable projection yields own:null, NOT a zero bucket', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const summaries = [
      // `projections` entirely absent — the controller swallows read failures
      // and leaves the field undefined, so this is the real "cannot read" shape.
      summary(ROOT_ID, null, undefined),
      summary(CHILD_A, ROOT_ID, undefined),
      // A malformed view must not propagate NaN into the wire either.
      { sessionId: 'bad', parentSessionId: ROOT_ID, projections: { values: { sapiCost: { totals: { input: 'x', output: null } } } } },
    ];
    const payload = await lineagePayload({ service, list: controllerOf(summaries).list }, ROOT_ID);

    const unknown = payload.nodes.find((node) => node.id === CHILD_A);
    assert.equal(unknown.own, null, '"cannot read" must NOT be reported as a zero bucket');
    assert.equal(unknown.exact, false);

    // A genuinely-zero session and an unreadable one must stay distinguishable.
    const zeroed = summary('zeroed', ROOT_ID, buckets(0, 0, 0, 0));
    const withZero = await lineagePayload(
      { service, list: controllerOf([summary(ROOT_ID, null, buckets(5, 5, 5, 1)), zeroed]).list },
      ROOT_ID,
    );
    assert.deepEqual(withZero.nodes.find((node) => node.id === 'zeroed').own, buckets(0, 0, 0, 0));
    assert.notDeepEqual(withZero.nodes.find((node) => node.id === 'zeroed').own, null);

    // A present-but-partly-malformed view still yields finite numbers.
    const malformed = payload.nodes.find((node) => node.id === 'bad');
    assert.notEqual(malformed.own, null);
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'requests']) {
      assert.ok(Number.isFinite(malformed.own[field]), `${field} must be finite, never NaN`);
    }
  } finally {
    restore();
  }
});

test('lineage: the real workspace tree matches the independent oracle', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const payload = await lineagePayload(
      { service, list: controllerOf(realLineageSummaries()).list },
      ROOT_ID,
    );
    const byId = new Map(payload.nodes.map((node) => [node.id, node]));
    // Ground truth from `.oracle-lineage.py`: own buckets read straight from the logs.
    assert.deepEqual(byId.get(ROOT_ID).own, buckets(939268, 211980, 35187072, 315));
    assert.deepEqual(byId.get(CHILD_A).own, buckets(745828, 149065, 20226176, 164));
    assert.deepEqual(byId.get(CHILD_B).own, buckets(899301, 148643, 40146048, 249));
    // The client's formula must reproduce the oracle's subtree total.
    const total = payload.nodes.reduce(
      (sum, node) => ({
        input: sum.input + node.own.input,
        output: sum.output + node.own.output,
        cacheRead: sum.cacheRead + node.own.cacheRead,
        cacheWrite: sum.cacheWrite + node.own.cacheWrite,
        requests: sum.requests + node.own.requests,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
    );
    assert.deepEqual(total, buckets(2584397, 509688, 95559296, 728));
  } finally {
    restore();
  }
});

test('lineage: sessionFromRequest reads ?session= defensively', () => {
  assert.equal(sessionFromRequest(new Request('http://x/api/sapi-budget/lineage?session=abc')), 'abc');
  assert.equal(sessionFromRequest(new Request('http://x/api/sapi-budget/lineage')), '');
  assert.equal(sessionFromRequest({}), '');
});

test('lineage: bucketsFromView separates "unreadable" from "no usage"', () => {
  // No view at all -> unknown, never a zero bucket.
  for (const absent of [undefined, null, 'nope', 42, []]) {
    assert.equal(bucketsFromView(absent), undefined, `${JSON.stringify(absent)} must stay unreadable`);
  }
  // A real view, with and without an explicit `totals` wrapper.
  assert.deepEqual(bucketsFromView({ totals: buckets(1, 2, 3, 4) }), buckets(1, 2, 3, 4));
  assert.deepEqual(bucketsFromView(buckets(1, 2, 3, 4)), buckets(1, 2, 3, 4));
  // Genuine zero usage is a real reading and must be preserved as a bucket.
  assert.deepEqual(bucketsFromView({ totals: buckets(0, 0, 0, 0) }), buckets(0, 0, 0, 0));
  // Junk fields collapse to zero rather than NaN.
  assert.deepEqual(
    bucketsFromView({ totals: { input: 'x', output: null, cacheRead: Number.NaN, cacheWrite: -5 } }),
    buckets(0, 0, 0, 0),
  );
});

test('lineage: a node with no readable projection is own:null, exact:false', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    // Root readable, its child NOT (a pre-install session with no sapiCost row).
    const summaries = [
      summary(ROOT_ID, null, buckets(939268, 211980, 35187072, 315)),
      summary(CHILD_A, ROOT_ID, undefined),
    ];
    const payload = await lineagePayload({ service, list: controllerOf(summaries).list }, ROOT_ID);

    const root = payload.nodes.find((node) => node.id === ROOT_ID);
    assert.deepEqual(root.own, buckets(939268, 211980, 35187072, 315));
    assert.equal(root.exact, false, 'a cached hint is not the exact read');

    const child = payload.nodes.find((node) => node.id === CHILD_A);
    assert.equal(child.own, null, 'the client must be able to tell "unknown" from "zero"');
    assert.equal(child.exact, false);
    // The node itself is still reported, so the tree shape stays intact.
    assert.equal(child.parentId, ROOT_ID);
    assert.equal(child.depth, 1);
  } finally {
    restore();
  }
});

// ── diagnosis: an empty tree must say WHY it is empty ───────────────────────
// Field evidence: a real GUI run answered `{ root: "", nodes: [] }` and that
// single shape covered four different faults — no session passed, no
// sessionController bound, list() throwing, and the id simply not being in the
// store. All four were indistinguishable from the wire, so the Client silently
// fell back to "this session only" and the subagent money quietly went missing.
// That ambiguity is the bug this group locks down.
test('lineage (g): every empty-tree branch names its reason on the wire', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();

    const noSession = await lineagePayload({ service, list: controllerOf([]).list }, '');
    assert.equal(noSession.ok, true);
    assert.equal(noSession.root, '');
    assert.equal(noSession.reason, 'no-session', 'a missing ?session= must be self-describing');

    const noController = await lineagePayload({ service, list: undefined }, ROOT_ID);
    assert.equal(noController.root, '');
    assert.equal(noController.reason, 'no-controller');

    const throwing = await lineagePayload(
      { service, list: async () => { throw new Error('store exploded'); } },
      ROOT_ID,
    );
    assert.equal(throwing.root, '');
    assert.equal(throwing.reason, 'list-failed');
    assert.equal(throwing.error, 'store exploded', 'the underlying failure must not be swallowed silently');

    const unknown = await lineagePayload({ service, list: controllerOf(realLineageSummaries()).list }, 'session-nope');
    assert.equal(unknown.root, '');
    assert.equal(unknown.reason, 'not-in-store');
    assert.ok(unknown.summaries >= 1, 'the store was readable, so the count proves list() actually ran');
  } finally {
    restore();
  }
});

test('lineage (h): a successful tree carries no reason, only the nodes', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const payload = await lineagePayload(
      { service, list: controllerOf(realLineageSummaries()).list },
      ROOT_ID,
    );
    assert.equal(payload.reason, undefined, 'a real tree must not be labelled as a failure');
    assert.equal(payload.root, ROOT_ID);
    assert.ok(payload.nodes.length >= 3);
  } finally {
    restore();
  }
});

// ── the remote envelope: list() answers { items: [...] }, not an array ──────
// Field evidence, and the actual root cause of a GUI run where the session
// header silently dropped all subagent money:
//
//   sessionController.list  → { items: [...] }   (a @Remote("list") RPC method)
//   sessionQuery.listSessions → [...]            (the local data source inside it)
//
// The plugin awaited the RPC method and treated the envelope as an array, so
// `Array.isArray(summaries)` was false and `lineageRows` returned [] — while
// 562 rows were sitting one hop away. Nothing threw. The header simply showed
// this session's own total and the subagent spend vanished.
test('lineage (i): the remote { items } envelope is unwrapped, not discarded', async () => {
  const restore = stubProviderFetch();
  try {
    const service = await fixtureService();
    const rows = realLineageSummaries();
    // Exactly what the decorated controller returns from the plugin's context.
    const payload = await lineagePayload({ service, list: async () => ({ items: rows }) }, ROOT_ID);
    assert.equal(payload.root, ROOT_ID, 'the envelope must be unwrapped, not treated as a bad array');
    assert.ok(payload.nodes.length >= 3, `expected the real tree, got ${payload.nodes.length} nodes`);
    assert.deepEqual(
      payload.nodes.filter((node) => node.parentId === ROOT_ID).map((node) => node.id).sort(),
      [CHILD_A, CHILD_B].sort(),
    );
  } finally {
    restore();
  }
});

test('lineage (j): lineageRows accepts an envelope, a bare array, or nothing', () => {
  const rows = realLineageSummaries();
  for (const input of [rows, { items: rows }]) {
    assert.equal(lineageRows(input).length, rows.length, `shape ${Array.isArray(input) ? 'array' : 'envelope'} must work`);
  }
  for (const junk of [undefined, null, 'nope', 42, { items: null }, { items: 'nope' }, {}]) {
    assert.deepEqual(lineageRows(junk), [], `shape ${JSON.stringify(junk)} must degrade to []`);
  }
});
