/**
 * Pricing math for AiSpot (new-api) providers.
 *
 * The provider publishes everything this module needs over public endpoints:
 *   GET /api/pricing       → model ratios, completion/cache multipliers, group ratios
 *   GET /api/status        → quota_per_unit (quota per USD) and the display exchange rate
 *   GET /api/user/groups   → per-group effective ratio and description
 *
 * Two billing shapes exist:
 *   1. ratio billing  — quota = tokens × model_ratio × group_ratio, and
 *      `quota_per_unit` quota is one USD. Cache/completion tokens are the
 *      uncached input price scaled by completion_ratio / cache_ratio /
 *      create_cache_ratio.
 *   2. expression billing (`billing_mode: "tiered_expr"`) — `billing_expr` is
 *      evaluated per request; its coefficients are USD per 1M tokens and its
 *      result is multiplied by the group ratio.
 *
 * Expression evaluation never uses `eval`/`new Function`: `parseExpression`
 * builds an AST from a small grammar and `evaluateExpression` walks it.
 */

const DEFAULT_BASE_URL = 'https://aispot.swj0227.icu';

/** @returns {{ name: string, args: unknown[] }} */
const call = (name, args) => ({ kind: 'call', name, args });
const num = (value) => ({ kind: 'number', value });
const ref = (name) => ({ kind: 'variable', name });
const binary = (operator, left, right) => ({ kind: 'binary', operator, left, right });
const unary = (operator, operand) => ({ kind: 'unary', operator, operand });
const conditional = (test, consequent, alternate) => ({ kind: 'conditional', test, consequent, alternate });

const EXPRESSION_VARIABLES = Object.freeze(['p', 'c', 'cr', 'cc', 'cc1h', 'img', 'len']);
const EXPRESSION_FUNCTIONS = Object.freeze(['tier', 'max', 'min', 'ceil', 'floor', 'abs', 'round']);

class ExpressionError extends Error {}

/**
 * Tokenize a billing expression. Only the operators and identifiers the
 * provider's own tiered expressions use are accepted; anything else is a
 * syntax error rather than an attempt to execute provider-supplied text.
 * @param source - raw `billing_expr`.
 * @returns a flat token list.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let end = index;
      while (end < source.length && /[0-9._]/.test(source[end])) end += 1;
      tokens.push({ type: 'number', value: Number(source.slice(index, end).replace(/_/g, '')) });
      index = end;
      continue;
    }
    if ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_') {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      tokens.push({ type: 'identifier', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let end = index + 1;
      while (end < source.length && source[end] !== quote) end += 1;
      if (end >= source.length) throw new ExpressionError('unterminated string literal');
      tokens.push({ type: 'string', value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    const three = source.slice(index, index + 3);
    const two = source.slice(index, index + 2);
    if (three === '===' || three === '!==') {
      tokens.push({ type: 'operator', value: three });
      index += 3;
      continue;
    }
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '&&' || two === '||') {
      tokens.push({ type: 'operator', value: two });
      index += 2;
      continue;
    }
    if ('+-*/%()?:,<>!'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      index += 1;
      continue;
    }
    throw new ExpressionError(`unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ type: 'end', value: '' });
  return tokens;
}

const BINARY_PRECEDENCE = new Map([
  ['||', 1],
  ['&&', 2],
  ['==', 3],
  ['!=', 3],
  ['===', 3],
  ['!==', 3],
  ['<', 4],
  ['<=', 4],
  ['>', 4],
  ['>=', 4],
  ['+', 5],
  ['-', 5],
  ['*', 6],
  ['/', 6],
  ['%', 6],
]);

/**
 * Recursive-descent parser for the provider's expression grammar.
 * @param source - raw `billing_expr`.
 * @returns the expression AST.
 */
function parseExpression(source) {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (value) => {
    const token = next();
    if (token.type !== 'operator' || token.value !== value) {
      throw new ExpressionError(`expected ${JSON.stringify(value)}`);
    }
    return token;
  };

  function parsePrimary() {
    const token = next();
    if (token.type === 'number') return num(token.value);
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'identifier') {
      if (peek().type === 'operator' && peek().value === '(') {
        next();
        const args = [];
        if (!(peek().type === 'operator' && peek().value === ')')) {
          for (;;) {
            args.push(parseConditional());
            if (peek().type === 'operator' && peek().value === ',') {
              next();
              continue;
            }
            break;
          }
        }
        expect(')');
        if (!EXPRESSION_FUNCTIONS.includes(token.value)) {
          throw new ExpressionError(`unknown function ${JSON.stringify(token.value)}`);
        }
        return call(token.value, args);
      }
      if (token.value === 'true') return num(1);
      if (token.value === 'false') return num(0);
      return ref(token.value);
    }
    if (token.type === 'operator' && token.value === '(') {
      const inner = parseConditional();
      expect(')');
      return inner;
    }
    if (token.type === 'operator' && (token.value === '-' || token.value === '+' || token.value === '!')) {
      return unary(token.value, parseUnary());
    }
    throw new ExpressionError(`unexpected token ${JSON.stringify(token.value)}`);
  }

  function parseUnary() {
    const token = peek();
    if (token.type === 'operator' && (token.value === '-' || token.value === '+' || token.value === '!')) {
      next();
      return unary(token.value, parseUnary());
    }
    return parsePrimary();
  }

  function parseBinary(minimum) {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token.type !== 'operator') break;
      const precedence = BINARY_PRECEDENCE.get(token.value);
      if (precedence === undefined || precedence < minimum) break;
      next();
      const right = parseBinary(precedence + 1);
      left = binary(token.value, left, right);
    }
    return left;
  }

  function parseConditional() {
    const test = parseBinary(1);
    if (peek().type === 'operator' && peek().value === '?') {
      next();
      const consequent = parseConditional();
      expect(':');
      const alternate = parseConditional();
      return conditional(test, consequent, alternate);
    }
    return test;
  }

  const ast = parseConditional();
  if (peek().type !== 'end') throw new ExpressionError('trailing input in expression');
  return ast;
}

/**
 * Evaluate a parsed expression.
 * @param node - AST node from {@link parseExpression}.
 * @param variables - token counts per variable name (`len` is a raw count).
 * @returns the numeric value.
 */
function evaluateExpression(node, variables) {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'string':
      return node.value;
    case 'variable': {
      const value = variables[node.name];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ExpressionError(`unknown variable ${JSON.stringify(node.name)}`);
      }
      return value;
    }
    case 'unary': {
      const operand = Number(evaluateExpression(node.operand, variables));
      if (node.operator === '-') return -operand;
      if (node.operator === '+') return operand;
      return operand === 0 ? 1 : 0;
    }
    case 'binary': {
      if (node.operator === '&&' || node.operator === '||') {
        const left = Number(evaluateExpression(node.left, variables)) !== 0;
        if (node.operator === '&&') return left && Number(evaluateExpression(node.right, variables)) !== 0 ? 1 : 0;
        return left || Number(evaluateExpression(node.right, variables)) !== 0 ? 1 : 0;
      }
      const left = Number(evaluateExpression(node.left, variables));
      const right = Number(evaluateExpression(node.right, variables));
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? 0 : left / right;
        case '%':
          return right === 0 ? 0 : left % right;
        case '<':
          return left < right ? 1 : 0;
        case '<=':
          return left <= right ? 1 : 0;
        case '>':
          return left > right ? 1 : 0;
        case '>=':
          return left >= right ? 1 : 0;
        case '==':
        case '===':
          return left === right ? 1 : 0;
        case '!=':
        case '!==':
          return left !== right ? 1 : 0;
        default:
          throw new ExpressionError(`unknown operator ${JSON.stringify(node.operator)}`);
      }
    }
    case 'conditional':
      return Number(evaluateExpression(node.test, variables)) !== 0
        ? evaluateExpression(node.consequent, variables)
        : evaluateExpression(node.alternate, variables);
    case 'call': {
      const args = node.args;
      switch (node.name) {
        case 'tier':
          if (args.length < 2) throw new ExpressionError('tier() expects (name, expression)');
          return evaluateExpression(args[args.length - 1], variables);
        case 'max':
          return Math.max(...args.map((arg) => Number(evaluateExpression(arg, variables))));
        case 'min':
          return Math.min(...args.map((arg) => Number(evaluateExpression(arg, variables))));
        case 'ceil':
          return Math.ceil(Number(evaluateExpression(args[0], variables)));
        case 'floor':
          return Math.floor(Number(evaluateExpression(args[0], variables)));
        case 'abs':
          return Math.abs(Number(evaluateExpression(args[0], variables)));
        case 'round':
          return Math.round(Number(evaluateExpression(args[0], variables)));
        default:
          throw new ExpressionError(`unknown function ${JSON.stringify(node.name)}`);
      }
    }
    default:
      throw new ExpressionError(`unknown node ${JSON.stringify(node.kind)}`);
  }
}

/**
 * Collect every `len`-comparison threshold in an expression so per-token
 * coefficients can be probed on each side of them.
 * @param node - AST node.
 * @returns sorted unique numeric thresholds.
 */
function collectThresholds(node, found = new Set()) {
  if (node === null || typeof node !== 'object') return [...found].sort((a, b) => a - b);
  if (node.kind === 'binary' && ['<', '<=', '>', '>='].includes(node.operator)) {
    const sides = [node.left, node.right];
    for (let index = 0; index < 2; index += 1) {
      const variable = sides[index];
      const literal = sides[1 - index];
      if (variable.kind === 'variable' && literal.kind === 'number') found.add(literal.value);
    }
  }
  for (const key of ['left', 'right', 'test', 'consequent', 'alternate', 'operand']) {
    if (node[key] !== undefined) collectThresholds(node[key], found);
  }
  if (Array.isArray(node.args)) for (const arg of node.args) collectThresholds(arg, found);
  return [...found].sort((a, b) => a - b);
}

const ZERO_VARIABLES = Object.freeze({ p: 0, c: 0, cr: 0, cc: 0, cc1h: 0, img: 0, len: 0 });

/**
 * Probe an expression for the linear per-variable coefficients at one prompt
 * length. The token variables count millions of tokens (`gemini-3.5-flash`'s
 * `p * 1.5` is $1.5 per 1M input tokens), so probing one variable with the
 * value `1` reads its USD-per-1M-token coefficient directly.
 * @param ast - parsed expression.
 * @param length - the `len` used for branch selection.
 * @returns coefficients plus a linearity verdict.
 */
function probeCoefficients(ast, length) {
  const base = Number(evaluateExpression(ast, { ...ZERO_VARIABLES, len: length }));
  const coefficients = {};
  let linear = true;
  for (const name of EXPRESSION_VARIABLES) {
    if (name === 'len') continue;
    const alone = Number(evaluateExpression(ast, { ...ZERO_VARIABLES, [name]: 1, len: length }));
    coefficients[name] = alone;
  }
  const joint = Number(
    evaluateExpression(ast, { p: 1, c: 1, cr: 1, cc: 1, cc1h: 1, img: 1, len: length }),
  );
  let sum = 0;
  for (const name of EXPRESSION_VARIABLES) {
    if (name === 'len') continue;
    sum += coefficients[name];
  }
  if (Math.abs(sum + base - joint) > 1e-6 * Math.max(1, Math.abs(joint))) linear = false;
  return {
    base,
    linear,
    perMillion: {
      input: coefficients.p,
      output: coefficients.c,
      cacheRead: coefficients.cr,
      cacheWrite: coefficients.cc,
      cacheWrite1h: coefficients.cc1h,
    },
  };
}

/**
 * Build the tier table of a `tiered_expr` model: one entry per `len` regime.
 * @param source - raw `billing_expr`.
 * @returns tier rows, or `undefined` when the expression is unsupported.
 */
function buildTiers(source) {
  let ast;
  try {
    ast = parseExpression(source);
  } catch {
    return undefined;
  }
  const thresholds = collectThresholds(ast);
  const probes = [0];
  for (const threshold of thresholds) {
    probes.push(Math.max(0, threshold - 1), threshold, threshold + 1);
  }
  probes.push(Number.MAX_SAFE_INTEGER / 4);
  const rows = [];
  try {
    for (const length of probes) {
      const probe = probeCoefficients(ast, length);
      if (!probe.linear) return undefined;
      const previous = rows[rows.length - 1];
      if (previous !== undefined && sameCoefficients(previous, probe)) continue;
      rows.push({ minLength: length, ...probe });
    }
  } catch {
    return undefined;
  }
  return rows;
}

function sameCoefficients(left, right) {
  // The constant term is part of the price of one request, so two probes that
  // differ only in a base fee are still different tiers.
  if (Math.abs((left.base ?? 0) - (right.base ?? 0)) >= 1e-9) return false;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h'];
  return keys.every((key) => Math.abs((left.perMillion[key] ?? 0) - (right.perMillion[key] ?? 0)) < 1e-9);
}

/**
 * Fractional price for one request under expression billing.
 * @param tiers - rows from {@link buildTiers}.
 * @param tokens - token counts of the request.
 * @returns USD, or `undefined` when no tier matches.
 */
export function expressionCost(tiers, tokens) {
  if (tiers === undefined || tiers.length === 0) return undefined;
  const length = (tokens.inputTokens ?? 0) + (tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0);
  let chosen = tiers[0];
  for (const row of tiers) {
    if (length >= row.minLength) chosen = row;
  }
  const price = chosen.perMillion;
  // The constant term of one tier is a per-request fee; token terms are priced
  // per million tokens. Every model on the live provider has a zero base, but a
  // hand-written `0.5 + p * 1` expression would otherwise lose its 0.5.
  return (
    (chosen.base ?? 0) +
    ((tokens.inputTokens ?? 0) * price.input +
      (tokens.outputTokens ?? 0) * price.output +
      (tokens.cacheReadTokens ?? 0) * price.cacheRead +
      (tokens.cacheWriteTokens ?? 0) * (price.cacheWrite || price.input)) /
      1e6
  );
}

/**
 * Human-readable per-1M-token rates of a tier row.
 * @param row - tier row from {@link buildTiers}.
 * @returns the four rates.
 */
export function tierRates(row) {
  return {
    input: row.perMillion.input,
    output: row.perMillion.output,
    cacheRead: row.perMillion.cacheRead,
    cacheWrite: row.perMillion.cacheWrite || row.perMillion.input,
  };
}

/** Guard: is this a plain JSON object? */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Coerce an unknown value to a finite number. */
const toNumber = (value, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * Normalize one provider model row into the plugin's internal shape.
 * @param raw - one entry of `/api/pricing` `data`.
 * @param groups - group ratios keyed by group name.
 * @returns the model descriptor, or `undefined` when unusable.
 */
function normalizeModel(raw, groups) {
  if (!isRecord(raw) || typeof raw.model_name !== 'string' || raw.model_name === '') return undefined;
  const ratio = toNumber(raw.model_ratio);
  const quotaType = toNumber(raw.quota_type);
  const tiers = typeof raw.billing_expr === 'string' && raw.billing_expr !== '' ? buildTiers(raw.billing_expr) : undefined;
  const kind = quotaType === 1 ? 'fixed' : tiers !== undefined ? 'tiered' : 'ratio';
  const enabled = Array.isArray(raw.enable_groups) ? raw.enable_groups.filter((name) => typeof name === 'string') : [];
  const createCacheRatio = typeof raw.create_cache_ratio === 'number' ? raw.create_cache_ratio : undefined;
  return {
    name: raw.model_name,
    kind,
    vendorId: toNumber(raw.vendor_id),
    ratio,
    completionRatio: toNumber(raw.completion_ratio, 1),
    cacheRatio: toNumber(raw.cache_ratio, 1),
    createCacheRatio,
    modelPrice: toNumber(raw.model_price),
    quotaType,
    groups: enabled.length > 0 ? enabled : Object.keys(groups),
    tiers,
    expression: typeof raw.billing_expr === 'string' ? raw.billing_expr : undefined,
  };
}

/**
 * USD price of 1M uncached input tokens for one model in one group.
 * @param model - normalized model.
 * @param groupRatio - the group's effective ratio.
 * @param quotaPerUnit - provider quota per USD.
 * @returns USD per 1M tokens, or `undefined` for fixed-price models.
 */
function inputPricePerMillion(model, groupRatio, quotaPerUnit) {
  if (model.kind === 'fixed') return undefined;
  if (model.kind === 'tiered') {
    const row = model.tiers[0];
    return row === undefined ? undefined : row.perMillion.input * groupRatio;
  }
  return (model.ratio * groupRatio * 1e6) / quotaPerUnit;
}

/**
 * A snapshot of the provider's catalog plus the derived prices of one group.
 */
export class PricingSnapshot {
  constructor({ baseUrl, fetchedAt, status, pricing, groupRatios, models }) {
    this.baseUrl = baseUrl;
    this.fetchedAt = fetchedAt;
    this.systemName = typeof status.system_name === 'string' ? status.system_name : undefined;
    this.quotaPerUnit = toNumber(status.quota_per_unit, 500000) || 500000;
    this.usdExchangeRate = toNumber(status.usd_exchange_rate, toNumber(status.price, 1)) || 1;
    this.currency = typeof status.quota_display_type === 'string' ? status.quota_display_type : 'USD';
    this.pricingVersion = typeof pricing.pricing_version === 'string' ? pricing.pricing_version : undefined;
    this.groupRatios = groupRatios;
    this.models = models;
  }

  /** Every group the provider currently exposes, cheapest ratio first. */
  groups() {
    return Object.entries(this.groupRatios)
      .map(([name, ratio]) => ({ name, ratio }))
      .sort((left, right) => left.ratio - right.ratio || left.name.localeCompare(right.name));
  }

  /** Resolve a requested group name to an existing one. */
  resolveGroup(requested) {
    const names = new Set(Object.keys(this.groupRatios));
    if (typeof requested === 'string' && names.has(requested)) return requested;
    return names.has('default') ? 'default' : (this.groups()[0]?.name ?? 'default');
  }

  /** Models available in one group, each with the rates of that group. */
  modelsInGroup(groupName) {
    const groupRatio = toNumber(this.groupRatios[groupName], 1);
    const rows = [];
    for (const model of this.models.values()) {
      if (!model.groups.includes(groupName)) continue;
      rows.push(this.describeModel(model, groupName, groupRatio));
    }
    rows.sort((left, right) => left.name.localeCompare(right.name));
    return rows;
  }

  /** One model's client-facing descriptor in one group. */
  describeModel(model, groupName, groupRatio = toNumber(this.groupRatios[groupName], 1)) {
    const input = inputPricePerMillion(model, groupRatio, this.quotaPerUnit);
    const base = {
      name: model.name,
      kind: model.kind,
      group: groupName,
      vendorId: model.vendorId,
      ratio: model.ratio,
      groupRatio,
    };
    if (model.kind === 'fixed') {
      return { ...base, perRequest: model.modelPrice * groupRatio };
    }
    if (model.kind === 'tiered') {
      return {
        ...base,
        expression: model.expression,
        tiers: (model.tiers ?? []).map((row) => ({ minLength: row.minLength, ...tierRates(row), base: row.base })),
      };
    }
    const inputPerMillion = input ?? 0;
    return {
      ...base,
      input: inputPerMillion,
      output: inputPerMillion * model.completionRatio,
      cacheRead: inputPerMillion * model.cacheRatio,
      cacheWrite: inputPerMillion * (model.createCacheRatio ?? 1),
    };
  }

  /**
   * USD cost of one settled model call.
   * @param modelName - provider model id from the session log.
   * @param groupName - group to bill against.
   * @param tokens - token counts of the call.
   * @returns cost in USD plus whether it is an estimate.
   */
  costOf(modelName, groupName, tokens) {
    const model = this.models.get(modelName);
    if (model === undefined) return undefined;
    const groupRatio = toNumber(this.groupRatios[this.resolveGroup(groupName)], 1);
    if (model.kind === 'fixed') {
      return { usd: model.modelPrice * groupRatio, estimated: false, kind: 'fixed' };
    }
    if (model.kind === 'tiered') {
      const tiers = (model.tiers ?? []).map((row) => ({
        minLength: row.minLength,
        base: row.base,
        perMillion: {
          input: row.perMillion.input * groupRatio,
          output: row.perMillion.output * groupRatio,
          cacheRead: row.perMillion.cacheRead * groupRatio,
          cacheWrite: row.perMillion.cacheWrite * groupRatio,
        },
      }));
      const usd = expressionCost(tiers, tokens);
      if (usd === undefined) return undefined;
      return { usd, estimated: true, kind: 'tiered' };
    }
    const input = (model.ratio * groupRatio * 1e6) / this.quotaPerUnit;
    const usd =
      ((tokens.inputTokens ?? 0) * input +
        (tokens.outputTokens ?? 0) * input * model.completionRatio +
        (tokens.cacheReadTokens ?? 0) * input * model.cacheRatio +
        (tokens.cacheWriteTokens ?? 0) * input * (model.createCacheRatio ?? 1)) /
      1e6;
    return { usd, estimated: false, kind: 'ratio' };
  }
}

/** Fetch JSON with a timeout; throws on a non-2xx status. */
async function getJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return await response.json();
}

/**
 * Fetch and normalize the provider catalog. All three endpoints are public, so
 * no API key is required and none is read from the environment.
 * @param baseUrl - provider root, without a trailing slash.
 * @param timeoutMs - per-request timeout.
 * @returns a fresh {@link PricingSnapshot}.
 */
export async function fetchCatalog(baseUrl, timeoutMs = 15000) {
  const root = String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const [pricing, status, groups] = await Promise.all([
    getJson(`${root}/api/pricing`, timeoutMs),
    getJson(`${root}/api/status`, timeoutMs),
    getJson(`${root}/api/user/groups`, timeoutMs).catch(() => ({ data: {} })),
  ]);
  const groupRatios = {};
  if (isRecord(pricing.group_ratio)) {
    for (const [name, ratio] of Object.entries(pricing.group_ratio)) groupRatios[name] = toNumber(ratio, 1);
  }
  if (isRecord(groups?.data)) {
    for (const [name, entry] of Object.entries(groups.data)) {
      if (isRecord(entry) && (groupRatios[name] === undefined || toNumber(entry.ratio, 1) !== groupRatios[name])) {
        groupRatios[name] = toNumber(entry.ratio, groupRatios[name] ?? 1);
      }
    }
  }
  const models = new Map();
  const rows = Array.isArray(pricing.data) ? pricing.data : [];
  for (const raw of rows) {
    const model = normalizeModel(raw, groupRatios);
    if (model !== undefined) models.set(model.name, model);
  }
  return new PricingSnapshot({ baseUrl: root, fetchedAt: Date.now(), status: status?.data ?? status ?? {}, pricing, groupRatios, models });
}

export { DEFAULT_BASE_URL, parseExpression, evaluateExpression, buildTiers };
