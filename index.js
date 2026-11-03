/**
 * Host half of the `sapi-budget` bundle.
 *
 * Three responsibilities, deliberately kept independent of one another:
 *
 *   1. Catalog service — fetch the AiSpot (new-api) pricing catalog, keep the
 *      last good snapshot in memory, refresh it on a timer. A failed refresh
 *      NEVER clears the catalog: it only marks the payload `stale` and reports
 *      the error, so a flaky network cannot blank the user's prices.
 *   2. HTTP routes — two exact Connection Fetch routes the Client half calls:
 *      `GET /api/sapi-budget/state` and `POST /api/sapi-budget/refresh`.
 *   3. Session projection — `sapiCost`, which folds provider-reported token
 *      buckets per turn × model. It publishes tokens ONLY, never money: the
 *      Client multiplies them by the live catalog, so switching group
 *      re-prices every historical turn without replaying the session.
 *
 * Import policy (load-bearing): this package resolves no `@deepseek-ai/*` and
 * no `zod`. Only Node built-ins and `./pricing.js` may be imported, so every
 * schema below is a hand-written duck type exposing the two members the host
 * actually calls (`.parse()` for projections, `'~standard'.validate` for the
 * Loader's config resolution).
 */

import { DEFAULT_BASE_URL, fetchCatalog } from './pricing.js';

/** Plugin id; the bundle patch and the plugin row spell it the same way. */
export const name = 'sapi-budget';

/** Session projection key published to the Client half. */
export const PROJECTION_KEY = 'sapiCost';

/** Exact Connection Fetch routes (host side carries the leading slash). */
export const STATE_ROUTE = '/api/sapi-budget/state';
export const REFRESH_ROUTE = '/api/sapi-budget/refresh';
export const LINEAGE_ROUTE = '/api/sapi-budget/lineage';

/**
 * Lineage traversal guards. A malformed store (or a hostile one) must never
 * turn one request into an unbounded walk, so the traversal is bounded three
 * ways: how deep it descends, how many nodes it emits, and a `visited` set
 * that makes a parent-pointer cycle terminate instead of spinning forever.
 * Hitting any bound sets `truncated: true` and stops expanding.
 */
export const LINEAGE_MAX_DEPTH = 16;
export const LINEAGE_MAX_NODES = 200;

/** Agent tool that answers "what does this model cost". */
export const TOOL_NAME = 'sapi_price';

/** Provider-catalog defaults; `cordis.patch.yml` may override every field. */
export const CONFIG_DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  group: '',
  currency: 'USD',
  refreshMinutes: 30,
});

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Coerce to a non-negative safe integer, or `undefined` when unusable. */
function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

/** A finite number, or `fallback`. */
function toFinite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ───────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────

/**
 * Normalize whatever the Loader handed us into the plugin's own option shape.
 * Pure and total: a missing, partial, or hostile config still yields a usable
 * object, because this runs before the first catalog fetch.
 *
 * @param value - raw plugin config from `cordis.patch.yml`.
 * @returns complete options.
 */
export function normalizeConfig(value) {
  const raw = isRecord(value) ? value : {};
  const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== '' ? raw.baseUrl.trim() : CONFIG_DEFAULTS.baseUrl;
  const group = typeof raw.group === 'string' ? raw.group.trim() : CONFIG_DEFAULTS.group;
  const currency = typeof raw.currency === 'string' && raw.currency.trim() !== '' ? raw.currency.trim() : CONFIG_DEFAULTS.currency;
  const minutes = toFinite(raw.refreshMinutes, CONFIG_DEFAULTS.refreshMinutes);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    group,
    currency,
    refreshMinutes: minutes > 0 ? minutes : 0,
  };
}

/**
 * Hand-written Config schema.
 *
 * `cordis` 0.2.x resolves a plugin's config through
 * `Config['~standard'].validate(raw)` — not through `.parse()` — so a schema
 * exposing only `.parse()` would throw at activation. Both members are
 * provided here: `'~standard'` for the Loader, `parse()` for anything that
 * expects a schemastery/zod-shaped object. No dependency is imported.
 */
export const Config = {
  parse: normalizeConfig,
  '~standard': {
    version: 1,
    vendor: 'sapi-budget',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: String(error?.message ?? error) }] };
      }
    },
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Duck-typed schemas for the projection registry
// ───────────────────────────────────────────────────────────────────────────

const BACKGROUND_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'requests']);

/** Validate one token bucket, normalizing absent fields to zero. */
function parseBuckets(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const out = {};
  for (const field of BACKGROUND_FIELDS) {
    const count = toCount(value[field]);
    out[field] = count === undefined ? 0 : count;
  }
  return out;
}

/** Validate one `{ model, ...buckets }` row. */
function parseModelRow(value) {
  if (!isRecord(value)) throw new TypeError('sapiCost model row must be an object');
  if (typeof value.model !== 'string' || value.model === '') throw new TypeError('sapiCost model row needs a model name');
  return { model: value.model, ...parseBuckets(value, 'sapiCost model row') };
}

/**
 * Validate one turn row.
 *
 * `lastModel` is internal bookkeeping (it lets a later `assistant/attempt`
 * inherit the turn's model), but it rides in the turn row so a restored
 * checkpoint keeps that ability. `parseView` strips it before it can reach the
 * Client.
 */
function parseTurnRow(value) {
  if (!isRecord(value)) throw new TypeError('sapiCost turn row must be an object');
  const turn = toCount(value.turn);
  if (turn === undefined) throw new TypeError('sapiCost turn row needs a turn number');
  if (!Array.isArray(value.models)) throw new TypeError('sapiCost turn row needs a models array');
  return {
    turn,
    totals: parseBuckets(value.totals, 'sapiCost turn totals'),
    models: value.models.map(parseModelRow),
    lastModel: typeof value.lastModel === 'string' && value.lastModel !== '' ? value.lastModel : null,
  };
}

/**
 * Validate one projection state. Used by the registry on checkpoint restore,
 * so it accepts anything this module produced and nothing else.
 */
export function parseState(value) {
  if (!isRecord(value)) throw new TypeError('sapiCost state must be an object');
  const totals = parseBuckets(value.totals, 'sapiCost totals');
  const turns = Array.isArray(value.turns) ? value.turns.map(parseTurnRow) : [];
  const last = isRecord(value.last)
    ? {
        turn: toCount(value.last.turn) ?? 0,
        step: toCount(value.last.step) ?? 0,
        model: typeof value.last.model === 'string' ? value.last.model : UNKNOWN_MODEL,
        buckets: parseBuckets(value.last.buckets, 'sapiCost last buckets'),
      }
    : null;
  return { totals, turns, last };
}

/**
 * Validate one wire view — exactly the shape the Client half consumes.
 *
 * `parseTurnRow` carries `lastModel` so a restored checkpoint keeps it, but
 * the published wire contract is `{turn, totals, models}`: internal
 * bookkeeping must not cross to the browser.
 */
export function parseView(value) {
  if (!isRecord(value)) throw new TypeError('sapiCost view must be an object');
  if (!Array.isArray(value.turns)) throw new TypeError('sapiCost view needs a turns array');
  return {
    totals: parseBuckets(value.totals, 'sapiCost view totals'),
    turns: value.turns.map((row) => {
      const parsed = parseTurnRow(row);
      return { turn: parsed.turn, totals: parsed.totals, models: parsed.models };
    }),
  };
}

/**
 * The registry only ever calls `.parse()` on these, then forwards the result
 * to the Client. Branding them as schemastery is unnecessary and impossible
 * here, so a plain object with the one required method is the whole contract.
 */
const stateSchema = { parse: parseState };
const viewSchema = { parse: parseView };

// ───────────────────────────────────────────────────────────────────────────
// sapiCost projection
// ───────────────────────────────────────────────────────────────────────────

/** Model bucket used when a sample carries no model name and none is known yet. */
export const UNKNOWN_MODEL = 'unknown';

const zeroBuckets = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 });

const clampBucket = (value) => (value > 0 ? Math.trunc(value) : 0);

/** Add two buckets, clamping at zero so the wire schema never sees a negative. */
function addBuckets(left, right) {
  const out = {};
  for (const field of BACKGROUND_FIELDS) out[field] = clampBucket((left[field] ?? 0) + (right[field] ?? 0));
  return out;
}

/** Subtract `right` from `left`, clamping at zero. */
function subtractBuckets(left, right) {
  const out = {};
  for (const field of BACKGROUND_FIELDS) out[field] = clampBucket((left[field] ?? 0) - (right[field] ?? 0));
  return out;
}

const bucketsEqual = (left, right) => BACKGROUND_FIELDS.every((field) => (left[field] ?? 0) === (right[field] ?? 0));

const bucketIsEmpty = (bucket) => BACKGROUND_FIELDS.every((field) => (bucket[field] ?? 0) === 0);

/** Normalize provider usage into the projection's token buckets. */
export function bucketsFromUsage(usage) {
  return {
    input: toCount(usage?.inputTokens) ?? 0,
    output: toCount(usage?.outputTokens) ?? 0,
    cacheRead: toCount(usage?.cacheReadTokens) ?? 0,
    cacheWrite: toCount(usage?.cacheWriteTokens) ?? 0,
    // One settled sample is one billed request; a fixed-price model needs it.
    requests: 1,
  };
}

/**
 * The usage one durable settlement reports, mirroring `dsh-token-meter`:
 * `assistant/message` prefers its own `data.usage`, everything else reads the
 * last `usage` chunk out of the embedded provider stream.
 *
 * @param event - a committed session event.
 * @returns the provider usage, or `undefined` when this event carries none.
 */
export function usageOf(event) {
  const data = event?.data;
  if (!isRecord(data)) return undefined;
  if (isRecord(data.usage)) return data.usage;
  if (!Array.isArray(data.stream)) return undefined;
  for (let index = data.stream.length - 1; index >= 0; index -= 1) {
    const record = data.stream[index];
    if (!isRecord(record) || record.type !== 'chunk') continue;
    const chunk = record.chunk;
    if (!isRecord(chunk) || chunk.type !== 'usage') continue;
    if (isRecord(chunk.usage)) return chunk.usage;
  }
  return undefined;
}

/**
 * The provider model id of one settlement.
 *
 * Only `assistant/message` carries it (`message.source.model` with
 * `source.kind === 'model'`); `assistant/attempt` settles a stream with no
 * message at all, so the caller falls back to the turn's last known model.
 *
 * @param event - a committed session event.
 * @returns the model id, or `undefined` when this event does not name one.
 */
export function modelOf(event) {
  const source = event?.data?.message?.source;
  if (!isRecord(source)) return undefined;
  if (typeof source.model !== 'string' || source.model === '') return undefined;
  if (source.kind !== undefined && source.kind !== 'model') return undefined;
  return source.model;
}

/** The newest model this projection saw for one turn. */
function knownModel(turns, turn) {
  for (const row of turns) if (row.turn === turn && typeof row.lastModel === 'string' && row.lastModel !== '') return row.lastModel;
  return undefined;
}

/** Drop turn rows with no model buckets left, keeping the array turn-ascending. */
function normalizeTurns(turns) {
  const kept = turns.filter((row) => row.models.length > 0);
  kept.sort((left, right) => left.turn - right.turn);
  return kept;
}

/** Add one contribution to a turn × model bucket set. */
function addContribution(turns, turn, model, buckets) {
  const index = turns.findIndex((row) => row.turn === turn);
  const base = index === -1 ? { turn, totals: zeroBuckets(), models: [], lastModel: null } : turns[index];
  const models = base.models.slice();
  const modelIndex = models.findIndex((row) => row.model === model);
  const previous = modelIndex === -1 ? zeroBuckets() : models[modelIndex];
  const nextModel = { model, ...addBuckets(previous, buckets) };
  if (modelIndex === -1) models.push(nextModel);
  else models[modelIndex] = nextModel;
  const record = { turn, totals: addBuckets(base.totals, buckets), models, lastModel: model };
  const next = turns.slice();
  if (index === -1) next.push(record);
  else next[index] = record;
  return normalizeTurns(next);
}

/**
 * Remove the contribution a replaced sample previously made.
 *
 * A replacement can move a sample to a different model bucket (the retried
 * attempt may resolve a different model), so the subtraction is keyed by the
 * model the earlier sample was filed under, never by the incoming one.
 */
function removeContribution(turns, contribution) {
  if (contribution === undefined) return turns;
  const index = turns.findIndex((row) => row.turn === contribution.turn);
  if (index === -1) return turns;
  const base = turns[index];
  const models = [];
  for (const row of base.models) {
    if (row.model !== contribution.model) {
      models.push(row);
      continue;
    }
    const shrunk = { model: row.model, ...subtractBuckets(row, contribution.buckets) };
    if (!bucketIsEmpty(shrunk)) models.push(shrunk);
  }
  const record = { turn: base.turn, totals: subtractBuckets(base.totals, contribution.buckets), models, lastModel: base.lastModel };
  const next = turns.slice();
  next[index] = record;
  return normalizeTurns(next);
}

/** Sorted, freshly allocated JSON for the registry to hand to the Client. */
function viewOf(state) {
  const turns = normalizeTurns(state.turns).map((row) => {
    const models = row.models
      .map((model) => ({ model: model.model, ...pickBuckets(model) }))
      .sort((left, right) => left.model.localeCompare(right.model));
    return { turn: row.turn, totals: pickBuckets(row.totals), models };
  });
  return { totals: pickBuckets(state.totals), turns };
}

/** Copy just the published bucket fields, which keeps `lastModel` internal. */
function pickBuckets(source) {
  return {
    input: source.input ?? 0,
    output: source.output ?? 0,
    cacheRead: source.cacheRead ?? 0,
    cacheWrite: source.cacheWrite ?? 0,
    requests: source.requests ?? 0,
  };
}

/**
 * The `sapiCost` projection definition.
 *
 * `apply` is a pure fold that mirrors `dsh-token-meter`'s `tokenUsage` unit:
 * one `last` replacement slot keyed by `turn`+`step`, cleared by
 * `llm/retry-started` so a retried attempt adds instead of replacing. Every
 * ignored event returns the SAME state reference — `Object.is` on that
 * reference is the host's change gate, so allocating here would notify every
 * subscriber on every unrelated session event.
 *
 * @returns a registry-ready definition.
 */
export function sapiCostDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema,
    init: () => ({ totals: zeroBuckets(), turns: [], last: null }),
    apply(state, event) {
      const current = state ?? { totals: zeroBuckets(), turns: [], last: null };
      if (!isRecord(event)) return current;
      if (event.type === 'llm/retry-started') {
        const last = current.last;
        if (last === null) return current;
        if (!isRecord(event.data)) return current;
        if (last.turn !== event.data.turn || last.step !== event.data.step) return current;
        return { ...current, last: null };
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return current;
      const data = event.data;
      if (!isRecord(data)) return current;
      const turn = toCount(data.turn);
      const step = toCount(data.step);
      if (turn === undefined || step === undefined) return current;
      const usage = usageOf(event);
      if (usage === undefined) return current;
      const buckets = bucketsFromUsage(usage);
      const model = modelOf(event) ?? knownModel(current.turns, turn) ?? UNKNOWN_MODEL;
      const last = current.last;
      const replaced = last !== null && last.turn === turn && last.step === step ? last : undefined;
      // Same sample, same numbers: nothing downstream needs to hear about it.
      if (replaced !== undefined && replaced.model === model && bucketsEqual(replaced.buckets, buckets)) return current;
      const shrunk = removeContribution(current.turns, replaced);
      const turns = addContribution(shrunk, turn, model, buckets);
      const totals = addBuckets(subtractBuckets(current.totals, replaced?.buckets ?? zeroBuckets()), buckets);
      return { totals, turns, last: { turn, step, model, buckets } };
    },
    wire: { viewSchema, view: viewOf },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Catalog service
// ───────────────────────────────────────────────────────────────────────────

/** `Error` to a one-line message, never a stack. */
function describeError(error) {
  const message = String(error?.message ?? error ?? 'unknown error');
  return message.split('\n')[0];
}

/**
 * In-memory catalog holder.
 *
 * `snapshot` is replaced wholesale on success and left untouched on failure —
 * that is the whole point of the class. `error` and `stale` are the only
 * things a failed refresh may change.
 *
 * @param options - normalized plugin options.
 * @param logger - host logger.
 * @param deps - optional `{ fetchCatalog }` seam; tests pass a fixture
 *   fetcher, production leaves it undefined and hits the provider.
 * @returns the service.
 */
export function createCatalogService(options, logger, deps = {}) {
  const loadCatalog = typeof deps.fetchCatalog === 'function' ? deps.fetchCatalog : fetchCatalog;
  let snapshot = null;
  let error = null;
  let inflight = null;
  let disposed = false;
  let currentGroup = options.group;

  const refresh = async () => {
    if (inflight !== null) return inflight;
    inflight = (async () => {
      try {
        const next = await loadCatalog(options.baseUrl);
        if (disposed) return snapshot;
        snapshot = next;
        error = null;
      } catch (failure) {
        if (disposed) return snapshot;
        // Keep the previous catalog: a stale price table beats no price table.
        error = describeError(failure);
        logger?.warn?.(`sapi-budget: catalog refresh failed for ${options.baseUrl}: ${error}`);
      } finally {
        inflight = null;
      }
      return snapshot;
    })();
    return inflight;
  };

  const ensure = async () => {
    if (snapshot !== null) return snapshot;
    return refresh();
  };

  return {
    get snapshot() {
      return snapshot;
    },
    get error() {
      return error;
    },
    get stale() {
      return error !== null;
    },
    /** The group the Client last asked for; the tool's default. */
    get group() {
      return currentGroup;
    },
    set group(value) {
      if (typeof value === 'string' && value !== '') currentGroup = value;
    },
    refresh,
    ensure,
    dispose() {
      disposed = true;
    },
    /** Resolve a requested group against the live provider catalog. */
    resolveGroup(requested) {
      const wanted = typeof requested === 'string' && requested !== '' ? requested : currentGroup;
      if (snapshot === null) return wanted ?? '';
      return snapshot.resolveGroup(wanted);
    },
    /**
     * The single payload both routes return, exactly as the Client expects it.
     *
     * `models` is `describeModel()` output for the resolved group; the
     * snapshot's `Map` is expanded here because JSON has no Map.
     *
     * @param requestedGroup - raw `?group=` from the request, possibly empty.
     * @returns a JSON-serializable state payload.
     */
    statePayload(requestedGroup) {
      const requested = typeof requestedGroup === 'string' && requestedGroup !== '' ? requestedGroup : currentGroup;
      const groups = snapshot === null ? [] : snapshot.groups().map((entry) => ({ name: entry.name, ratio: entry.ratio }));
      const group = snapshot === null ? String(requested ?? '') : snapshot.resolveGroup(requested);
      const models = [];
      if (snapshot !== null) {
        for (const model of snapshot.models.values()) {
          try {
            models.push(snapshot.describeModel(model, group));
          } catch (failure) {
            // One unusable provider row must not sink the whole catalog.
            logger?.warn?.(`sapi-budget: cannot describe model ${model?.name}: ${describeError(failure)}`);
          }
        }
        models.sort((left, right) => String(left.name).localeCompare(String(right.name)));
      }
      return {
        ok: error === null && snapshot !== null,
        baseUrl: options.baseUrl,
        group,
        requestedGroup: String(requested ?? ''),
        groups,
        models,
        quotaPerUnit: snapshot?.quotaPerUnit ?? 0,
        usdExchangeRate: snapshot?.usdExchangeRate ?? 0,
        currency: options.currency !== '' ? options.currency : (snapshot?.currency ?? 'USD'),
        fetchedAt: snapshot?.fetchedAt ?? 0,
        stale: error !== null,
        error,
      };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Agent tool: sapi_price
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compile the authoring form into the raw JSON Schema the tool registry
 * actually stores.
 *
 * `ctx.tools.register` does NOT compile `parameters`: it detaches the object
 * and hands it to the model adapter as `input_schema` verbatim. Only
 * `defineTool` runs the authoring-form compiler, and `defineTool` cannot be
 * imported here. So the authoring form stays readable in this file and is
 * compiled by this local mirror of the subset (`required: true` on a property
 * becomes the parent's `required` array).
 *
 * @param spec - `{ [name]: valueSchema }` with optional `required: true`.
 * @returns an object-rooted raw JSON Schema.
 */
export function compileParameters(spec) {
  if (!isRecord(spec)) throw new TypeError('sapi_price parameters must be an object');
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(spec)) {
    if (!isRecord(node)) throw new TypeError(`sapi_price parameter ${key} must be a schema object`);
    if (node.required === true) required.push(key);
    properties[key] = compileValue(node);
  }
  return {
    type: 'object',
    properties,
    ...required.length > 0 ? { required } : {},
    additionalProperties: false,
  };
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
const ANNOTATION_KEYS = ['description', 'title'];

/** Compile one authoring-form value schema into the supported raw subset. */
function compileValue(node) {
  if (!isRecord(node)) throw new TypeError('sapi_price schema node must be an object');
  if (Array.isArray(node.oneOf)) {
    return {
      oneOf: node.oneOf.map((branch) => compileValue(branch)),
      ...annotationsOf(node),
    };
  }
  if (node.type === 'object') {
    const properties = {};
    const required = [];
    for (const [key, child] of Object.entries(isRecord(node.properties) ? node.properties : {})) {
      if (isRecord(child) && child.required === true) required.push(key);
      properties[key] = compileValue(child);
    }
    return {
      type: 'object',
      properties,
      ...required.length > 0 ? { required } : {},
      additionalProperties: node.additionalProperties === true,
      ...annotationsOf(node),
    };
  }
  if (node.type === 'array') {
    return {
      type: 'array',
      ...node.items === undefined ? {} : { items: compileValue(node.items) },
      ...annotationsOf(node),
    };
  }
  if (!SCALAR_TYPES.has(node.type)) throw new TypeError(`sapi_price schema type ${JSON.stringify(node.type)} is unsupported`);
  const out = { type: node.type };
  if (Array.isArray(node.enum)) out.enum = node.enum.slice();
  if (node.const !== undefined) out.const = node.const;
  return { ...out, ...annotationsOf(node) };
}

/** Carry the two annotations the tool contract allows onto a compiled node. */
function annotationsOf(node) {
  const out = {};
  for (const key of ANNOTATION_KEYS) if (typeof node[key] === 'string') out[key] = node[key];
  return out;
}

/**
 * Authoring-form parameters for `sapi_price`. Compiled by
 * {@link compileParameters} before registration — see its note for why.
 */
export const PRICE_PARAMETERS = Object.freeze({
  model: {
    type: 'string',
    required: true,
    description: 'Model id exactly as the provider lists it, e.g. "deepseek-v4.1-flash" or "gemini-3.5-flash".',
  },
  group: {
    type: 'string',
    description: 'Pricing group (provider tier). Omit to use the group the user currently selected in the UI.',
  },
  inputTokens: { type: 'number', description: 'Uncached input tokens of the call, to price one concrete request.' },
  outputTokens: { type: 'number', description: 'Output tokens of the call.' },
  cacheReadTokens: { type: 'number', description: 'Cache-read (hit) tokens of the call.' },
  cacheWriteTokens: { type: 'number', description: 'Cache-write (creation) tokens of the call.' },
});

/** Raw JSON Schema for the tool result; the registry validates the value against it. */
export const PRICE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    model: { type: 'string' },
    group: { type: 'string' },
    kind: { type: 'string', enum: ['ratio', 'tiered', 'fixed', 'unknown'] },
    usd: { type: 'number' },
    estimated: { type: 'boolean' },
  },
  required: ['ok', 'text'],
  additionalProperties: false,
});

/** Trim a rate to its shortest exact decimal form. */
function formatRate(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

/** USD with four decimals below a cent, two above. */
function formatUsd(value) {
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}

/**
 * Describe one model's rates in one group, and — when token counts are given —
 * the price of that concrete request.
 *
 * @param service - the catalog service.
 * @param args - tool arguments.
 * @returns the declared output value.
 */
async function priceModel(service, args) {
  await service.ensure();
  const snapshot = service.snapshot;
  if (snapshot === null) {
    return { ok: false, text: `Price catalog unavailable: ${service.error ?? 'the provider has not answered yet'}.` };
  }
  const modelName = String(args?.model ?? '').trim();
  const model = snapshot.models.get(modelName);
  const group = service.resolveGroup(args?.group);
  if (model === undefined) {
    return { ok: false, text: `Unknown model ${JSON.stringify(modelName)}. The provider lists no model with that exact id.` };
  }
  const described = snapshot.describeModel(model, group);
  const lines = [`${described.name} @ ${group}`];
  if (described.kind === 'fixed') {
    lines.push(`Billed per request: $${formatRate(described.perRequest)}`);
  } else if (described.kind === 'tiered') {
    lines.push('Billed by expression (USD per 1M tokens), tiers by prompt length:');
    for (const tier of described.tiers ?? []) {
      const base = tier.base > 0 ? ` + $${formatRate(tier.base)}/request` : '';
      lines.push(`  len >= ${tier.minLength}: in $${formatRate(tier.input)}, out $${formatRate(tier.output)}, cacheRead $${formatRate(tier.cacheRead)}, cacheWrite $${formatRate(tier.cacheWrite)}${base}`);
    }
  } else {
    lines.push(`USD per 1M tokens: in $${formatRate(described.input)}, out $${formatRate(described.output)}, cacheRead $${formatRate(described.cacheRead)}, cacheWrite $${formatRate(described.cacheWrite)}`);
  }
  const tokens = {
    inputTokens: toCount(args?.inputTokens) ?? 0,
    outputTokens: toCount(args?.outputTokens) ?? 0,
    cacheReadTokens: toCount(args?.cacheReadTokens) ?? 0,
    cacheWriteTokens: toCount(args?.cacheWriteTokens) ?? 0,
  };
  const hasTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens > 0;
  const value = { ok: true, model: described.name, group, kind: described.kind };
  if (hasTokens) {
    const cost = snapshot.costOf(modelName, group, tokens);
    if (cost === undefined) {
      lines.push('Cannot price these token counts with this model\'s rate table.');
      value.kind = 'unknown';
    } else {
      value.usd = cost.usd;
      value.estimated = cost.estimated;
      lines.push(`Cost of this request: $${formatRate(cost.usd)}${cost.estimated ? ' (estimate: tiered or fixed billing)' : ''}`);
    }
  }
  value.text = lines.join('\n');
  return value;
}

/** Build the registry-ready tool definition. */
export function priceToolDefinition(service) {
  return {
    name: TOOL_NAME,
    description:
      'Look up what an AiSpot (sapi) model costs in a pricing group, and optionally price one concrete request. ' +
      'Rates come from the provider\'s live published catalog, so they reflect the group the user selected. ' +
      'Tiered and per-request models are marked as estimates.',
    parameters: compileParameters(PRICE_PARAMETERS),
    output: {
      schema: PRICE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      return priceModel(service, args ?? {});
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Session lineage
// ───────────────────────────────────────────────────────────────────────────

/**
 * Why this exists at all.
 *
 * A subagent runs in its OWN session with its own event log, linked back by
 * `header.parentSession`. Our `sapiCost` projection folds one session's log, so
 * by construction a parent session cannot see a child's tokens. The Client
 * therefore asks for the whole lineage and sums it itself:
 *
 *     subtree(s) = own(s) + Σ_{c ∈ children(s)} subtree(c)
 *
 * This route publishes one `own` bucket per session and NOTHING else — no
 * subtree, no money. Subtree arithmetic lives in exactly one place (the
 * Client), so the two halves cannot drift apart, and re-pricing after a group
 * switch stays a client-local recompute.
 */

/**
 * Read one projection view's totals into the plugin's bucket shape.
 *
 * Returns `undefined` — NOT a zero bucket — when there is no readable
 * projection. "This subagent spent nothing" and "we cannot see what this
 * subagent spent" are different facts, and the Client must be able to tell
 * them apart: a zero bucket would silently under-report a session whose
 * `sapiCost` row predates this plugin, or whose projection the controller
 * failed to read.
 *
 * @param view - a `sapiCost` view (`{ totals, turns }`) or a bare totals object.
 * @returns the bucket, or `undefined` when no view was supplied.
 */
export function bucketsFromView(view) {
  if (!isRecord(view)) return undefined;
  const totals = isRecord(view.totals) ? view.totals : view;
  if (!isRecord(totals)) return undefined;
  return {
    input: toCount(totals.input) ?? 0,
    output: toCount(totals.output) ?? 0,
    cacheRead: toCount(totals.cacheRead) ?? 0,
    cacheWrite: toCount(totals.cacheWrite) ?? 0,
    requests: toCount(totals.requests) ?? 0,
  };
}

/**
 * Turn `sessionController.list()` into `{ id, parentId, running, own }` rows.
 *
 * The SHAPE is the first trap, and it cost a real deployment its subagent
 * money: `sessionController.list` is a `@Remote("list")` RPC method, so it
 * resolves to `{ items: [...] }`, not to a bare array. The local data source
 * underneath (`sessionQuery.listSessions`) is the one that returns an array.
 * Awaiting the RPC method and testing `Array.isArray` therefore rejected a
 * perfectly good envelope and produced an empty tree with no error anywhere —
 * the header quietly fell back to "this session only". Accept both shapes, and
 * treat anything else as "no rows" rather than guessing.
 *
 * Field names are the second trap: the summary renames `header.parentSession`
 * to `parentSessionId`, and OMITS the field entirely for a root session (it is
 * not `null`). `projections` is also optional — the controller swallows a
 * projection read failure and leaves it undefined — so every hop is guarded,
 * and an unreadable view stays `undefined` rather than becoming a zero bucket.
 *
 * Deliberate scope limit: a session whose `sapiCost` row predates this plugin
 * is reported as UNREADABLE, never recomputed. Cold-reading its raw log would
 * mean re-implementing the fold here, risking a second and divergent source of
 * truth; the Client is simply told the value is unavailable.
 *
 * @param summaries - whatever `list()` resolved to: an array, an `{ items }`
 *   envelope, or anything else (which yields no rows).
 * @returns normalized rows, in the order given.
 */
export function lineageRows(summaries) {
  const rows = [];
  const list = Array.isArray(summaries)
    ? summaries
    : isRecord(summaries) && Array.isArray(summaries.items)
      ? summaries.items
      : undefined;
  if (list === undefined) return rows;
  for (const summary of list) {
    if (!isRecord(summary)) continue;
    const id = typeof summary.sessionId === 'string' && summary.sessionId !== '' ? summary.sessionId : undefined;
    if (id === undefined) continue;
    const parentRaw = summary.parentSessionId;
    const parentId = typeof parentRaw === 'string' && parentRaw !== '' ? parentRaw : null;
    rows.push({
      id,
      parentId,
      running: summary.running === true,
      own: bucketsFromView(summary.projections?.values?.[PROJECTION_KEY]),
    });
  }
  return rows;
}

/**
 * Walk the lineage under `rootId`, breadth-first, and emit one node per
 * session: the root at depth 0, then its descendants.
 *
 * Bounds are enforced while expanding rather than after the fact, so a cycle
 * or a pathological store costs a bounded amount of work:
 * - `visited` makes a cycle terminate and marks the result truncated;
 * - `LINEAGE_MAX_DEPTH` stops descending past a fixed depth;
 * - `LINEAGE_MAX_NODES` caps the emitted array.
 *
 * Only sessions reachable from `rootId` are emitted, so an unknown id yields
 * an empty result rather than somebody else's tree.
 *
 * @param rootId - the requested session id.
 * @param rows - normalized rows from {@link lineageRows}.
 * @param exactRoot - optional `{ own, exact }` overriding the root's bucket.
 * @returns `{ nodes, truncated }`.
 */
export function buildLineage(rootId, rows, exactRoot) {
  const nodes = [];
  if (typeof rootId !== 'string' || rootId === '') return { nodes, truncated: false };

  const byId = new Map();
  const childrenOf = new Map();
  for (const row of rows) {
    // First occurrence wins: a duplicated summary must not create a second node.
    if (byId.has(row.id)) continue;
    byId.set(row.id, row);
    if (row.parentId !== null) {
      const siblings = childrenOf.get(row.parentId);
      if (siblings === undefined) childrenOf.set(row.parentId, [row.id]);
      else siblings.push(row.id);
    }
  }

  if (!byId.has(rootId)) return { nodes, truncated: false };

  const visited = new Set();
  let truncated = false;
  // Breadth-first so `depth` is the true shortest distance from the root and
  // the node order is stable.
  const queue = [{ id: rootId, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (visited.has(id)) {
      // Reachable twice: a cycle, or two summaries claiming the same id.
      truncated = true;
      continue;
    }
    visited.add(id);
    if (nodes.length >= LINEAGE_MAX_NODES) {
      truncated = true;
      break;
    }
    const row = byId.get(id);
    const isRoot = id === rootId;
    // The root is the only session whose attached projection this context can
    // read exactly; every other node uses the cached hint from `list()`.
    // `own` stays null when neither source produced a view — a missing
    // projection must never masquerade as "this session spent nothing".
    const fromRows = row?.own ?? null;
    if (isRoot && exactRoot !== undefined) {
      nodes.push({
        id,
        parentId: row?.parentId ?? null,
        depth,
        running: row?.running === true,
        own: exactRoot.own,
        exact: exactRoot.exact,
      });
    } else {
      nodes.push({
        id,
        parentId: row?.parentId ?? null,
        depth,
        running: row?.running === true,
        own: fromRows,
        // A cached hint proves the value exists, but it is not the exact read.
        exact: false,
      });
    }
    if (depth >= LINEAGE_MAX_DEPTH) {
      if ((childrenOf.get(id)?.length ?? 0) > 0) truncated = true;
      continue;
    }
    for (const child of childrenOf.get(id) ?? []) {
      if (visited.has(child)) truncated = true;
      else queue.push({ id: child, depth: depth + 1 });
    }
  }
  return { nodes, truncated };
}

/**
 * Read the root session's OWN buckets precisely.
 *
 * `sessionController.list()` reads attached sessions through
 * `sessionProjections.cachedSnapshot`, which is explicitly a lagging hint.
 * `snapshot()` materializes the cell first, so it is the exact value — and the
 * root is the one session we can always get exactly.
 *
 * @param sessions - the `ctx.sessions` registry (may be absent).
 * @param projections - the `ctx.sessionProjections` registry (may be absent).
 * @param rootId - the requested session id.
 * @returns `{ own, exact }`, or `undefined` when the exact read is unavailable.
 */
export function exactRootBuckets(sessions, projections, rootId) {
  try {
    const session = sessions?.get?.(rootId);
    if (session === undefined || session === null) return undefined;
    if (typeof projections?.snapshot !== 'function') return undefined;
    const snapshot = projections.snapshot(session, [PROJECTION_KEY]);
    const view = snapshot?.values?.[PROJECTION_KEY];
    if (view === undefined) return undefined;
    return { own: bucketsFromView(view), exact: true };
  } catch {
    // Any failure here degrades to the cached value; it must never fail the route.
    return undefined;
  }
}

/**
 * Build the `GET /api/sapi-budget/lineage` payload.
 *
 * @param deps - `{ service, list, sessions, projections }`; `list` is the
 *   bound `sessionController.list`.
 * @param requested - the raw `?session=` value.
 * @returns the lineage payload, including the shared catalog fields.
 */
export async function lineagePayload(deps, requested) {
  const sessionId = typeof requested === 'string' ? requested : '';
  const catalog = deps.service.statePayload('');
  // Catalog fields are shared with /state verbatim; `requestedGroup` and
  // `group`/`models`/`groups` are not part of this payload.
  const base = {
    ok: true,
    root: '',
    nodes: [],
    truncated: false,
    // Echo exactly what the route received. If `?session=` is mangled on the
    // way in, this is the field that shows it instead of leaving us guessing.
    requested: sessionId,
    baseUrl: catalog.baseUrl,
    currency: catalog.currency,
    quotaPerUnit: catalog.quotaPerUnit,
    usdExchangeRate: catalog.usdExchangeRate,
    fetchedAt: catalog.fetchedAt,
    stale: catalog.stale,
    error: catalog.error,
  };
  // Every early return below names itself in `reason`.
  //
  // An empty `nodes` array is NOT one fact, it is four: no session requested,
  // no controller bound, the store threw, or the id is not in the store. All
  // four used to serialize identically, so a real deployment answering
  // `{ root: "", nodes: [] }` could not be diagnosed from the wire at all —
  // the Client just fell back to "this session only" and the subagent money
  // disappeared without a trace. `reason` makes each branch falsifiable.
  if (sessionId === '') return { ...base, reason: 'no-session' };
  if (typeof deps.list !== 'function') return { ...base, reason: 'no-controller' };

  let summaries;
  try {
    summaries = await deps.list();
  } catch (error) {
    // An unreadable store means "no lineage", never a 500 — but it must still
    // say so rather than impersonating an empty tree.
    return {
      ...base,
      reason: 'list-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const rows = lineageRows(summaries);
  const exactRoot = exactRootBuckets(deps.sessions, deps.projections, sessionId);
  const { nodes, truncated } = buildLineage(sessionId, rows, exactRoot);
  if (nodes.length === 0) {
    // `summaries` proves `list()` ran and carries the count AFTER unwrapping the
    // remote envelope, so "the store answered but not with our id" is
    // distinguishable from "the store answered with nothing at all".
    return {
      ...base,
      reason: rows.length === 0 ? 'list-empty' : 'not-in-store',
      summaries: rows.length,
    };
  }
  return { ...base, root: sessionId, nodes, truncated };
}

// ───────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────

/**
 * Probe the lineage data path when it came back empty.
 *
 * Field evidence: the route answered `reason: 'not-in-store'` with
 * `summaries: 0` in a real GUI, yet ~560 session directories exist on disk. So
 * `list()` ran and resolved to nothing, and the wire could not say which hop in
 * `sessionController.list → sessionQuery.listSessions → persistence.list`
 * dropped the rows. This probe asks each hop separately so the next report is a
 * fact rather than a hypothesis.
 *
 * Read-only by construction: it only lists, and it swallows every error into
 * the payload. A diagnostic must never be able to fail the route it explains.
 *
 * @param get - service lookup on this plugin's context.
 * @param list - the bound `sessionController.list`, when one exists.
 * @returns a plain, JSON-safe report of each hop.
 */
/** The first raw row of a list result, envelope or bare array, or `{}`. */
function firstRowOf(rows) {
  if (Array.isArray(rows)) return isRecord(rows[0]) ? rows[0] : {};
  if (isRecord(rows) && Array.isArray(rows.items)) return isRecord(rows.items[0]) ? rows.items[0] : {};
  return {};
}

export async function diagnoseLineage(get, list) {
  const report = {};
  const shape = (value) => {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    return Array.isArray(value) ? `array(${value.length})` : typeof value === 'object' ? 'object' : typeof value;
  };
  try {
    const controller = get('sessionController');
    report.controller = shape(controller);
    report.hasList = typeof controller?.list === 'function';
    const query = get('sessionQuery');
    report.sessionQuery = shape(query);
    const persistence = get('sessionPersistence');
    report.sessionPersistence = shape(persistence);
    const sessions = get('sessions');
    report.sessionsService = shape(sessions);
    if (typeof sessions?.list === 'function') report.attachedSessions = sessions.list().length;
    if (typeof list === 'function') {
      const rows = await list();
      // Report the raw shape AND the row count `lineageRows` actually gets, so
      // an envelope regression shows up as `listRows: "object"` next to
      // `listRowsUnwrapped: 562` instead of as an unexplained empty tree.
      report.listRows = Array.isArray(rows) ? rows.length : shape(rows);
      const unwrapped = lineageRows(rows);
      report.listRowsUnwrapped = unwrapped.length;
      // A sample proves the shape reached us, and whether `sessionId` /
      // `parentSessionId` survived the sandbox proxy intact.
      if (unwrapped.length > 0) report.listSampleKeys = Object.keys(firstRowOf(rows)).sort();
    }
    if (typeof query?.listSessions === 'function') {
      const records = await query.listSessions();
      report.listSessionsRows = Array.isArray(records) ? records.length : shape(records);
      if (Array.isArray(records) && records.length > 0) {
        const withCwd = records.filter((record) => record?.header?.cwd !== undefined).length;
        report.listSessionsWithCwd = withCwd;
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return report;
}

const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

/** A JSON `Response`; the Connection channel passes it straight through. */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Read `?group=` off a route request without letting a malformed URL throw. */
export function groupFromRequest(request, fallback = '') {
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get('group');
    if (typeof raw === 'string' && raw !== '') return raw;
  } catch {
    // A hand-made Request stub may carry no parseable URL; fall back.
  }
  return fallback;
}

/** Read `?session=` off a route request, defensively. */
export function sessionFromRequest(request) {
  try {
    const raw = new URL(request.url).searchParams.get('session');
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * Register the routes on the Connection Fetch registry.
 *
 * The registering context is the injected child, so unloading this plugin (or
 * HMR) removes the routes instead of colliding on the next mount.
 *
 * @param ctx - plugin context; the caller supplies the injected child.
 * @param service - catalog service.
 * @param lineage - `{ sessions, projections }` used by the lineage route; both
 *   may be absent, in which case the route still answers with cached values.
 */
export function registerRoutes(ctx, service, lineage = {}) {
  const register = ctx.connection?.fetch?.register;
  if (typeof register !== 'function') return;
  ctx.effect(
    () =>
      register({
        path: STATE_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const group = groupFromRequest(request, service.group);
          service.group = group;
          await service.ensure();
          return jsonResponse(200, service.statePayload(group));
        },
      }),
    'sapi-budget: state route',
  );
  ctx.effect(
    () =>
      register({
        path: REFRESH_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const group = groupFromRequest(request, service.group);
          service.group = group;
          await service.refresh();
          return jsonResponse(200, service.statePayload(group));
        },
      }),
    'sapi-budget: refresh route',
  );
  ctx.effect(
    () =>
      register({
        path: LINEAGE_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          // `sessionController` is optional (an older host has none), and the
          // lookup is read per request so a late-arriving service is picked up.
          const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : (name) => ctx[name];
          const controller = get('sessionController');
          const list = typeof controller?.list === 'function' ? () => controller.list() : undefined;
          const payload = await lineagePayload(
            { service, list, sessions: lineage.sessions, projections: lineage.projections },
            sessionFromRequest(request),
          );
          if (payload.reason !== undefined) payload.diagnosis = await diagnoseLineage(get, list);
          return jsonResponse(200, payload);
        },
      }),
    'sapi-budget: lineage route',
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Plugin entry
// ───────────────────────────────────────────────────────────────────────────

/**
 * Mount the host half.
 *
 * Every capability is registered through an optional `ctx.inject`, so a
 * profile without `tools`, `connection`, or `sessionProjections` still runs
 * the parts it does have instead of failing activation.
 *
 * @param ctx - Cordis context.
 * @param config - raw plugin config (already validated by {@link Config}).
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('sapi-budget') : undefined;
  const service = createCatalogService(options, logger);

  // Warm the catalog once, then keep it warm. The timer is unref'd so it never
  // holds the host process open, and the disposer is the effect's return.
  ctx.effect(() => {
    service.refresh().catch(() => {});
    if (options.refreshMinutes <= 0) {
      return () => service.dispose();
    }
    const timer = setInterval(() => {
      service.refresh().catch(() => {});
    }, options.refreshMinutes * 60_000);
    timer?.unref?.();
    return () => {
      clearInterval(timer);
      service.dispose();
    };
  }, 'sapi-budget: catalog refresh');

  ctx.inject(['connection'], (cctx) => {
    // `sessions` and `sessionProjections` are read here only for the lineage
    // route's exact root reading; both stay optional.
    registerRoutes(cctx, service, {
      sessions: typeof cctx.get === 'function' ? cctx.get('sessions') : cctx.sessions,
      projections: typeof cctx.get === 'function' ? cctx.get('sessionProjections') : cctx.sessionProjections,
    });
  });

  ctx.inject(['tools'], (cctx) => {
    if (typeof cctx.tools?.register !== 'function') return;
    const definition = priceToolDefinition(service);
    cctx.effect(() => cctx.tools.register(definition), 'sapi-budget: sapi_price tool');
  });

  ctx.inject(['sessionProjections'], (cctx) => {
    if (typeof cctx.sessionProjections?.register !== 'function') return;
    const definition = sapiCostDefinition();
    cctx.effect(() => cctx.sessionProjections.register(definition), 'sapi-budget: sapiCost projection');
  });
}

export default apply;
