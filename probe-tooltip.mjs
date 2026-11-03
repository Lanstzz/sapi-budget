/**
 * Probe: does the cost chip deliver its breakdown through a native `title`,
 * or through a plugin-rendered tooltip element?
 *
 * WHY THIS EXISTS
 * ---------------
 * The user reports: hovering the session-cost chip takes a long time before the
 * detailed breakdown appears.
 *
 * On macOS an HTML `title` is served by Cocoa's NSToolTip machinery — Electron's
 * framework implements `view:stringForToolTip:point:userData:`. Cocoa starts its
 * own timer and *resets it whenever the pointer moves inside the title rect*, so
 * "wait a while" is the designed behaviour of that surface, not a flake. The
 * platform's own UI never uses a multi-line native `title`: it renders a React
 * tooltip bubble (`delayMs` 200–500ms) instead.
 *
 * This probe asserts the structural property that produces the symptom, so the
 * diagnosis can go red/green instead of relying on someone reading the code.
 *
 * Run: node probe-tooltip.mjs
 * Exit 0 = the breakdown is plugin-rendered (expected AFTER a fix)
 * Exit 1 = the breakdown rides on a native title (expected TODAY)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const reactStub = {
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  useState: (initial) => [initial, () => {}],
  createElement: (type, props, ...children) => ({ type, props, children }),
};
const jsxRuntimeStub = {
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key, children: props?.children }),
  Fragment: Symbol.for('react.fragment'),
};
const ALLOWED = { react: reactStub, 'react/jsx-runtime': jsxRuntimeStub };
const fakeRequire = (spec) => {
  if (Object.prototype.hasOwnProperty.call(ALLOWED, spec)) return ALLOWED[spec];
  throw new Error(`unexpected require: ${spec}`);
};

const registered = [];
globalThis.window = { __ModuleLoader__: { load: (spec) => registered.push(spec) } };
new Function(readFileSync('./client.js', 'utf8'))();
const client = registered[0].factory(fakeRequire);
const H = client.__test;

/** Depth-first walk of the stub element tree, collecting every props object. */
function collectProps(root, out = []) {
  if (root === null || typeof root !== 'object') return out;
  if (root.props && typeof root.props === 'object') out.push(root.props);
  for (const child of root.children ?? root.props?.children ?? []) collectProps(child, out);
  return out;
}

// A session with real usage, so the breakdown has several lines to show.
const wire = () => ({
  ok: true,
  group: 'deepseek-HK',
  currency: 'USD',
  quotaPerUnit: 500000,
  models: [
    {
      name: 'deepseek-v4.1-flash',
      kind: 'ratio',
      ratio: 1,
      completionRatio: 4,
      cacheRatio: 0.1,
      modelPrice: 0,
      groups: ['deepseek-HK'],
      groupRatio: 0.24,
      group: 'deepseek-HK',
      tiered: null,
    },
  ],
  fetchedAt: Date.now(),
  stale: false,
  error: null,
});

H.catalog.accept(wire());
H.catalog.setGroup('deepseek-HK');
const projection = {
  turns: [
    { turn: 1, models: [{ model: 'deepseek-v4.1-flash', input: 1000, output: 500, cacheRead: 100, cacheWrite: 0, requests: 1 }] },
  ],
};

const node = H.SessionCostUtilities({ sessionId: 'probe-session', useProjection: () => projection, t: (k) => k });
const props = collectProps(node);

// Every place the breakdown could be published.
const nativeTitles = props
  .map((p) => p.title)
  .filter((t) => typeof t === 'string' && t.includes('\n'));
const roleTooltips = props.filter((p) => p.role === 'tooltip');
const hoverHandlers = props.filter((p) => typeof p.onMouseEnter === 'function');

console.log('elements inspected        :', props.length);
console.log('multi-line native titles  :', nativeTitles.length);
console.log('role="tooltip" elements   :', roleTooltips.length);
console.log('elements with onMouseEnter:', hoverHandlers.length);

if (nativeTitles.length > 0) {
  console.log('\nfirst multi-line title (first 3 lines):');
  for (const line of nativeTitles[0].split('\n').slice(0, 3)) console.log('   ', line);
}

try {
  assert.equal(
    nativeTitles.length,
    0,
    'the breakdown must not ride on a native multi-line title: on macOS that is served by ' +
      'Cocoa NSToolTip, whose timer restarts whenever the pointer moves — the reported delay',
  );
  assert.ok(
    roleTooltips.length > 0 || hoverHandlers.length > 0,
    'the breakdown must be reachable through a plugin-rendered hover surface instead',
  );
  console.log('\nPASS — breakdown is plugin-rendered.');
} catch (error) {
  console.error(`\nFAIL — ${error.message}`);
  process.exit(1);
}
