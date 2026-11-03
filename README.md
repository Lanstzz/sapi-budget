# sapi-budget

A DeepSeek Harness plugin that syncs the per-group model prices from an
[AiSpot](https://aispot.swj0227.icu/) (`sapi`) deployment and shows what each
conversation costs — a session total in the conversation header and a per-turn
cost at the end of every assistant turn.

The group list is crawled from the provider, never hardcoded, so it follows the
provider as groups appear and disappear. You pick the active group from a
dropdown in the conversation header, and every historical number is re-priced
immediately — no reload, no replay.

## What it shows

- **Session total** in the conversation header, including every descendant
  subagent (`subtree(s) = own(s) + Σ subtree(children)`).
- **Per-turn cost** at the end of each assistant turn.
- A hover breakdown listing the model, the tokens per bucket, and the total.

Money is never published by the host. The projection carries token buckets only,
and the browser prices them against the live catalog — that is what makes a
group switch re-price history instantly.

## Install

```sh
dsh plugin add github:Lanstzz/sapi-budget
```

Or from a local checkout:

```sh
dsh plugin add /absolute/path/to/sapi-budget
```

Then restart the app: the bundle is loaded at startup.

## Configuration

All optional. Set them in your profile patch (`cordis.patch.yml`):

```yaml
- id: sapi-budget
  name: 'dsh-sapi-budget'
  config:
    baseUrl: https://aispot.swj0227.icu   # any compatible deployment
    group: ''                             # '' = let the provider pick the cheapest
    currency: USD
    refreshMinutes: 30
```

The group is normally chosen in the UI and persisted in the browser's
`localStorage` (`sapi-budget.group`); the config value is only a fallback.

## Pricing data

Three public, unauthenticated endpoints on the provider:

| Endpoint | Used for |
| --- | --- |
| `/api/pricing` | model list, ratios and `tiered_expr` expressions |
| `/api/status` | quota unit and exchange rate |
| `/api/user/groups` | group names and per-group ratio multipliers |

Tiered expressions are evaluated by a hand-written tokenizer and recursive-descent
parser in `pricing.js`. There is no `eval` and no `new Function`.

## Accuracy notes

- Tiered models are marked as estimates (`估算` / `estimate`) in the UI.
- A subagent's spend is priced at the root session's model rate, because
  cross-session model attribution is not available on the host side. Those rows
  are labelled as estimates too.
- Subagents that finished before the plugin was installed have no readable
  projection. They are reported as **unknown**, never as `$0.00`.

## Layout

| File | Role |
| --- | --- |
| `index.js` | Host half: pricing service, three HTTP routes, the `sapiCost` session projection, and the `sapi_price` agent tool |
| `client.js` | Browser half: the two slot entries, the group picker, and the tooltip bubble |
| `pricing.js` | Catalog fetching and the `tiered_expr` evaluator |
| `test/` | 45 host tests + 59 client tests |
| `probe-tooltip.mjs` | Structural check that the breakdown does not ride on a native `title` |

## Development

```sh
node --check index.js && node --check client.js && node --check pricing.js
node --test test/index.host.test.js   # 45 pass
node --test test/client.test.js       # 59 pass
node probe-tooltip.mjs                # exit 0
```

`HANDOFF.md` records the architecture decisions and the traps that cost real time
(including why the cost breakdown must never be a multi-line native `title` on
macOS).

## Licence

MIT — see [LICENSE](LICENSE).
