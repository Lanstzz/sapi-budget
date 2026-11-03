/**
 * sapi-budget — browser half.
 *
 * Two contributions, both scoped to the active Session:
 *
 *   conversation.chat.turnTail            per-Turn spend, before the action row
 *   conversation.session.header.utilities session spend + group picker
 *
 * The Host half publishes token buckets in the `sapiCost` projection; it never
 * publishes money. Prices arrive separately from the Host's `api/sapi-budget/*`
 * routes, so switching groups reprices the whole session without touching the
 * session log.
 *
 * Only `react` and `react/jsx-runtime` may be required: the module loader runs
 * this factory on the boot path with nothing between it and the shell, and a
 * Harness Client package imported here would take the whole app down when its
 * exports drift. Styles therefore use the shared `--dsw-alias-*` theme tokens
 * and nothing else — no literal colours, no host class names.
 */
window.__ModuleLoader__.load({
  id: '@local/sapi-budget/client',
  factory: (require) => {
    const module = { exports: {} };

    const React = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** Locale namespace registered by this file and named by each slot entry. */
    const NS = 'sapi-budget';
    /** Host routes, written relative so they resolve under any mount prefix. */
    const STATE_PATH = 'api/sapi-budget/state';
    const REFRESH_PATH = 'api/sapi-budget/refresh';
    /**
     * Session-lineage route. A subagent runs in its OWN session log, so this
     * session's `sapiCost` projection can never see what its children spent.
     * The Host walks `header.parentSession` and returns one `own` token bucket
     * per descendant; the Client sums the subtree itself.
     */
    const LINEAGE_PATH = 'api/sapi-budget/lineage';
    /** Where the chosen group survives a reload. */
    const GROUP_STORAGE_KEY = 'sapi-budget.group';
    /** Projection key the Host half publishes. */
    const PROJECTION_KEY = 'sapiCost';
    /** Poll interval used when the Host does not report its own refreshMinutes. */
    const DEFAULT_POLL_MINUTES = 5;
    /** Slot cell ids. A fresh id sits beside the shipped entries instead of replacing one. */
    const TURN_SLOT_ID = 'sapi-budget-turn-cost';
    const SESSION_SLOT_ID = 'sapi-budget-session-cost';

    // ── dictionaries ────────────────────────────────────────────────────────
    // Flat dotted keys, exactly the keys of locale/zh.json + locale/en.json
    // minus the `meta` block, which the Host manifest consumes, not the browser.
    const zh = {
      'turnCost.unknown': '价格未知',
      'turnCost.pending': '计价中',
      'turnCost.approx': '估算',
      'turnCost.title': '本轮费用',
      'sessionCost.label': '会话费用',
      'sessionCost.empty': '暂无用量',
      'sessionCost.estimated': '包含估算项',
      'sessionCost.withChildren': '含子代理',
      'sessionCost.children': '子代理 {count} 个',
      'lineage.own': '自身',
      'lineage.subtree': '含下游',
      'lineage.running': '运行中',
      'lineage.depth': '层级 {depth}',
      'lineage.none': '没有子代理',
      'group.label': '分组',
      'group.select': '选择当前分组',
      'group.auto': '自动（最便宜）',
      'group.refresh': '刷新价格',
      'group.refreshing': '刷新中…',
      'group.current': '当前分组：{name}',
      'group.ratio': '倍率 {ratio}',
      'group.source': '数据来源：{url}',
      'detail.input': '输入',
      'detail.output': '输出',
      'detail.cacheRead': '缓存读取',
      'detail.cacheWrite': '缓存写入',
      'detail.requests': '请求数',
      'detail.model': '模型',
      'detail.group': '分组',
      'detail.total': '合计',
      'detail.unit': '单价 / 百万 tokens',
      'detail.perRequest': '每次请求',
      'detail.updated': '价格更新于 {time}',
      'error.unreachable': '无法连接价格服务',
      'error.noModels': '该分组没有可用模型',
    };
    const en = {
      'turnCost.unknown': 'Price unknown',
      'turnCost.pending': 'Pricing…',
      'turnCost.approx': 'estimate',
      'turnCost.title': 'Turn cost',
      'sessionCost.label': 'Session cost',
      'sessionCost.empty': 'No usage yet',
      'sessionCost.estimated': 'Includes estimates',
      'sessionCost.withChildren': 'incl. subagents',
      'sessionCost.children': '{count} subagent(s)',
      'lineage.own': 'own',
      'lineage.subtree': 'incl. downstream',
      'lineage.running': 'running',
      'lineage.depth': 'depth {depth}',
      'lineage.none': 'no subagents',
      'group.label': 'Group',
      'group.select': 'Select current group',
      'group.auto': 'Auto (cheapest)',
      'group.refresh': 'Refresh prices',
      'group.refreshing': 'Refreshing…',
      'group.current': 'Current group: {name}',
      'group.ratio': 'ratio {ratio}',
      'group.source': 'Source: {url}',
      'detail.input': 'Input',
      'detail.output': 'Output',
      'detail.cacheRead': 'Cache read',
      'detail.cacheWrite': 'Cache write',
      'detail.requests': 'Requests',
      'detail.model': 'Model',
      'detail.group': 'Group',
      'detail.total': 'Total',
      'detail.unit': 'Price / 1M tokens',
      'detail.perRequest': 'Per request',
      'detail.updated': 'Prices updated {time}',
      'error.unreachable': 'Cannot reach the pricing service',
      'error.noModels': 'No models available in this group',
    };
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    /** Translate against the inline copy; used only when no locale seat is injected. */
    function fallbackTranslate(key, params) {
      const template = hasOwn(zh, key) ? zh[key] : hasOwn(en, key) ? en[key] : key;
      if (params === undefined || params === null) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name) => (hasOwn(params, name) ? String(params[name]) : whole));
    }

    /** The slot's locale seat, or the inline dictionary when the host gave none. */
    function translatorOf(props) {
      return props !== null && typeof props === 'object' && typeof props.t === 'function' ? props.t : fallbackTranslate;
    }

    // ── numbers and money ───────────────────────────────────────────────────
    /** Coerce an unknown value to a finite number; NaN must never reach the DOM. */
    function finiteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }

    const CURRENCY_SYMBOLS = Object.freeze({
      USD: '$',
      CNY: '¥',
      RMB: '¥',
      EUR: '€',
      GBP: '£',
      JPY: '¥',
      KRW: '₩',
      HKD: 'HK$',
      TWD: 'NT$',
      CAD: 'C$',
      AUD: 'A$',
      SGD: 'S$',
    });

    /** Currency symbol prefix; an unknown code falls back to the code itself. */
    function currencySymbol(currency) {
      const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
      if (code === '') return CURRENCY_SYMBOLS.USD;
      return hasOwn(CURRENCY_SYMBOLS, code) ? CURRENCY_SYMBOLS[code] : `${code} `;
    }

    /**
     * Format an amount for display: four decimals below one cent, otherwise two.
     * @param usd - amount in the snapshot currency.
     * @param currency - ISO code of the snapshot currency.
     * @returns the display string, or `undefined` when the amount is not a number.
     */
    function formatMoney(usd, currency) {
      if (typeof usd !== 'number' || !Number.isFinite(usd)) return undefined;
      const amount = Math.abs(usd) < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
      return currencySymbol(currency) + amount;
    }

    /** Index a model descriptor list by name; the first row wins on duplicates. */
    function indexModels(models) {
      const index = new Map();
      if (!Array.isArray(models)) return index;
      for (const model of models) {
        if (model === null || typeof model !== 'object') continue;
        if (typeof model.name !== 'string' || model.name === '') continue;
        if (!index.has(model.name)) index.set(model.name, model);
      }
      return index;
    }

    /**
     * Pick the tier whose `minLength` is the largest one not exceeding the
     * request length. An expression with no matching branch has no price.
     * @param tiers - `describeModel` tier rows of a `tiered` model.
     * @param totalTokens - prompt-side tokens the expression branches on.
     * @returns the matching tier row, or `undefined`.
     */
    function selectTier(tiers, totalTokens) {
      if (!Array.isArray(tiers) || tiers.length === 0) return undefined;
      const length = finiteNumber(totalTokens);
      let chosen;
      let best = -Infinity;
      for (const tier of tiers) {
        if (tier === null || typeof tier !== 'object') continue;
        const minLength = finiteNumber(tier.minLength);
        if (minLength > length || minLength <= best) continue;
        best = minLength;
        chosen = tier;
      }
      return chosen;
    }

    /**
     * Price one model bucket against one `describeModel` descriptor.
     *
     * A descriptor's rates are USD per 1M tokens for the group the snapshot was
     * taken in, but only the `ratio` and `fixed` shapes have already had the
     * group ratio applied upstream: an expression's tier coefficients are the
     * provider's raw per-1M numbers. The tier rates are therefore scaled by
     * `groupRatio` here, mirroring what the Host's own `costOf()` does — the
     * two must agree or the same usage would cost two different amounts
     * depending on which half did the arithmetic.
     *
     * @param model - the descriptor, or `undefined` when the model is unknown.
     * @param bucket - `{ input, output, cacheRead, cacheWrite, requests }`.
     * @returns `{ usd, estimated, kind }`, or `undefined` when it cannot be priced.
     */
    function costOfBucket(model, bucket) {
      if (model === null || typeof model !== 'object') return undefined;
      const tokens = bucket !== null && typeof bucket === 'object' ? bucket : {};
      const input = finiteNumber(tokens.input);
      const output = finiteNumber(tokens.output);
      const cacheRead = finiteNumber(tokens.cacheRead);
      const cacheWrite = finiteNumber(tokens.cacheWrite);
      const requests = finiteNumber(tokens.requests);
      if (model.kind === 'fixed') {
        // Per-request billing: the bucket aggregates a whole turn, which is why
        // the result is an estimate rather than a settled invoice line.
        return { usd: finiteNumber(model.perRequest) * requests, estimated: true, kind: 'fixed' };
      }
      if (model.kind === 'tiered') {
        const scale = groupScaleOf(model);
        const tier = selectTier(model.tiers, input + output + cacheRead + cacheWrite);
        if (tier === undefined) return undefined;
        const tokenCost =
          (input * finiteNumber(tier.input) +
            output * finiteNumber(tier.output) +
            cacheRead * finiteNumber(tier.cacheRead) +
            cacheWrite * finiteNumber(tier.cacheWrite)) /
          1e6;
        // A tier's `base` is the constant term of one request's price.
        return { usd: (tokenCost + finiteNumber(tier.base)) * scale, estimated: true, kind: 'tiered' };
      }
      if (model.kind !== 'ratio') return undefined;
      const usd =
        (input * finiteNumber(model.input) +
          output * finiteNumber(model.output) +
          cacheRead * finiteNumber(model.cacheRead) +
          cacheWrite * finiteNumber(model.cacheWrite)) /
        1e6;
      return { usd, estimated: false, kind: 'ratio' };
    }

    /**
     * The group ratio to apply on top of a descriptor's raw tier rates.
     * A payload without one is treated as already scaled (ratio 1).
     */
    function groupScaleOf(model) {
      const ratio = finiteNumber(model.groupRatio);
      return ratio > 0 ? ratio : 1;
    }

    /** The token buckets of one projection row, or an empty list. */
    function bucketsOf(row) {
      if (row === null || typeof row !== 'object') return [];
      return Array.isArray(row.models) ? row.models.filter((bucket) => bucket !== null && typeof bucket === 'object') : [];
    }

    /**
     * Price a list of model buckets and keep the rows a tooltip wants.
     * @param index - model descriptors by name, from {@link indexModels}.
     * @param buckets - projection model buckets.
     * @returns `undefined` for an empty list, otherwise the totals plus whether
     *   anything could not be priced (`unresolved` means no row was priced at all).
     */
    function summarizeBuckets(index, buckets) {
      const rows = [];
      if (!Array.isArray(buckets) || buckets.length === 0) return undefined;
      let usd = 0;
      let priced = 0;
      let unknown = 0;
      let estimated = false;
      for (const bucket of buckets) {
        if (bucket === null || typeof bucket !== 'object') continue;
        const name = typeof bucket.model === 'string' ? bucket.model : '';
        const model = name === '' ? undefined : index.get(name);
        const cost = costOfBucket(model, bucket);
        if (cost === undefined) {
          unknown += 1;
          rows.push({ model: name, unresolved: true, tokens: bucket });
          continue;
        }
        priced += 1;
        usd += cost.usd;
        if (cost.estimated) estimated = true;
        rows.push({ model: name, usd: cost.usd, estimated: cost.estimated, kind: cost.kind, unresolved: false, tokens: bucket });
      }
      if (priced === 0) return { usd: 0, estimated: false, priced: 0, unknown, rows, unresolved: true, empty: false };
      return { usd, estimated, priced, unknown, rows, unresolved: false, empty: false };
    }

    /** Price one Turn of the projection. */
    function summarizeTurn(projection, turnNumber, index) {
      if (projection === null || typeof projection !== 'object') return undefined;
      const turns = Array.isArray(projection.turns) ? projection.turns : [];
      const row = turns.find((entry) => entry !== null && typeof entry === 'object' && entry.turn === turnNumber);
      if (row === undefined) return undefined;
      return summarizeBuckets(index, bucketsOf(row));
    }

    /**
     * Price every Turn of the projection and add them up.
     *
     * Each Turn is priced on its own so a `tiered` model picks its tier from
     * that Turn's own length; flattening the whole session into one bucket list
     * would push every Turn into the top tier.
     */
    function summarizeSession(projection, index) {
      if (projection === null || typeof projection !== 'object') return undefined;
      const turns = Array.isArray(projection.turns) ? projection.turns : [];
      let usd = 0;
      let priced = 0;
      let unknown = 0;
      let estimated = false;
      let sawBucket = false;
      const rows = [];
      for (const turn of turns) {
        if (turn === null || typeof turn !== 'object') continue;
        const buckets = bucketsOf(turn);
        if (buckets.length === 0) continue;
        sawBucket = true;
        const summary = summarizeBuckets(index, buckets);
        if (summary === undefined) continue;
        usd += summary.usd;
        priced += summary.priced;
        unknown += summary.unknown;
        if (summary.estimated) estimated = true;
        for (const row of summary.rows) rows.push(row);
      }
      if (!sawBucket) return { usd: 0, estimated: false, priced: 0, unknown: 0, rows: [], unresolved: false, empty: true };
      return { usd, estimated, priced, unknown, rows, unresolved: priced === 0, empty: false };
    }

    // ── session lineage ─────────────────────────────────────────────────────
    // A subagent runs in its own session log, so this session's projection can
    // never see what it spent. The Host's lineage route hands back one `own`
    // bucket per session in the tree; everything below turns that flat node
    // list into the subtree totals the header shows.

    /** An all-zero token bucket. */
    function zeroBucket() {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    }

    /** Copy the five published token fields off any object, defaulting to zero. */
    function normalizeBucket(source) {
      const value = source !== null && typeof source === 'object' ? source : {};
      return {
        input: finiteNumber(value.input),
        output: finiteNumber(value.output),
        cacheRead: finiteNumber(value.cacheRead),
        cacheWrite: finiteNumber(value.cacheWrite),
        requests: finiteNumber(value.requests),
      };
    }

    /** Add two token buckets without mutating either. */
    function addBucket(left, right) {
      const a = normalizeBucket(left);
      const b = normalizeBucket(right);
      return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        requests: a.requests + b.requests,
      };
    }

    /** Is this bucket all zeros? */
    function isZeroBucket(bucket) {
      const value = normalizeBucket(bucket);
      return value.input === 0 && value.output === 0 && value.cacheRead === 0 && value.cacheWrite === 0 && value.requests === 0;
    }

    /**
     * Normalize the lineage wire payload.
     *
     * Every field is re-typed rather than trusted: this is a network payload,
     * and a malformed row must cost one node, never the whole header.
     *
     * **Unknown vs zero is the important distinction here.** The `sapiCost`
     * projection only starts recording once this plugin is installed, so a
     * subagent session from before that has no readable rows. "We could not read
     * it" must never become "$0.00": real money was spent and we simply do not
     * know how much. The route marks that case and this function preserves it
     * instead of coercing to a zero bucket:
     *
     *   - `own: null` (or absent) — the explicit signal, kept as `null`;
     *   - `exact: false` together with an all-zero bucket — the same situation
     *     in the older payload shape, where an unreadable cache entry was
     *     emitted as zeroes. A session that actually ran cannot have spent
     *     exactly zero on all five counters, so this is read as unknown too.
     *
     * The root is exempt from the second rule: its projection comes from
     * `useProjection` and is authoritative even when the route says `exact:false`.
     *
     * @returns `{ ok, root, truncated, nodes, currency, error }` with `nodes`
     *   holding only well-formed rows; each node's `own` is a bucket or `null`,
     *   and `known` says which.
     */
    function normalizeLineage(payload) {
      const source = payload !== null && typeof payload === 'object' ? payload : {};
      const nodes = [];
      const seen = new Set();
      if (Array.isArray(source.nodes)) {
        for (const raw of source.nodes) {
          if (raw === null || typeof raw !== 'object') continue;
          if (typeof raw.id !== 'string' || raw.id === '') continue;
          // A duplicated id would double-count in the subtree sum and could
          // fabricate a cycle; the first row wins.
          if (seen.has(raw.id)) continue;
          seen.add(raw.id);
          const hasBucket = raw.own !== null && raw.own !== undefined && typeof raw.own === 'object';
          const bucket = hasBucket ? normalizeBucket(raw.own) : null;
          // An all-zero bucket on a non-exact read is the unreadable case (see
          // the doc comment); it is not a session that genuinely spent nothing.
          const zeroOnInexact = bucket !== null && raw.exact !== true && isZeroBucket(bucket);
          const own = bucket === null || zeroOnInexact ? null : bucket;
          nodes.push({
            id: raw.id,
            parentId: typeof raw.parentId === 'string' && raw.parentId !== '' ? raw.parentId : null,
            depth: finiteNumber(raw.depth),
            running: raw.running === true,
            own,
            exact: raw.exact === true,
            // `own === null` is the one way to say "price unknown" downstream.
            known: own !== null,
          });
        }
      }
      return {
        ok: source.ok !== false,
        root: typeof source.root === 'string' ? source.root : '',
        truncated: source.truncated === true,
        nodes,
        currency: typeof source.currency === 'string' && source.currency !== '' ? source.currency : 'USD',
        error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
      };
    }

    /**
     * Sum a session's subtree: `subtree(s) = own(s) + Σ subtree(child)`.
     *
     * Children are keyed by `parentId`, so the Host never has to compute a
     * subtree and the two halves cannot disagree about the formula. Two guards
     * matter in practice:
     *
     *   - **Cycles.** `parentSessionId` is data on disk; a corrupt or
     *     hand-edited entry can point back down the tree. A `visited` set makes
     *     each id contribute at most once, so a cycle terminates.
     *   - **Dangling parents.** A node whose `parentId` names an id absent from
     *     the list is simply not reachable from the root and contributes
     *     nothing — it must not throw.
     *   - **Unknown buckets.** A node whose `own` is `null` spent an unknown
     *     amount. It is summed as zero so the known sessions still total up,
     *     but it is reported in `unknownIds` — the caller must surface that
     *     rather than pretend the subtree is fully priced.
     *
     * @param nodes - normalized lineage nodes (see {@link normalizeLineage}).
     * @param rootId - the session whose subtree to sum.
     * @returns `{ buckets, ids, count, unknownIds, knownCount }` where `count`
     *   excludes the root itself and `unknownIds` lists unpriced sessions.
     */
    function subtreeBuckets(nodes, rootId) {
      const result = { buckets: zeroBucket(), ids: [], count: 0, unknownIds: [], knownCount: 0 };
      if (!Array.isArray(nodes) || typeof rootId !== 'string' || rootId === '') return result;

      const byParent = new Map();
      let rootNode;
      for (const node of nodes) {
        if (node === null || typeof node !== 'object') continue;
        if (node.id === rootId && rootNode === undefined) {
          rootNode = node;
          continue;
        }
        const parent = typeof node.parentId === 'string' ? node.parentId : '';
        if (parent === '') continue;
        const siblings = byParent.get(parent);
        if (siblings === undefined) byParent.set(parent, [node]);
        else siblings.push(node);
      }
      if (rootNode === undefined) return result;

      /** Is this node's spend actually known? `own === null` means it is not. */
      const isKnown = (node) => node.own !== null && node.own !== undefined && typeof node.own === 'object';

      const visited = new Set([rootId]);
      let buckets = isKnown(rootNode) ? normalizeBucket(rootNode.own) : zeroBucket();
      const ids = [];
      const unknownIds = [];
      let knownCount = isKnown(rootNode) ? 1 : 0;
      if (!isKnown(rootNode)) unknownIds.push(rootId);

      // Iterative depth-first walk: a deep tree must not be able to blow the
      // stack, and `visited` keeps a cycle finite.
      const stack = [rootId];
      while (stack.length > 0) {
        const current = stack.pop();
        for (const child of byParent.get(current) ?? []) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          if (isKnown(child)) {
            buckets = addBucket(buckets, child.own);
            knownCount += 1;
          } else {
            unknownIds.push(child.id);
          }
          ids.push(child.id);
          stack.push(child.id);
        }
      }
      // Root's bucket is included in `buckets`; `count` counts descendants only.
      return { buckets, ids, count: ids.length, unknownIds, knownCount };
    }

    /**
     * The models the root session actually used, most recent Turn first.
     *
     * The lineage route publishes token buckets but no per-session model, so a
     * descendant's spend has to be priced against a model the Client can see.
     * The root's own projection is the only such source.
     */
    function rootModelNames(projection) {
      const names = [];
      if (projection === null || typeof projection !== 'object') return names;
      const turns = Array.isArray(projection.turns) ? projection.turns : [];
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        for (const bucket of bucketsOf(turns[index])) {
          if (typeof bucket.model === 'string' && bucket.model !== '' && !names.includes(bucket.model)) names.push(bucket.model);
        }
      }
      return names;
    }

    /**
     * Price one lineage node's OWN bucket.
     *
     * PRICING RULE (fixed by the task contract — deliberately not improvised):
     * the lineage route publishes token buckets but no model breakdown, because
     * a session's model attribution is not available across session logs on the
     * Host side. So:
     *
     *   - the ROOT node is priced exactly, from its own `sapiCost` projection —
     *     the same `summarizeSession` / `costOfBucket` path the header already
     *     used, so its number is unchanged by this feature;
     *   - every DESCENDANT is estimated by applying the root session's most
     *     recent model price to that child's token bucket. This is a deliberate
     *     accuracy trade-off, not a bug: a subagent is often routed to a
     *     different (cheaper or dearer) model, and the Client cannot know that.
     *     Such rows are flagged `estimated` so the tooltip can say so.
     *   - when not even the root's model can be resolved, the row is
     *     `unresolved` and renders `turnCost.unknown`. It is never silently
     *     treated as zero and never produces NaN.
     *   - a node the route could not read (`own === null`) is `unresolved`
     *     regardless of the model: the token count itself is missing.
     *
     * @returns `{ usd, estimated, unresolved, empty, rows }`.
     */
    function priceLineageNode({ node, isRoot, projection, index, fallbackModel }) {
      const bucket = node !== null && typeof node === 'object' ? node.own : undefined;
      const hasBucket = bucket !== null && bucket !== undefined && typeof bucket === 'object';
      const own = hasBucket ? normalizeBucket(bucket) : null;

      if (isRoot) {
        // The root's OWN projection is authoritative and always visible here,
        // so it outranks the lineage bucket — which may legitimately be zero
        // (a cold or not-yet-cached session) while the live projection already
        // has rows. Checking `own` first would print $0 for a session that
        // demonstrably spent money.
        const summary = summarizeSession(projection, index);
        if (summary !== undefined && summary.empty !== true) {
          return { usd: summary.unresolved ? 0 : summary.usd, estimated: summary.estimated, unresolved: summary.unresolved === true, empty: false, rows: summary.rows };
        }
        // No projection: fall through and price the Host's bucket as an estimate.
      }

      // No usable bucket at all: the route could not read this session. Report
      // "unknown" — never zero, because real money was spent.
      if (own === null) return { usd: 0, estimated: false, unresolved: true, unknown: true, empty: false, rows: [] };

      if (isZeroBucket(own)) {
        return { usd: 0, estimated: false, unresolved: false, empty: true, rows: [] };
      }

      const model = fallbackModel === undefined ? undefined : index.get(fallbackModel);
      const cost = costOfBucket(model, own);
      if (cost === undefined) return { usd: 0, estimated: false, unresolved: true, empty: false, rows: [] };
      return {
        usd: cost.usd,
        // Descendants are always estimates, even on exact-billing models: the
        // token count is right but the model attribution is assumed.
        estimated: true,
        unresolved: false,
        empty: false,
        rows: [{ model: fallbackModel, usd: cost.usd, estimated: true, kind: cost.kind, unresolved: false, tokens: own }],
      };
    }

    /**
     * Build the whole priced lineage for one session, or `undefined` when there
     * is nothing to show.
     *
     * Returns the header's own number (`total`) plus a per-session breakdown for
     * the tooltip, so the component stays a pure formatter.
     *
     * ## Currency of a partially-known tree
     *
     * The `sapiCost` projection only starts recording once this plugin is
     * installed, so a subagent that ran BEFORE that has no readable rows. The
     * chosen policy is (a) from the task contract: the total sums what IS
     * known, and the UI says the rest is unknown. Silently folding an unknown
     * session in as `0` would understate a bill, and refusing to show any total
     * would throw away the part that is genuinely reliable.
     *
     * `unknownChildren` is therefore the signal the header uses to show
     * `turnCost.unknown` beside the total instead of implying it is complete.
     *
     * @returns `{ total, own, children, rows, truncated, hasChildren,
     *   unknownChildren, allUnknown, estimated, unresolved }`.
     */
    function summarizeLineage({ lineage, rootId, projection, index }) {
      const nodes = lineage !== null && typeof lineage === 'object' && Array.isArray(lineage.nodes) ? lineage.nodes : [];
      const root = rootId !== '' ? nodes.find((node) => node.id === rootId) : undefined;
      if (root === undefined) return undefined;

      const modelNames = rootModelNames(projection);
      const fallbackModel = modelNames.length > 0 ? modelNames[0] : undefined;

      // Resolve each session's own price once, then sum along the tree.
      const priced = new Map();
      for (const node of nodes) {
        priced.set(node.id, priceLineageNode({ node, isRoot: node.id === rootId, projection, index, fallbackModel }));
      }

      const subtree = subtreeBuckets(nodes, rootId);
      const own = priced.get(rootId) ?? { usd: 0, estimated: false, unresolved: false, empty: true, rows: [] };

      // Subtree money is the sum of every reachable session's own price. Adding
      // per-session USD (rather than pricing one merged bucket) keeps each
      // session's tier choice and estimate flag intact.
      let total = 0;
      let anyEstimated = own.estimated;
      const rows = [];
      const reachable = [rootId, ...subtree.ids];
      for (const id of reachable) {
        const node = nodes.find((entry) => entry.id === id);
        if (node === undefined) continue;
        const price = priced.get(id) ?? { usd: 0, estimated: false, unresolved: true, empty: true, rows: [] };
        if (!price.unresolved) total += price.usd;
        if (price.estimated) anyEstimated = true;
        rows.push({ node, price, isRoot: id === rootId });
      }

      // Descendants we could not price at all. They are excluded from `total`,
      // so the header must say the tree is partially unknown rather than
      // presenting the sum as complete.
      const descendantRows = rows.filter((row) => row.isRoot !== true);
      const unknownRows = descendantRows.filter((row) => row.price.unresolved);
      const unknownChildren = unknownRows.length;
      const allUnknown = descendantRows.length > 0 && unknownChildren === descendantRows.length;

      return {
        total,
        own,
        // The token line must describe the same usage the money came from. The
        // root's price is projected from its live `sapiCost` rows, so sum those;
        // the lineage bucket is only the fallback when no projection exists.
        ownBucket: own.rows.length > 0 ? own.rows.reduce((sum, row) => addBucket(sum, row.tokens), zeroBucket()) : normalizeBucket(root.own),
        children: subtree.count,
        rows,
        truncated: lineage.truncated === true,
        hasChildren: subtree.count > 0,
        estimated: anyEstimated,
        unknownChildren,
        allUnknown,
        // "Unknown" only when NOTHING in the tree could be priced; a tree with
        // some priced sessions still shows their money.
        unresolved: rows.length > 0 && rows.every((row) => row.price.unresolved),
      };
    }

    /**
     * Defensive Turn-number read: the owner hands over a TurnLocation, but a
     * slot contract can shift under us, so accept the coordinate shapes too.
     */
    function turnNumberOf(props) {
      if (props === null || typeof props !== 'object') return undefined;
      const location = props.turn;
      if (typeof location === 'number') return Number.isFinite(location) ? location : undefined;
      if (location === null || typeof location !== 'object') return undefined;
      if (typeof location.turn === 'number') return location.turn;
      const coordinates = location.locationCoordinates !== undefined ? location.locationCoordinates : location.coordinates;
      if (coordinates !== null && typeof coordinates === 'object' && typeof coordinates.turn === 'number') return coordinates.turn;
      const nested = location.location;
      if (nested !== null && typeof nested === 'object' && typeof nested.turn === 'number') return nested.turn;
      return undefined;
    }

    // ── catalog store (shared, module-level) ────────────────────────────────
    /** A Host that predates the exact-route registry answers 404. */
    class RoutesUnavailable extends Error {
      constructor(path) {
        super(`${path} is not served by this host`);
        this.name = 'RoutesUnavailable';
      }
    }

    /** Call one Host route; a 404 means the host does not serve them at all. */
    async function callRoute(path, init) {
      if (typeof fetch !== 'function') throw new RoutesUnavailable(path);
      const response = await fetch(path, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...init,
      });
      if (response.status === 404) throw new RoutesUnavailable(path);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body !== null && typeof body === 'object' && body.error) || `HTTP ${response.status}`);
      return body;
    }

    /** Describe a failure without letting a non-Error reach the state. */
    function describeError(error) {
      if (error instanceof RoutesUnavailable) return 'unavailable';
      if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
      return String(error);
    }

    /** Normalize one wire payload so every consumer reads the same shape. */
    function normalizeState(payload) {
      const source = payload !== null && typeof payload === 'object' ? payload : {};
      const groups = [];
      if (Array.isArray(source.groups)) {
        for (const row of source.groups) {
          if (row === null || typeof row !== 'object') continue;
          if (typeof row.name !== 'string' || row.name === '') continue;
          groups.push({ name: row.name, ratio: finiteNumber(row.ratio) });
        }
      }
      const models = [];
      if (Array.isArray(source.models)) {
        for (const row of source.models) {
          if (row === null || typeof row !== 'object') continue;
          if (typeof row.name !== 'string' || row.name === '') continue;
          models.push(row);
        }
      }
      const refreshMinutes = finiteNumber(source.refreshMinutes);
      return {
        ok: source.ok !== false,
        baseUrl: typeof source.baseUrl === 'string' ? source.baseUrl : '',
        group: typeof source.group === 'string' ? source.group : '',
        requestedGroup: typeof source.requestedGroup === 'string' ? source.requestedGroup : '',
        groups,
        models,
        quotaPerUnit: finiteNumber(source.quotaPerUnit),
        usdExchangeRate: finiteNumber(source.usdExchangeRate),
        currency: typeof source.currency === 'string' && source.currency !== '' ? source.currency : 'USD',
        fetchedAt: finiteNumber(source.fetchedAt),
        stale: source.stale === true,
        error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
        refreshMinutes: refreshMinutes > 0 ? refreshMinutes : undefined,
      };
    }

    function readStoredGroup() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return '';
        const value = localStorage.getItem(GROUP_STORAGE_KEY);
        return typeof value === 'string' ? value : '';
      } catch (error) {
        // A blocked storage area (private mode, disabled cookies) is not fatal.
        return '';
      }
    }

    function writeStoredGroup(name) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return;
        if (name === '') localStorage.removeItem(GROUP_STORAGE_KEY);
        else localStorage.setItem(GROUP_STORAGE_KEY, name);
      } catch (error) {
        // Persisting the choice is a convenience; keep the in-memory one.
      }
    }

    /** Format the snapshot's `fetchedAt` for a tooltip. */
    function formatTimestamp(value) {
      const ms = finiteNumber(value);
      if (ms <= 0) return undefined;
      try {
        return new Date(ms).toLocaleTimeString();
      } catch (error) {
        return undefined;
      }
    }

    /**
     * The shared price catalog: one snapshot, one refresh timer, one request in
     * flight. Components attach while mounted and detach on unmount; the last
     * detach stops the timer but keeps the snapshot so a remount paints at once.
     */
    function createCatalogStore() {
      let state = {
        phase: 'idle',
        data: null,
        error: null,
        group: '',
        loading: false,
        unreachable: false,
        // Lineage is per-session and fetched alongside the catalog. `null` means
        // "not asked yet / unavailable"; the header then falls back to this
        // session's own number.
        lineage: null,
        lineageSession: '',
        lineageUnavailable: false,
      };
      const listeners = new Set();
      let mounted = 0;
      let timer = null;
      let sequence = 0;
      let lineageSequence = 0;
      let restored = false;

      function notify() {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error) {
            console.warn('[sapi-budget] catalog subscriber failed:', error);
          }
        }
      }

      function commit(patch) {
        state = Object.assign({}, state, patch);
        notify();
      }

      function clearTimer() {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
      }

      function schedule() {
        clearTimer();
        if (mounted <= 0) return;
        const minutes = state.data !== null && state.data.refreshMinutes !== undefined ? state.data.refreshMinutes : DEFAULT_POLL_MINUTES;
        const delay = Math.max(30, minutes * 60) * 1000;
        if (typeof setTimeout !== 'function') return;
        timer = setTimeout(() => {
          timer = null;
          void load('timer');
        }, delay);
      }

      /**
       * Take one wire payload as the new snapshot.
       *
       * `state.group` is the USER'S choice and the payload's `group` is the
       * RESOLVED one — adopting the resolved name here would turn "auto" into a
       * permanent pin on whichever group happened to be cheapest on the first
       * refresh, and it would also fight `setGroup('')`. The user's choice wins;
       * the resolved name is only a display detail carried on `data.group`.
       */
      function accept(payload) {
        const data = normalizeState(payload);
        commit({
          phase: 'ready',
          data,
          error: data.error,
          loading: false,
          unreachable: false,
        });
        schedule();
      }

      function statePath() {
        if (state.group === '') return STATE_PATH;
        return `${STATE_PATH}?group=${encodeURIComponent(state.group)}`;
      }

      async function load(reason) {
        const token = ++sequence;
        commit({ loading: true, error: null });
        try {
          const payload = await callRoute(statePath());
          if (token !== sequence) return;
          accept(payload);
        } catch (error) {
          if (token !== sequence) return;
          // A failed refresh keeps the old snapshot on screen: a stale price is
          // worth more than a blank header.
          commit({
            phase: state.data === null ? 'error' : 'stale',
            loading: false,
            error: describeError(error),
            unreachable: error instanceof RoutesUnavailable,
          });
          schedule();
        }
      }

      /**
       * Fetch this session's lineage tree.
       *
       * Failure is NORMAL and must stay quiet: a Host older than the lineage
       * route answers 404, and any other error may be transient. Either way the
       * header keeps showing this session's own total, so the worst outcome is
       * "the number is what it used to be", never a blank or a NaN.
       */
      async function loadLineage(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') {
          commit({ lineage: null, lineageSession: '', lineageUnavailable: true });
          return;
        }
        const token = ++lineageSequence;
        try {
          const payload = await callRoute(`${LINEAGE_PATH}?session=${encodeURIComponent(sessionId)}`);
          if (token !== lineageSequence) return;
          commit({
            lineage: normalizeLineage(payload),
            lineageSession: sessionId,
            lineageUnavailable: false,
          });
        } catch (error) {
          if (token !== lineageSequence) return;
          // Drop any tree from a DIFFERENT session: showing one session's
          // children under another session's header would be worse than
          // showing none.
          commit({
            lineage: state.lineageSession === sessionId ? state.lineage : null,
            lineageSession: sessionId,
            lineageUnavailable: true,
          });
        }
      }

      async function refresh() {
        const token = ++sequence;
        commit({ loading: true, error: null });
        try {
          const payload = await callRoute(REFRESH_PATH, { method: 'POST' });
          if (token !== sequence) return;
          accept(payload);
        } catch (error) {
          if (token !== sequence) return;
          if (error instanceof RoutesUnavailable) {
            await load('refresh-fallback');
            return;
          }
          commit({
            phase: state.data === null ? 'error' : 'stale',
            loading: false,
            error: describeError(error),
            unreachable: false,
          });
          schedule();
        }
      }

      function start() {
        if (!restored) {
          restored = true;
          const stored = readStoredGroup();
          if (stored !== '' && stored !== state.group) commit({ group: stored });
        }
        if (state.data === null) void load('mount');
        else schedule();
      }

      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        getSnapshot() {
          return state;
        },
        /**
         * The route the next load would call. Exposed because "auto" is only
         * real if it actually drops the `?group=` parameter: the Host's
         * `resolveGroup('')` then falls back to the cheapest group.
         */
        statePath() {
          return statePath();
        },
        /** Mount one consumer; the returned function detaches it. */
        attach() {
          mounted += 1;
          if (mounted === 1) start();
          return () => {
            mounted -= 1;
            if (mounted > 0) return;
            mounted = 0;
            clearTimer();
          };
        },
        /** Adopt a wire payload (also the seam the unit tests seed through). */
        accept(payload) {
          accept(payload);
        },
        /** Adopt a lineage payload directly (test seam; the route path uses loadLineage). */
        acceptLineage(payload, sessionId) {
          commit({
            lineage: payload === null ? null : normalizeLineage(payload),
            lineageSession: typeof sessionId === 'string' ? sessionId : state.lineageSession,
            lineageUnavailable: payload === null,
          });
        },
        /** Fetch the tree for one session; safe to call on every render tick. */
        loadLineage(sessionId) {
          void loadLineage(sessionId);
        },
        /** Whether the Host answered the lineage route at all. */
        lineagePath(sessionId) {
          return `${LINEAGE_PATH}?session=${encodeURIComponent(typeof sessionId === 'string' ? sessionId : '')}`;
        },
        /** Switch the billed group and re-ask the Host for that group's prices. */
        setGroup(name) {
          const next = typeof name === 'string' ? name : '';
          writeStoredGroup(next);
          if (next === state.group) return;
          // Keep the current snapshot so the numbers stay on screen; the reply
          // replaces it as soon as the Host answers for the new group.
          commit({ group: next });
          void load('group');
        },
        refresh() {
          void refresh();
        },
      };
    }

    const catalog = createCatalogStore();

    /** Subscribe to the shared catalog and keep it warm while mounted. */
    function useCatalog() {
      const snapshot = React.useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot);
      React.useEffect(catalog.attach, []);
      return snapshot;
    }

    /** Read one projection, tolerating a Host that does not publish it. */
    function readProjection(props, key) {
      const useProjection = props !== null && typeof props === 'object' ? props.useProjection : undefined;
      if (typeof useProjection !== 'function') return undefined;
      try {
        return useProjection(key);
      } catch (error) {
        console.warn(`[sapi-budget] projection "${key}" is unavailable:`, error);
        return undefined;
      }
    }

    // ── styles (theme tokens only) ──────────────────────────────────────────
    const styles = {
      row: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', minWidth: 0, whiteSpace: 'nowrap' },
      root: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none', minWidth: 0 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flex: 'none',
        minHeight: 22,
        padding: '0 6px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'none',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        fontVariantNumeric: 'tabular-nums',
      },
      label: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' },
      value: {
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: '18px',
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
      },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: '18px' },
      mark: { color: 'var(--dsw-alias-label-dimmed)', fontSize: 11, lineHeight: '18px' },
      // The breakdown bubble. A child of its trigger rather than a portal: the
      // chat body is a scroll container, so a `position: fixed` bubble would
      // either escape with the scroll or need portal plumbing we cannot depend
      // on (`document.body` writes are off limits for slot plugins). Absolute
      // positioning inside the trigger keeps the bubble in the same stacking and
      // scroll context as the chip it describes.
      anchor: { position: 'relative', display: 'inline-flex', alignItems: 'center', flex: 'none' },
      tooltip: {
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        zIndex: 40,
        // `display` is intentionally absent: the `hidden` attribute must stay
        // authoritative. An inline `display` here would override the UA rule
        // `[hidden] { display: none }` and leave the bubble permanently visible.
        flexDirection: 'column',
        gap: 2,
        minWidth: 180,
        maxWidth: 'min(60vw, 420px)',
        padding: '6px 8px',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-tooltip-bg)',
        color: 'var(--dsw-static-neutral-bluish-00)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        textAlign: 'left',
        pointerEvents: 'none',
      },
      // The header chip sits at the right edge of the utilities row, so its
      // bubble grows leftwards; anchored at `left: 0` it would run off-screen.
      tooltipEnd: { left: 'auto', right: 0 },
      tooltipLine: { display: 'block' },
      select: {
        flex: 'none',
        maxWidth: 168,
        minWidth: 0,
        height: 24,
        padding: '0 6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        outline: 'none',
      },
      selectUnavailable: {
        flex: 'none',
        maxWidth: 168,
        height: 24,
        padding: '0 6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'none',
        color: 'var(--dsw-alias-label-dimmed)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'default',
      },
    };

    // ── tooltips ────────────────────────────────────────────────────────────
    /**
     * How long the pointer must rest before a breakdown appears.
     *
     * This mirrors the platform's own Tooltip (`delayMs` 200–500 there). The
     * delay is a *deliberate* resting period, not the multi-second stall a
     * native `title` produced: once it fires, the bubble is already built and
     * paints on the next frame.
     */
    const TOOLTIP_DELAY_MS = 300;

    /** Bumps once per mounted tooltip, so every bubble gets a unique `id`. */
    let tooltipSeq = 0;

    /**
     * Hover/focus state for one tooltip trigger.
     *
     * Returns `{ open, handlers, bubbleProps }`. The bubble is opened by a timer
     * so a pointer merely crossing the chip does not flash it; it closes at once
     * on leave, blur, Escape, or when the trigger is dismissed. Every pending
     * timer is cleared on unmount, so a component that disappears mid-delay does
     * not call `setState` afterwards.
     *
     * `useState` is read through `React` so the test harness's pass-through stub
     * still works: these tests assert the rendered tree, not React's scheduling.
     *
     * @param lines - breakdown lines, one per bubble row.
     */
    function useTooltip(lines) {
      const [open, setOpen] = React.useState(false);
      const timer = React.useMemo(() => ({ id: null }), []);
      // Stable per mounted component, so `aria-describedby` keeps pointing at
      // this trigger's own bubble across re-renders.
      const bubbleId = React.useMemo(() => `sapi-budget-tip-${tooltipSeq++}`, []);
      const hasLines = Array.isArray(lines) && lines.length > 0;

      const clear = React.useCallback(() => {
        if (timer.id === null) return;
        clearTimeout(timer.id);
        timer.id = null;
      }, [timer]);

      const show = React.useCallback(() => {
        clear();
        if (!hasLines) return;
        timer.id = setTimeout(() => {
          timer.id = null;
          setOpen(true);
        }, TOOLTIP_DELAY_MS);
      }, [clear, hasLines, timer]);

      const hide = React.useCallback(() => {
        clear();
        setOpen(false);
      }, [clear]);

      React.useEffect(() => clear, [clear]);

      const dismissOnKey = React.useCallback(
        (event) => {
          const key = event !== null && typeof event === 'object' ? event.key : undefined;
          if (key === 'Escape') hide();
        },
        [hide],
      );

      return {
        open: open === true && hasLines,
        bubbleId,
        handlers: {
          onMouseEnter: show,
          onMouseLeave: hide,
          onFocus: show,
          onBlur: hide,
          onKeyDown: dismissOnKey,
        },
        bubbleProps: {
          id: bubbleId,
          role: 'tooltip',
          // `hidden` keeps the bubble out of the accessibility tree and out of
          // hit testing until it is actually shown.
          hidden: !(open === true && hasLines),
          style: styles.tooltip,
        },
      };
    }

    /**
     * The breakdown bubble: one child per line.
     *
     * Rendered as a sibling *inside* the trigger element so it inherits the
     * trigger's containing block. It carries `role="tooltip"` and is `hidden`
     * until the hover delay elapses.
     */
    function tooltipBubble(tooltip, lines, key, alignEnd = false) {
      const rows = Array.isArray(lines) ? lines : [];
      const base = alignEnd ? { ...styles.tooltip, ...styles.tooltipEnd } : styles.tooltip;
      // The layout property that makes the rows stack also decides visibility:
      // `hidden` alone cannot win against an inline `display`, so both live here.
      const style = tooltip.bubbleProps.hidden === true ? { ...base, display: 'none' } : { ...base, display: 'flex' };
      return jsxs(
        'span',
        {
          ...tooltip.bubbleProps,
          style,
          'data-sapi-budget': 'tooltip',
          children: rows.map((line, index) =>
            jsx('span', { style: styles.tooltipLine, children: line }, `line-${index}`),
          ),
        },
        key,
      );
    }

    /** One bucket line: `输入 12 · 输出 34 · …`. */
    function tokenLine(t, bucket) {
      const tokens = bucket !== null && typeof bucket === 'object' ? bucket : {};
      return [
        `${t('detail.input')} ${finiteNumber(tokens.input)}`,
        `${t('detail.output')} ${finiteNumber(tokens.output)}`,
        `${t('detail.cacheRead')} ${finiteNumber(tokens.cacheRead)}`,
        `${t('detail.cacheWrite')} ${finiteNumber(tokens.cacheWrite)}`,
        `${t('detail.requests')} ${finiteNumber(tokens.requests)}`,
      ].join(' · ');
    }

    /** Breakdown lines shared by both slots. */
    function breakdownLines(t, summary, data) {
      const lines = [];
      for (const row of summary.rows) {
        const name = row.model === '' || row.model === undefined ? t('turnCost.unknown') : row.model;
        const amount = row.unresolved ? t('turnCost.unknown') : formatMoney(row.usd, data.currency) || t('turnCost.unknown');
        lines.push(`${t('detail.model')} ${name} · ${amount}`);
        lines.push(tokenLine(t, row.tokens));
      }
      const total = formatMoney(summary.usd, data.currency) || t('turnCost.unknown');
      lines.push(`${t('detail.total')} ${total}`);
      return lines;
    }

    /** Format one lineage row's money, never returning NaN. */
    function rowMoney(t, price, data) {
      if (price.unresolved) return t('turnCost.unknown');
      return formatMoney(price.usd, data.currency) || t('turnCost.unknown');
    }

    /**
     * Layered tooltip: this session's own spend, the subtree total, then one
     * indented line per descendant.
     *
     * Depth is conveyed twice on purpose: `t('lineage.depth')` spells it out for
     * anyone reading the text, and leading spaces indent the row so the tree
     * shape is visible at a glance. Both are plain text in a `title` attribute,
     * which is the only rendering surface a tooltip gets here.
     */
    function lineageLines(t, summary, data) {
      const lines = [];
      lines.push(`${t('lineage.own')} ${rowMoney(t, summary.own, data)}`);
      // When EVERY descendant is unreadable the subtree number is just this
      // session again, so presenting it as "incl. downstream" would be a lie.
      if (summary.allUnknown) lines.push(`${t('lineage.subtree')} ${t('turnCost.unknown')}`);
      else lines.push(`${t('lineage.subtree')} ${formatMoney(summary.total, data.currency) || t('turnCost.unknown')}`);
      if (!isZeroBucket(summary.ownBucket)) lines.push(tokenLine(t, summary.ownBucket));

      const descendants = summary.rows.filter((row) => row.isRoot !== true);
      if (descendants.length === 0) {
        lines.push(t('lineage.none'));
        return lines;
      }
      for (const row of descendants) {
        // Clamp the indent so a deep tree cannot push the amount off-screen.
        const indent = '  '.repeat(Math.min(Math.max(row.node.depth, 1), 6));
        const parts = [`${indent}${row.node.id.slice(0, 8)}`, rowMoney(t, row.price, data)];
        parts.push(t('lineage.depth', { depth: row.node.depth }));
        if (row.node.running) parts.push(t('lineage.running'));
        // A descendant's money assumes the root's model price, so say so.
        if (row.price.estimated) parts.push(t('turnCost.approx'));
        lines.push(parts.join(' · '));
      }
      // A partial total must say so: the sum above deliberately omits these.
      // Composed from existing keys rather than a new one, so the dictionaries
      // stay exactly the shipped set.
      if (summary.unknownChildren > 0 && !summary.allUnknown) {
        lines.push(`${t('sessionCost.children', { count: summary.unknownChildren })} · ${t('turnCost.unknown')}`);
      }
      return lines;
    }

    // ── slot: per-Turn cost ─────────────────────────────────────────────────
    /**
     * One completed Turn's spend, rendered in the Turn tail before the actions.
     * Returns `null` whenever there is nothing to say, which is also what the
     * slot contract asks an empty contribution to do.
     */
    function TurnCostTail(props) {
      const t = translatorOf(props);
      const snapshot = useCatalog();
      const projection = readProjection(props, PROJECTION_KEY);
      const turnNumber = turnNumberOf(props);

      const data = snapshot.data;
      const summary = data === null || turnNumber === undefined ? undefined : summarizeTurn(projection, turnNumber, indexModels(data.models));

      // Everything the bubble could say, computed before any early return so the
      // hook below runs on every render. Hooks may not be called conditionally.
      const lines = React.useMemo(() => {
        if (data === null) {
          const failed = snapshot.phase === 'error';
          const text = failed ? t('turnCost.unknown') : t('turnCost.pending');
          return [failed ? `${t('turnCost.unknown')} · ${t('error.unreachable')}` : text];
        }
        if (summary === undefined) return [];
        if (summary.unresolved) {
          const unknown = t('turnCost.unknown');
          return [data.error !== null ? `${unknown} · ${t('error.unreachable')}` : unknown];
        }
        const rows = [t('turnCost.title')];
        if (data.group !== '') rows.push(t('group.current', { name: data.group }));
        rows.push(...breakdownLines(t, summary, data));
        if (summary.estimated) rows.push(t('turnCost.approx'));
        const updated = formatTimestamp(data.fetchedAt);
        if (updated !== undefined) rows.push(t('detail.updated', { time: updated }));
        return rows;
      }, [data, snapshot.phase, summary, t]);

      const tooltip = useTooltip(lines);

      if (turnNumber === undefined) return null;

      if (data === null) {
        // No catalog yet. Distinguish "still fetching" from "the price service
        // will never answer" — a permanent spinner reads as a broken plugin,
        // and a Host older than the route registry cannot fix itself.
        const failed = snapshot.phase === 'error';
        const text = failed ? t('turnCost.unknown') : t('turnCost.pending');
        return jsxs(
          'span',
          {
            'data-sapi-budget': 'turn',
            'data-sapi-budget-pending': failed ? undefined : '',
            style: styles.row,
            'aria-describedby': tooltip.bubbleId,
            ...tooltip.handlers,
            children: [
              jsx('span', { style: styles.label, children: t('turnCost.title') }, 'label'),
              jsx('span', { style: styles.muted, children: text }, 'value'),
              tooltipBubble(tooltip, lines, 'tooltip'),
            ],
          },
          'sapi-budget-turn',
        );
      }

      if (summary === undefined) return null;

      if (summary.unresolved) {
        const unknown = t('turnCost.unknown');
        return jsxs(
          'span',
          {
            'data-sapi-budget': 'turn',
            'data-sapi-budget-unresolved': '',
            style: styles.row,
            'aria-describedby': tooltip.bubbleId,
            ...tooltip.handlers,
            children: [
              jsx('span', { style: styles.label, children: t('turnCost.title') }, 'label'),
              jsx('span', { style: styles.muted, children: unknown }, 'value'),
              tooltipBubble(tooltip, lines, 'tooltip'),
            ],
          },
          'sapi-budget-turn',
        );
      }

      const money = formatMoney(summary.usd, data.currency);
      if (money === undefined) return null;

      return jsxs(
        'span',
        {
          'data-sapi-budget': 'turn',
          style: styles.row,
          'aria-describedby': tooltip.bubbleId,
          ...tooltip.handlers,
          children: [
            jsx('span', { style: styles.label, children: t('turnCost.title') }, 'label'),
            jsx('span', { style: styles.value, children: money }, 'value'),
            summary.estimated ? jsx('span', { style: styles.mark, children: t('turnCost.approx') }, 'approx') : null,
            summary.unknown > 0 ? jsx('span', { style: styles.mark, children: t('turnCost.unknown') }, 'unknown') : null,
            tooltipBubble(tooltip, lines, 'tooltip'),
          ],
        },
        'sapi-budget-turn',
      );
    }

    // ── slot: session cost + group picker ───────────────────────────────────
    /**
     * Session total and the group it is billed in, in the header utilities.
     *
     * The headline number is the session SUBTREE total — this session plus every
     * descendant subagent — because a subagent spends in its own session log and
     * would otherwise be invisible here. When the lineage route is unavailable
     * (an older Host answers 404, or the request fails) the number quietly falls
     * back to this session alone: the same number this chip showed before the
     * feature existed. It never blanks out and never shows NaN.
     */
    function SessionCostUtilities(props) {
      const t = translatorOf(props);
      const snapshot = useCatalog();
      const projection = readProjection(props, PROJECTION_KEY);
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';

      // Keep the tree fresh on the same cadence as the catalog, and re-ask when
      // the active session changes.
      React.useEffect(() => {
        if (sessionId === '') return undefined;
        catalog.loadLineage(sessionId);
        return undefined;
      }, [sessionId]);

      const data = snapshot.data;
      const index = data === null ? undefined : indexModels(data.models);
      // The session's own spend, exactly as this chip computed it before.
      const own = data === null ? undefined : summarizeSession(projection, index);

      // Prefer the lineage tree, but only when it belongs to THIS session.
      const lineage = snapshot.lineage !== null && snapshot.lineageSession === sessionId && index !== undefined
        ? summarizeLineage({ lineage: snapshot.lineage, rootId: sessionId, projection, index })
        : undefined;
      const subtree = lineage !== undefined && lineage.rows.length > 0 ? lineage : undefined;

      let value;
      if (data === null) {
        // Before the first answer the header has nothing to total. Say which of
        // the two states it is in rather than showing a permanent spinner.
        if (snapshot.phase === 'error') value = t('error.unreachable');
        else value = projection === undefined ? t('sessionCost.empty') : t('turnCost.pending');
      } else if (subtree !== undefined && subtree.allUnknown) {
        // Every descendant is unreadable. Showing the subtree sum here would
        // present this session's own money as the whole family's, so fall back
        // to the honest number and flag it.
        value = own === undefined || own.empty === true
          ? t('sessionCost.empty')
          : formatMoney(own.usd, data.currency) || t('turnCost.unknown');
      } else if (subtree !== undefined) {
        value = subtree.unresolved ? t('turnCost.unknown') : formatMoney(subtree.total, data.currency) || t('turnCost.unknown');
      } else if (own === undefined || own.empty === true) {
        value = t('sessionCost.empty');
      } else if (own.unresolved) {
        value = t('turnCost.unknown');
      } else {
        value = formatMoney(own.usd, data.currency) || t('turnCost.unknown');
      }

      const lines = [t('sessionCost.label'), value];
      if (data !== null) {
        if (data.group !== '') lines.push(t('group.current', { name: data.group }));
        if (subtree !== undefined) lines.push(...lineageLines(t, subtree, data));
        else if (own !== undefined && own.empty !== true) lines.push(...breakdownLines(t, own, data));
        if (subtree !== undefined && subtree.estimated) lines.push(t('sessionCost.estimated'));
        else if (subtree === undefined && own !== undefined && own.estimated) lines.push(t('sessionCost.estimated'));
        const updated = formatTimestamp(data.fetchedAt);
        if (updated !== undefined) lines.push(t('detail.updated', { time: updated }));
        if (data.baseUrl !== '') lines.push(t('group.source', { url: data.baseUrl }));
      }
      if (snapshot.unreachable) lines.push(t('error.unreachable'));
      else if (snapshot.error !== null) lines.push(snapshot.error);

      const busy = snapshot.loading === true;
      const showChildren = subtree !== undefined && subtree.hasChildren === true;
      // A subtree that includes or omits unpriced sessions must say so, or the
      // number reads as a complete total when it is not.
      const showUnknown = subtree !== undefined && (subtree.allUnknown === true || subtree.unknownChildren > 0);

      // The bubble content, resolved before the trigger element is built so the
      // hook order is stable across every branch above.
      const tooltip = useTooltip(lines);
      const chip = jsxs(
        'button',
        {
          type: 'button',
          'data-sapi-budget': 'session',
          'data-sapi-budget-lineage': showChildren ? 'subtree' : undefined,
          'data-sapi-budget-partial': showUnknown ? '' : undefined,
          'aria-busy': busy ? 'true' : undefined,
          'aria-label': busy ? t('group.refreshing') : t('group.refresh'),
          'aria-describedby': tooltip.bubbleId,
          style: styles.chip,
          ...tooltip.handlers,
          onClick: () => {
            catalog.refresh();
          },
          children: [
            jsx('span', { style: styles.label, children: t('sessionCost.label') }, 'label'),
            jsx('span', { style: data === null ? styles.muted : styles.value, children: value }, 'value'),
            // Only shown when there really are descendants, so a session with no
            // subagents renders exactly the chip it always did.
            showChildren ? jsx('span', { style: styles.mark, children: t('sessionCost.children', { count: subtree.children }) }, 'children') : null,
            showUnknown ? jsx('span', { style: styles.mark, children: t('turnCost.unknown') }, 'unknown') : null,
            !showUnknown && subtree !== undefined && subtree.estimated && !showChildren
              ? jsx('span', { style: styles.mark, children: '*' }, 'mark')
              : null,
            tooltipBubble(tooltip, lines, 'tooltip', true),
          ],
        },
        'sapi-budget-session',
      );

      const select = groupPicker({ t, snapshot, data });
      return jsxs(
        'div',
        {
          'data-sapi-budget': 'session-root',
          style: styles.root,
          children: [chip, select],
        },
        'sapi-budget-session-root',
      );
    }

    /**
     * The native group picker, or a dimmed placeholder before the first answer.
     *
     * The selected value is the Client's OWN choice (`snapshot.group`), never
     * the Host's `data.group`: that field is the RESOLVED group, so in auto mode
     * it names whichever group the Host picked for us. Showing it would make the
     * picker claim "deepseek-HK" while the user had chosen "auto", and it would
     * also lag one round-trip behind every switch. `data.requestedGroup` echoes
     * the request, but the local state is already authoritative for the UI.
     */
    function groupPicker({ t, snapshot, data }) {
      const groups = data === null ? [] : data.groups;
      const value = snapshot.group;
      if (groups.length === 0) {
        return jsx(
          'span',
          {
            'data-sapi-budget': 'group',
            style: styles.selectUnavailable,
            title: snapshot.unreachable ? t('error.unreachable') : t('group.select'),
            children: t('group.select'),
          },
          'sapi-budget-group',
        );
      }
      // The option list is, in order:
      //   1. the auto seat — value '', which makes the Host pick the cheapest
      //      group itself. Without it a user who ever picked a group could never
      //      get back to automatic selection, because every other option names
      //      a concrete group.
      //   2. every group the Host published.
      //   3. a value the Host did not publish but localStorage still holds (the
      //      provider renamed or dropped it). Without an <option> for it the
      //      browser would silently show the first group while `value` and the
      //      rendered totals still referred to the old one.
      const names = groups.map((group) => group.name);
      const options = [jsx('option', { value: '', title: t('group.auto'), children: t('group.auto') }, '__sapi-budget-auto')];
      if (value !== '' && !names.includes(value)) {
        options.push(jsx('option', { value, title: value, children: value }, '__sapi-budget-current'));
      }
      for (const group of groups) {
        options.push(
          jsx(
            'option',
            {
              value: group.name,
              title: t('group.ratio', { ratio: group.ratio }),
              children: group.name,
            },
            group.name,
          ),
        );
      }
      return jsx(
        'select',
        {
          'data-sapi-budget': 'group',
          'aria-label': t('group.select'),
          title: value === '' ? t('group.auto') : t('group.current', { name: value }),
          value,
          style: styles.select,
          onChange: (event) => {
            const element = event !== null && typeof event === 'object' ? event.target : undefined;
            const next = element !== null && element !== undefined && typeof element.value === 'string' ? element.value : '';
            catalog.setGroup(next);
          },
          children: options,
        },
        'sapi-budget-group',
      );
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    function apply(ctx) {
      // Dictionaries first: a slot entry that names this namespace must find it.
      if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sapi-budget: dictionaries');
      }

      const slots = ctx.slots;
      if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
        console.warn('[sapi-budget] no slot service on this host: the price helper stays hidden.');
        return;
      }

      // Neither registration throws on a host that never declares the slot:
      // `inject` waits for the declaration instead.
      slots.inject('conversation.chat.turnTail', () =>
        slots.register(
          { name: 'conversation.chat.turnTail', id: TURN_SLOT_ID, order: 20, locale: NS },
          TurnCostTail,
        ),
      );

      slots.inject('conversation.session.header.utilities', () =>
        slots.register(
          { name: 'conversation.session.header.utilities', id: SESSION_SLOT_ID, order: 20, locale: NS },
          SessionCostUtilities,
        ),
      );
    }

    const api = {
      name: 'sapi-budget',
      inject: ['slots', 'locale'],
      apply,
      // Pure helpers and the shared store, exposed without side effects so the
      // money math and the render output can be regression-tested under node.
      __test: {
        NS,
        STATE_PATH,
        REFRESH_PATH,
        GROUP_STORAGE_KEY,
        PROJECTION_KEY,
        TURN_SLOT_ID,
        SESSION_SLOT_ID,
        dicts: { zh, en },
        catalog,
        TurnCostTail,
        SessionCostUtilities,
        costOfBucket,
        selectTier,
        formatMoney,
        currencySymbol,
        indexModels,
        summarizeBuckets,
        summarizeTurn,
        summarizeSession,
        turnNumberOf,
        normalizeState,
        fallbackTranslate,
        // Session-lineage helpers. `subtreeBuckets` implements the contract's
        // `subtree(s) = own(s) + Σ subtree(c)` and is tested on its own.
        LINEAGE_PATH,
        subtreeBuckets,
        normalizeLineage,
        summarizeLineage,
        priceLineageNode,
        rootModelNames,
        normalizeBucket,
        addBucket,
        zeroBucket,
        lineageLines,
        rowMoney,
      },
    };
    module.exports = api;
    return module.exports;
  },
});
