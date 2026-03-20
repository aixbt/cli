# Recipe Building Blocks

Composable parts catalog for `@aixbt/cli` recipes (v1.1). Pick the blocks you need, wire them together, and write analysis instructions for the assembled data.

This document complements the [Recipe Specification](recipe-specification.md) (formal schema) and the [CLI Guide](cli-guide.md) (command workflows). The spec tells you what's valid YAML; this doc tells you what to put in it.

**Recipe registry:** 24 production recipes live in a remote registry. Use `aixbt recipe list` to see all available recipes and `aixbt recipe show <name>` to dump any recipe's full YAML. These are the best source of working patterns — when in doubt, read an existing recipe that does something similar to what you're building.

**Cloning and customizing:** `aixbt recipe clone <name>` copies a registry recipe to `~/.aixbt/recipes/` with a `.clone` suffix (both filename and `name:` field). Use `--name <newName>` to choose your own name, `--out <dir>` for a different directory.

---

## 1. Provider Action Catalog

Every action available in recipe steps, grouped by provider. Use `action` (required) and `source` (optional, defaults to `"aixbt"`) to invoke them.

For live discovery: `aixbt provider list -f json` returns all actions with params and tier requirements. `aixbt provider <source> <action> -f json` runs an action outside a recipe for testing.

### AIXBT

| Action | Use when | Required params | Key response fields |
|---|---|---|---|
| `projects` | You need a list of projects filtered or sorted by momentum, popularity, chain, ticker, or name | None (many optional: `limit`, `sortBy`, `projectIds`, `chain`, `tickers`, `excludeStables`, etc.) | `id`, `name`, `momentumScore`, `popularityScore`, `metrics`, `tokens`, `coingeckoData`, `signals[]` |
| `project` | You have a specific project ID and need its full details | `id` (path) | Same as `projects` but single object with full `description` and embedded signals |
| `momentum` | You need historical momentum trajectory for a project | `id` (path); optional: `start`, `end`, `includeClusters` | `data[].timestamp`, `data[].momentumScore`, `data[].clusters[]` |
| `signals` | You need market signals filtered by project, cluster, category, or time range | None (many optional: `projectIds`, `clusterIds`, `categories`, `detectedAfter`, `reinforcedAfter`, etc.) | `id`, `detectedAt`, `reinforcedAt`, `description`, `projectName`, `projectId`, `category`, `hasOfficialSource`, `clusters[]`, `activity[]` |
| `clusters` | You need the list of community segment definitions | None | `id`, `name`, `description` |
| `chains` | You need the list of supported blockchains | None | Chain name strings |

### CoinGecko

GeckoTerminal actions (free) use on-chain DEX data by contract address. CoinGecko API actions use CoinGecko IDs — most require a demo key, but `ohlc` works without one.

**Chain name mapping:** All actions that take a `network` param accept CoinGecko platform IDs (e.g., `"ethereum"`, `"solana"`, `"base"`) — the CLI maps them to GeckoTerminal network IDs automatically.

#### Commonly Used

| Action | Use when | Tier | Required params | Notes |
|---|---|---|---|---|
| `price-history` | You need historical price candles and have a token address and/or CoinGecko ID | free | At least one of: `network`+`address`, or `geckoId` | **Meta-action.** Routes to `token-ohlcv` (on-chain DEX data) when address is available, falls back to `ohlc` (CoinGecko OHLC) when only `geckoId` is available. Both paths are free tier. Always use with `fallback`. Optional: `timeframe` (day/hour/minute), `limit`, `currency` |

#### GeckoTerminal Actions (free tier)

| Action | Use when | Required params | Notes |
|---|---|---|---|
| `token-price` | You have a contract address and need current DEX price | `network`, `addresses` (path) | On-chain price from DEX pools |
| `token-pools` | You need to find liquidity pools for a token | `network`, `address` (path) | Lists trading pairs |
| `trending-pools` | You need currently trending DEX pools by volume | None | Cross-network trending |

Also available: `pool` (single pool detail), `token-ohlcv` (OHLCV by address — underlying action for `price-history`), `pool-ohlcv` (pool-level OHLCV). In practice, use `price-history` instead of calling `token-ohlcv`/`pool-ohlcv` directly.

#### CoinGecko API Actions (demo/pro tier)

| Action | Use when | Required params | Notes |
|---|---|---|---|
| `price` | You need current price by CoinGecko ID | `ids` | Optional: `include_market_cap`, `include_24hr_vol`, `include_24hr_change` |
| `markets` | You need ranked coin market data, optionally by category | None | Optional: `ids`, `category`, `order`, `per_page`, `sparkline`, `price_change_percentage` |
| `coin` | You need comprehensive details about a specific coin | `id` (path) | Social links, contract addresses, community/developer data |
| `trending` | You need currently trending coins on CoinGecko | None | Coins, NFTs, and categories |
| `categories` | You need coin categories with market data | None | Category slugs useful for `markets` filtering |

Also available: `ohlc` (free tier — OHLC by CoinGecko ID, underlying action for `price-history` when only `geckoId` is available).

### DeFiLlama

| Action | Use when | Tier | Required params | Notes |
|---|---|---|---|---|
| `protocols` | You need a list of all DeFi protocols with TVL | free | None | Large response — consider transform |
| `protocol` | You have a protocol slug and need its TVL breakdown | free | `protocol` (path) | Chain distribution, TVL history |
| `tvl` | You need aggregate TVL history across all chains | free | None | Historical total DeFi TVL |
| `chains` | You need blockchain TVL rankings | free | None | Current TVL per chain |
| `chain-tvl` | You need TVL history for a specific chain | free | `chain` (path) | CoinGecko chain names accepted (mapped automatically) |
| `emissions` | You need token unlock/emission schedules | **pro** | `coingeckoId` (path) | Requires DeFiLlama pro key — use with `fallback` |
| `yields` | You need DeFi yield/APY data | **pro** | None | Pool-level yield data |

**Chain name mapping:** The `chain` param accepts CoinGecko platform IDs (e.g., `"ethereum"`) — the CLI maps them to DeFiLlama chain names (e.g., `"Ethereum"`).

### GoPlus

All actions are free tier.

| Action | Use when | Required params | Notes |
|---|---|---|---|
| `security-check` | You have a token address and chain and need security analysis | `chain`, `address` | **Meta-action.** Routes to the correct chain-specific endpoint based on chain name. CoinGecko chain names accepted. Covers honeypot, tax, mint authority (EVM), freeze/mint authority (Solana), upgradeability (Sui). |
| `address-security` | You need to check if a wallet is flagged as malicious | `address` (path) | Optional: `chain_id` |
| `approval-security` | You need to audit token approval risks | `chain_id` (path), `contract_addresses` | Unlimited approvals, proxy risks |

Also available: `token-security` (direct EVM endpoint), `solana-token-security`, `sui-token-security` (use `security-check` instead — it handles chain routing), `nft-security`, `phishing-site`, `supported-chains`.

---

## 2. AIXBT Response Shapes

Field semantics for AIXBT's own data objects. External provider responses vary and are best discovered by running the action — these shapes are stable and under our control.

### Project

```
id: string                    — Unique project identifier (MongoDB ObjectId)
name: string                  — Display name ("solana", "Euro Coin")
description: string?          — Brief project description (not always present)
xHandle: string               — Twitter/X handle
momentumScore: number         — Current momentum: rate of cluster spread (0-1+). Higher =
                                discussion actively expanding to new community segments.
                                This is velocity, not volume.
popularityScore: number       — Sustained mention volume (integer). Unlike momentum
                                (spreading), this measures total established attention.
                                High popularity + low momentum = well-known but not growing.
                                Low popularity + high momentum = emerging.
metrics: {
  usd: number                 — Current price in USD
  usdMarketCap: number        — Market capitalization
  usd24hVol: number           — 24-hour trading volume
  usd24hChange: number        — 24-hour price change (percentage as decimal, e.g. -0.09 = -9%)
  lastUpdatedAt: number       — Unix timestamp of last price update
}
tokens: [{                    — On-chain token addresses (for wallet/holder analysis and
                                external provider lookups)
  chain: string               — Blockchain ("ethereum", "solana", "base", etc.) — this is
                                the CoinGecko platform ID, accepted by all provider chain params
  address: string             — Contract/mint address. CASE-SENSITIVE for Solana.
  source: string              — Data source ("coingecko", "dexscreener")
}]
coingeckoData: {
  symbol: string              — Trading ticker ("SOL", "EURC")
  slug: string                — CoinGecko URL slug
  apiId: string               — CoinGecko API ID (for price-history geckoId param)
  description: string         — CoinGecko project description
  contractAddress: string     — Primary contract address
  categories: string[]        — CoinGecko category tags
}
createdAt: string             — When the project was first tracked (ISO date)
reinforcedAt: string          — When the most recent signal was reinforced (ISO date).
                                Stale reinforcedAt = project gone quiet.
signals: [{...}]              — Embedded recent signals (up to 10). ONLY available when
                                select transform is not applied. See Signal below.
```

**Key interpretation patterns:**
- **momentumScore vs popularityScore divergence** is the most analytically interesting dimension. High momentum + low popularity = emerging project the crowd hasn't noticed. High popularity + declining momentum = established project losing its edge.
- **metrics.usd24hChange** should be read against BTC/ETH context. A project down 5% while BTC is down 8% is outperforming.
- **tokens[].chain + tokens[].address** are the data pointers for external provider lookups — feed them to `price-history`, `security-check`, etc.
- **coingeckoData.apiId** is the key for CoinGecko actions that take an `id` param, and for DeFiLlama `emissions`.

### Signal

```
id: string                    — Unique signal identifier
detectedAt: string            — When the signal was FIRST observed (ISO date)
reinforcedAt: string          — When the signal was LAST confirmed (ISO date).
                                Gap between detectedAt and reinforcedAt reveals persistence.
description: string           — Human-readable signal summary (substantive claim, not raw source text)
projectName: string           — Display name of the related project
projectId: string             — Project ID (for joining to project data)
category: string              — One of:
                                  TECH_EVENT         — Protocol upgrades, launches, audits
                                  TOKEN_ECONOMICS    — Unlocks, burns, staking changes
                                  PARTNERSHIP        — Integrations, collaborations
                                  FINANCIAL_EVENT    — TGEs, airdrops, funding rounds
                                  MARKET_ACTIVITY    — Exchange listings, liquidity events
                                  ONCHAIN_METRICS    — TVL changes, volume shifts, holder movements
                                  WHALE_ACTIVITY     — Large wallet movements, accumulation
                                  VISIBILITY_EVENT   — Media mentions, influencer attention
                                  OPINION_SPECULATION — Community predictions, sentiment shifts
                                  TEAM_UPDATE        — Team changes, governance decisions
hasOfficialSource: boolean    — Whether at least one source is from the project's own channels.
                                Official source = first-party confirmation.
clusters: [{                  — Which community segments are discussing this
  id: string
  name: string
}]
activity: [{                  — Reinforcement timeline (optional, include via select)
  date: string                — When this reinforcement occurred
  source: string              — Platform ("x", "discord", "telegram")
  cluster: { id, name }       — Contributing cluster
  incoming: string            — Raw observation text
  result: string              — Processed signal text after this reinforcement
  isOfficial: boolean         — Whether this specific source is an official channel
}]
```

**Key interpretation patterns:**
- **detectedAt vs reinforcedAt gap**: Signals reinforced over multiple days across multiple clusters = genuine sustained attention. Detected and never reinforced = noise.
- **category** determines signal type. TECH_EVENT and TOKEN_ECONOMICS are most concrete (verifiable, quantifiable). VISIBILITY_EVENT and OPINION_SPECULATION are least actionable alone.
- **hasOfficialSource = true** elevates credibility. A TOKEN_ECONOMICS signal from the project itself is near-certain; without official source, could be speculation.
- **clusters array length**: 1 cluster = early/niche. 5+ clusters = broad awareness, likely priced in.
- **activity array**: Accelerating reinforcement (more frequent, more clusters) = growing conviction. Decelerating = narrative exhaustion.

### Momentum

```
projectId: string
projectName: string
data: [{
  timestamp: string           — Hour bucket (ISO date, hourly granularity)
  momentumScore: number       — Momentum for that hour (0-1+)
  clusters: [{                — OPTIONAL (only with includeClusters=true)
    id: string
    name: string
    count: number             — Mentions from this cluster in this hour
  }]
}]
```

**Key interpretation patterns:**
- **Curve shape matters more than any single value.** Steady climb = organic growth. Sharp spike = event-driven (check signals). Spike then decay = attention didn't stick. V-shape = revival.
- **Without clusters** (`includeClusters: "false"`): score trajectory only. Sufficient for direction/timing analysis.
- **With clusters**: see which communities drive each phase. Single-cluster spike = fragile. Multi-cluster spike = broad conviction.
- **Hourly granularity**: 168 data points per 7 days. High-resolution but data-heavy.

### Cluster

```
id: string                    — Cluster identifier (referenced by signal.clusters and momentum.clusters)
name: string                  — Short label ("AI", "Traders 1", "Solana", "Official Channels")
description: string           — Community characterization (topics, key accounts, behavior)
```

**Key interpretation patterns:**
- Clusters are independent community segments. Multiple clusters detecting the same signal = cross-market consensus, not echo chamber.
- **"Official Channels"** cluster = project team announcements. Treat as first-party.
- Cluster diversity on a signal or project is a quality indicator. Single-cluster = narrow. Multi-cluster = information has crossed community boundaries.

### Source Identity Tagging

When a foreach step iterates over projects and fetches from an external provider, the results automatically carry source identity fields copied from the source item:

```
_source_id: string            — Copied from item.id or item._id
_source_name: string          — Copied from item.name
_source_symbol: string        — Copied from item.symbol (if present)
_source_slug: string          — Copied from item.slug (if present)
```

These let you correlate external enrichment data back to the parent project. When `hints.combine` joins data by `key: "id"`, source identity tagging is how foreach results from external providers match up with project data.

---

## 3. Shaping Data for Inference Quality

Transforms (`sample` and `select`) exist to improve the quality of agent inference, not primarily to reduce costs. An agent given 50K tokens of unfocused data produces worse analysis than one given 15K tokens of the right data. Sample to focus on high-signal items; select to strip fields that add noise without analytical value.

The measurements below (production API, 2026-03-15, post-select, pre-sample) help you understand where data mass comes from so you can make informed decisions about what to keep and what to cut.

### Per-Block Token Costs

| Block | Scope | JSON tokens | Notes |
|---|---|---|---|
| SPECIFIED_PROJECTS (3 projects) | per recipe | ~320 | With select (~300/project). Without select: ~5,800 (embedded signals dominate) |
| SURGING_PROJECTS (10) | per recipe | ~3,000 | With select (~300/project). Scales linearly with limit |
| POPULAR_PROJECTS (10) | per recipe | ~46,000 | No select — embedded signals are ~90% of data mass |
| DERIVED_PROJECTS | per recipe | ~3,000 | With select. Count depends on upstream signal diversity |
| BROAD_SIGNALS (50) | per recipe | ~28,000 | With select including activity. Activity = 76% of data mass. Without activity: ~6,700 |
| PER_PROJECT_SIGNALS | per project | ~400 | Highly variable (0–1,300). Avg ~1 signal/project for surging, more for established |
| NARRATIVE_ARC | per project | ~120 | 30d, description+date only. Pre-sample. Avg ~3 signals/project |
| MOMENTUM_HISTORY (7d) | per project | ~1,200 | Without clusters. With clusters: ~1,700 |
| MOMENTUM_HISTORY (14d) | per project | ~2,100 | Without clusters. With clusters: ~2,800 |
| MOMENTUM_HISTORY (30d) | per project | ~3,100 | Without clusters. With clusters: ~4,100 |
| CLUSTERS | per recipe | ~11,500 | 47 clusters, fixed cost |
| MARKET_CONTEXT | per recipe | ~570 | BTC + ETH only |

### Rules of Thumb

**10-project recipe, 14d momentum (no clusters), per-project signals, narrative arc, clusters:**
~3,000 + (10 × 400) + (10 × 120) + (10 × 2,100) + 11,500 + 570 ≈ **41K tokens**

**Where to focus your shaping:**
- **Signal data dominates.** BROAD_SIGNALS with `activity` is ~28K alone. If the agent doesn't need the reinforcement timeline, drop `activity` from `select` — that's 76% of the signal data mass. Sample to guarantee the most relevant signals surface first.
- **`includeClusters: "false"` on momentum** when the recipe already fetches clusters separately. The per-cluster breakdown is useful for deep analysis but adds ~40% per project without adding new information if clusters are already in context.
- **Embedded signals in projects** (~4,500/project when select is omitted) duplicate what a dedicated signal fetch provides with better coverage and field control. Apply select to strip them when you have a dedicated signal step.
- **External provider data** (price-history, security-check, emissions) varies per project. Always use `fallback` so missing data degrades gracefully rather than failing the recipe.

### Embedded Signals Rule

Projects include an embedded `signals` array (up to 10 recent signals). The `select` transform strips these. The rule:

- **Apply select** (drop embedded signals) when the recipe has a dedicated signal fetch for those projects — either PER_PROJECT_SIGNALS with `foreach: projects.data` or BROAD_SIGNALS joined via `key: "projectId:id"`. The dedicated fetch gives better coverage with sampling and field control.
- **Omit select** (keep embedded signals) when the recipe's signal coverage may not include every project in the set. The embedded signals are then the only per-project signal context available.

### Broad vs Per-Project Signals

Two approaches to signal data with different coverage characteristics:

| Approach | Data mass | Coverage | Use when |
|---|---|---|---|
| **BROAD_SIGNALS** (single fetch) | ~28K (with activity) or ~6.7K (without) | Market-wide but may miss quiet projects | Discovery, narrative tracking, market overview — you want cross-project patterns |
| **PER_PROJECT_SIGNALS** (foreach) | ~400 × N projects | Guaranteed per-project coverage | Assessment, comparison, portfolio — every project in the set needs its own signals |

Many recipes use both: broad signals for cross-project patterns, per-project signals for focused analysis. This is complementary, not redundant — broad signals surface patterns between projects that per-project fetches miss.

---

## 4. Writing Instructions and Fallbacks

Recipes have two instruction surfaces: what the **engine injects automatically** and what the **recipe author controls**. Understanding the boundary helps you write instructions that complement rather than duplicate what the agent already receives.

### What the Engine Injects

The engine adds context at multiple points — none of this needs to be in your recipe YAML:

**System prompt.** Every agent invocation receives a system prompt explaining AIXBT's domain: what clusters, signals, and momentum scores mean, how to interpret the data structures, and what tools are available (web search, file reading). You don't need to explain these concepts in your `instructions`.

**Action context hints.** The engine scans which actions your recipe uses and injects domain-specific interpretation guidance:
- `signals` steps → how to read signal categories, reinforcement patterns, and cluster spread
- `momentum` steps → how to interpret momentum curves, inflection points, and cluster engagement
- `clusters` steps → what clusters represent and how cross-cluster detection indicates consensus

**Field context hints.** When your `select` transform includes specific fields, the engine adds field-level guidance:
- `activity` in select → explains the reinforcement timeline array, source platforms, and how to read acceleration/deceleration patterns

**Sampling notes.** When a `sample` transform runs, the engine notes that the data was sampled (not exhaustive) and what guarantee/random split was applied.

**Parallel execution instructions.** For parallel agent steps (`type: agent` with `foreach`), the engine generates detailed instructions explaining:
- Which context steps contain **per-item data** (foreach steps matching the same source array) vs **shared data** (non-foreach steps or foreach over different arrays)
- How to spawn parallel agents and what data each receives
- The expected resume format matching the `returns` schema

### What the Recipe Author Controls

**`instructions` on agent steps.** This is where you tell the agent *what to do* with the data. Focus on:
- What analytical question to answer (not what the data fields mean — the engine handles that)
- Which data relationships to examine (e.g., "map momentum inflection points to signal catalysts")
- What output structure you want (the `returns` schema defines types, but instructions define quality expectations)
- When to use external tools (e.g., "web search for project news and team background")

**`analysis` block.** Instructions for the final synthesis after all steps complete. Template expressions (`{params.*}`) are resolved at execution time. The analysis agent receives all step results. Use this for:
- How to structure the final output
- Cross-cutting analysis directives (e.g., "compare projects by momentum phase alignment")
- Output format expectations

**`fallback` on API and foreach steps.** The fallback string becomes an instruction to the agent when a step is skipped or items fail. The engine wraps your text in context:

For API steps (entire step skipped due to missing/insufficient provider key):
```
Step "<id>" was skipped — no <source> API key configured — <your fallback text>
```

For foreach steps (individual items that fail):
```
<your fallback text> for: <item1>, <item2>, <item3>
```

Failed foreach items preserve identity fields (`id`, `name`, `symbol`, `slug`) so the agent knows which items need alternative handling.

**Write fallbacks as agent instructions**, not error messages. Good: `"Look up 90-day price data for this project."` Bad: `"Price data unavailable."` The agent can often fulfill the request via web search or other tools if you tell it what to look for.

### Instruction Writing Tips

- **Don't explain AIXBT domain concepts.** The system prompt and action context hints already cover what momentum scores, signal categories, and clusters mean.
- **Do explain analytical intent.** "Assess whether momentum is driven by genuine adoption signals or visibility noise" gives the agent a framework; "momentumScore is a number from 0-1" wastes instruction tokens.
- **Reference `_item` in parallel agent instructions.** For `foreach` agent steps, the current project's data is available as `_item`. List what the agent has: `"You have: _item (project metadata), signals (48h signals), momentum (14-day trajectory)"`.
- **Keep `returns` schemas minimal.** The agent produces the analysis in its `returns` — a `projectId: "string"` + `analysis: "string"` pair is usually sufficient. Over-structured returns constrain the agent without improving output quality.

---

## 5. Reusable Step Blocks

Copy-paste YAML templates. Adapt `id`, params, and transforms to your recipe's needs.

### Project Discovery

#### SPECIFIED_PROJECTS

Fetch user-named projects by ID, ticker, name, or contract address.

```yaml
params:
  projectIds: { type: string, description: "Comma-separated project IDs" }
  tickers: { type: string, description: "Comma-separated ticker symbols (e.g. SOL,ETH)" }
  names: { type: string, description: "Comma-separated project names" }
  address: { type: string, description: "Token contract address" }
requiredOneOf: [projectIds, tickers, names, address]

steps:
  - id: projects
    action: projects
    params:
      projectIds: "{params.projectIds}"
      tickers: "{params.tickers}"
      names: "{params.names}"
      address: "{params.address}"
    transform:
      select: [id, name, description, xHandle, momentumScore, popularityScore, metrics, tokens, coingeckoData, createdAt, reinforcedAt]
```

Position: First step. Uses `requiredOneOf` so the user can identify projects by whichever method they have — the API accepts any one of these filters. Template resolution skips params that weren't provided.

Use when: The user specifies which projects to analyze (assessment, comparison, portfolio, deep dive).

#### SURGING_PROJECTS

Fetch projects ranked by momentum (attention spreading to new clusters).

```yaml
- id: surging
  action: projects
  params:
    limit: 10
    sortBy: momentumScore
    excludeStables: true
  transform:
    select: [id, name, description, xHandle, momentumScore, popularityScore, metrics, tokens, coingeckoData, createdAt, reinforcedAt]
```

Position: First step. `limit` can be hardcoded or use `{params.projectLimit}`.

Use when: The recipe needs to find what's gaining attention right now. Core block for discovery recipes.

Variants:
- With `chain: "{params.chain}"` — filters to a specific blockchain
- As a reference set (`id: surging_rankings`) with `select: [id, name, momentumScore]` — lightweight comparison data

#### POPULAR_PROJECTS

Fetch projects ranked by sustained mention volume.

```yaml
- id: popular_projects
  action: projects
  params:
    limit: "{params.projectLimit}"
    sortBy: popularityScore
    excludeStables: true
```

Position: First step. No `select` transform — keeps embedded signals since these recipes often don't have a dedicated per-project signal fetch.

Use when: Analyzing established projects for decay, revival, or divergence against surging projects.

#### DERIVED_PROJECTS

Fetch project details for projects referenced in upstream signal data.

```yaml
- id: projects
  action: projects
  params:
    projectIds: "{signals.data[*].projectId}"
    excludeStables: true
  transform:
    select: [id, name, description, xHandle, momentumScore, popularityScore, metrics, tokens, coingeckoData, createdAt, reinforcedAt]
```

Position: After a broad signal fetch. The `{signals.data[*].projectId}` expression extracts unique project IDs from the signal results.

Use when: Signal-first recipes where signals determine which projects matter.

### Signals

#### BROAD_SIGNALS

Market-wide recent signals, not filtered to specific projects.

```yaml
- id: signals
  action: signals
  params:
    reinforcedAfter: "-48h"
    sortBy: reinforcedAt
  transform:
    sample:
      tokenBudget: 50000
      guaranteeCount: 30
    select: [id, detectedAt, reinforcedAt, description, projectName, projectId, category, hasOfficialSource, clusters]
```

Use when: Market-wide signal landscape before narrowing to specific projects. Essential for discovery, narrative tracking, risk scanning.

Variants:
- With `clusterIds: "{params.clusterId}"` — cluster-scoped view
- Lookback window: `-48h` (standard), `-24h` (freshness-critical)
- With `activity` in select — adds reinforcement timeline (data-heavy: +76% more tokens)

#### PER_PROJECT_SIGNALS

Per-project signal fetch via foreach.

```yaml
- id: signals
  foreach: projects.data
  action: signals
  params:
    projectIds: "{item.id}"
    reinforcedAfter: "-48h"
  transform:
    sample:
      tokenBudget: 50000
      guaranteeCount: 30
    select: [id, detectedAt, reinforcedAt, description, projectName, projectId, category, hasOfficialSource, clusters]
```

Use when: Every project in the set needs its own signal assessment. Guarantees coverage for each project.

Variants:
- `reinforcedAfter: "-48h"` (recent) vs `detectedAfter: "-7d"` (extended)
- Configurable window: `reinforcedAfter: "{params.signalWindow}"`

#### NARRATIVE_ARC

Sampled 30-day signal timeline for story evolution.

```yaml
- id: narrative
  foreach: projects.data
  action: signals
  params:
    projectIds: "{item.id}"
    detectedAfter: "-30d"
  transform:
    sample:
      tokenBudget: 50000
      guaranteePercent: 0.3
    select: [description, detectedAt]
```

Use when: The recipe needs to distinguish genuine narrative development from recycled hype. Complements PER_PROJECT_SIGNALS (recent detail) with historical trajectory.

Foreach target variants: `projects.data` (direct), `picks.projectIds` (after agent gate), `filter.projectIds` (after filter).

### Context

#### MOMENTUM_HISTORY

Per-project momentum trajectory.

```yaml
- id: momentum
  foreach: projects.data
  action: momentum
  params:
    id: "{item.id}"
    start: "-14d"
    includeClusters: "false"
```

Use when: The recipe needs momentum direction, not just the current score. Essential for timing assessments.

Windows: `-7d` (snapshot, ~1,200 tokens/project), `-14d` (standard, ~2,100), `-30d` (full arc, ~3,100). All without clusters.

#### CLUSTERS

All cluster definitions.

```yaml
- id: clusters
  action: clusters
```

No params, no transform. Reference data — place in `hints.include`.

#### MARKET_CONTEXT

BTC and ETH as macro reference.

```yaml
- id: market_context
  action: projects
  params:
    projectIds: "66f4fdc76811ccaef955de3e,66f4fe366811ccaef955dfc7"
  transform:
    select: [id, name, metrics, coingeckoData]
```

Hardcoded BTC and ETH project IDs. Place in `hints.include`.

### External Enrichment

#### PRICE_HISTORY

Per-project price candles via CoinGecko.

```yaml
- id: price_history
  foreach: projects.data
  action: price-history
  source: coingecko
  params:
    network: "{item.tokens[0].chain}"
    address: "{item.tokens[0].address}"
    geckoId: "{item.coingeckoData.apiId}"
    timeframe: day
    limit: 30
  fallback: "Look up 30-day price data for this project."
```

Use when: The recipe needs price context for momentum or signal analysis. The `price-history` meta-action uses on-chain DEX data (free) when address is available, falls back to CoinGecko OHLC when only geckoId is available.

Variants:
- `timeframe: hour`, `limit: 168` — 7-day hourly candles (trade_scanner)
- `limit: 90` — extended history (project_deep_dive)
- `limit: 14` — short window (under_the_radar)

**Always include `fallback`.** Not all projects have tokens with addresses, and provider keys may not be configured.

#### TOKEN_SECURITY

Per-project security scan via GoPlus.

```yaml
- id: token_security
  foreach: projects.data
  action: security-check
  source: goplus
  params:
    chain: "{item.tokens[0].chain}"
    address: "{item.tokens[0].address}"
  fallback: "Look up holder concentration and token security for this project."
```

Use when: The recipe needs risk assessment — honeypot checks, holder concentration, mint authority. The `security-check` meta-action routes to the correct chain-specific endpoint automatically.

**Always include `fallback`.** Many projects lack token addresses.

#### TOKEN_UNLOCKS

Per-project emission schedule via DeFiLlama.

```yaml
- id: token_unlocks
  foreach: projects.data
  action: emissions
  source: defillama
  params:
    coingeckoId: "{item.coingeckoData.apiId}"
  fallback: "Look up token emission/unlock schedule for this project."
```

Use when: The recipe assesses supply-side risk (TOKEN_ECONOMICS signals). Requires DeFiLlama pro key.

**Always include `fallback`.** Requires pro key, and not all projects have emission data.

### Orchestration

#### AGENT_GATE

Single agent that filters or selects from upstream data, returning IDs for downstream enrichment.

```yaml
- id: picks
  type: agent
  context: [signals, projects]
  instructions: |
    Review the upstream data and select 2-3 projects that would
    benefit most from deeper enrichment. Return project IDs.
  returns:
    projectIds: "string[]"
```

Use when: Discovery pattern — start broad, narrow down before deeper per-project enrichment. Creates a segment boundary: steps after this reference `picks.projectIds`, not `projects.data`.

Variants:
- `returns: { picks: "{ signalId: string, reasoning: string }[]" }` — structured picks with reasoning
- `returns: { projectIds: "string[]" }` — most common, simple ID list

#### PARALLEL_AGENT_GATE

Per-project agent analysis via foreach.

```yaml
- id: project_analyses
  type: agent
  foreach: projects.data
  context: [signals, narrative, momentum, price_history, clusters, market_context]
  instructions: |
    Analyze this specific project. You have:
    - _item: project metadata
    - signals, narrative, momentum, price_history: per-project data
    - clusters, market_context: shared reference data

    Produce a structured assessment...
  returns:
    projectId: "string"
    projectName: "string"
    analysis: "string"
```

Use when: Each project needs independent, in-depth analysis that would be too much to do in a single pass. The CLI fans out to concurrent agent invocations.

Context steps are automatically classified as per-item (foreach steps matching the same source) vs shared (non-foreach steps). The agent receives `_item` (the current project) plus its per-item data and all shared data.

---

## 6. Composition Patterns

How blocks combine into complete recipes. Each pattern is a proven arrangement from the recipe registry.

### Full Project Profile

For user-specified projects requiring comprehensive per-project data.

```
SPECIFIED_PROJECTS → PER_PROJECT_SIGNALS + NARRATIVE_ARC + MOMENTUM_HISTORY + CLUSTERS + MARKET_CONTEXT
```

Optionally add: PRICE_HISTORY, TOKEN_UNLOCKS, TOKEN_SECURITY, PARALLEL_AGENT_GATE.

Hints: `combine: [projects, signals, narrative, momentum], key: "id", include: [clusters, market_context]`

Examples: project_deep_dive, project_assessment, project_comparison, portfolio_check, project_snapshot

### Discovery with Selective Drill-Down

Start broad, use an agent to pick targets, then enrich the picks.

```
SURGING_PROJECTS + BROAD_SIGNALS → AGENT_GATE → NARRATIVE_ARC (on picks) + CLUSTERS + MARKET_CONTEXT
```

The agent gate creates a segment boundary. Pre-gate steps scan broadly (10-15 projects). Post-gate steps enrich only 2-3 picks. This focuses token budget on high-signal candidates.

Examples: signal_scanner, trade_scanner, daily_digest

### Signal-First Discovery

Signals determine which projects matter, not a momentum or popularity ranking.

```
BROAD_SIGNALS → DERIVED_PROJECTS → AGENT_GATE → MOMENTUM_HISTORY + PER_PROJECT_SIGNALS + NARRATIVE_ARC + CLUSTERS + MARKET_CONTEXT
```

Unique property: the project set is discovered from signal data (`{signals.data[*].projectId}`), not fetched directly. The agent then filters this signal-derived set.

Examples: smart_money_filter, drama

### Multi-Project Discovery + Parallel Agent

Broad discovery with per-project parallel analysis.

```
SURGING_PROJECTS + PER_PROJECT_SIGNALS + NARRATIVE_ARC + MOMENTUM_HISTORY + CLUSTERS + MARKET_CONTEXT + [PRICE_HISTORY] + [TOKEN_SECURITY] → PARALLEL_AGENT_GATE
```

No single-agent gate — all projects get full enrichment and independent agent analysis. Higher token budget but produces structured per-project assessments that the final analysis synthesizes.

Examples: catalyst_scanner, momentum_decay, narrative_revival, sentiment_tracker, under_the_radar

### Dual-List Divergence

Compare two different project rankings to find gaps and overlaps.

```
SURGING_PROJECTS + POPULAR_PROJECTS + BROAD_SIGNALS + MOMENTUM_HISTORY + CLUSTERS + MARKET_CONTEXT
```

Two project sets side by side. The analysis looks for divergence: projects surging but not popular (emerging), popular but not surging (fading), or appearing in both (established and growing).

Examples: sentiment_tracker

### Lightweight Scan

Minimal context for focused assessments.

```
SURGING_PROJECTS (or POPULAR_PROJECTS) + PER_PROJECT_SIGNALS + MOMENTUM_HISTORY + CLUSTERS
```

No market context, no narrative arc, no external enrichment. Just current state. Lowest token budget (~25-30K).

Examples: surge_analysis, risk_scan, chain_scanner, narrative_tracker, daily_market_insights

### Market Overview + Agent-Driven Enrichment

Broad scan with agent selecting targets for deeper context.

```
SURGING_PROJECTS + BROAD_SIGNALS + PRICE_HISTORY → AGENT_GATE → NARRATIVE_ARC (on picks) + CLUSTERS + MARKET_CONTEXT
```

Similar to Discovery with Selective Drill-Down but starts with price history on all projects before the agent gate. The agent uses price context to make better selections.

Examples: daily_digest

---

## 7. Worked Examples

Two recipes illustrating core patterns. The registry has 22 more — `aixbt recipe list` to browse, `aixbt recipe show <name>` to dump full YAML.

### Project Deep Dive — Parallel Agent + requiredOneOf

Full profile pattern with `requiredOneOf` params, multi-step per-project enrichment, and parallel agent gate. The agent step fans out per-project with per-item vs shared context classification. Condensed from the registry version (`aixbt recipe show project_deep_dive` for full instructions).

```yaml
name: project_deep_dive
version: "1.0"
estimatedTokens: 32000
description: |
  Extended multi-section analysis with 90-day price history and full narrative arc.
  - Use when building a thesis or doing comprehensive research on a project.

params:
  projectIds: { type: string, description: "Comma-separated project IDs" }
  tickers: { type: string, description: "Comma-separated ticker symbols (e.g. SOL,ETH)" }
  names: { type: string, description: "Comma-separated project names" }
  address: { type: string, description: "Token contract address" }
requiredOneOf: [projectIds, tickers, names, address]

steps:
  - id: projects
    action: projects
    params:
      projectIds: "{params.projectIds}"
      tickers: "{params.tickers}"
      names: "{params.names}"
      address: "{params.address}"
    transform:
      select: [id, name, description, xHandle, momentumScore, popularityScore, metrics, tokens, coingeckoData, createdAt, reinforcedAt]

  - id: narrative
    foreach: projects.data
    action: signals
    params:
      projectIds: "{item.id}"
      detectedAfter: "-30d"
    transform:
      sample: { tokenBudget: 50000, guaranteePercent: 0.3 }
      select: [description, detectedAt]

  - id: signals
    foreach: projects.data
    action: signals
    params:
      projectIds: "{item.id}"
      reinforcedAfter: "-48h"
    transform:
      sample: { tokenBudget: 50000, guaranteeCount: 30 }
      select: [id, detectedAt, reinforcedAt, description, projectName, projectId, category, hasOfficialSource, clusters]

  - id: momentum
    foreach: projects.data
    action: momentum
    params:
      id: "{item.id}"
      start: "-30d"
      includeClusters: "false"

  - id: surging_rankings            # shared reference — not per-project
    action: projects
    params: { limit: 25, sortBy: momentumScore, excludeStables: true }
    transform:
      select: [id, name, momentumScore]

  - id: clusters                    # shared reference
    action: clusters

  - id: price_history
    foreach: projects.data
    action: price-history
    source: coingecko
    params:
      network: "{item.tokens[0].chain}"
      address: "{item.tokens[0].address}"
      geckoId: "{item.coingeckoData.apiId}"
      timeframe: day
      limit: 90
    fallback: "Look up 90-day price data for this project."

  - id: project_analyses
    type: agent
    foreach: projects.data          # parallel — one agent per project
    context: [narrative, signals, momentum, price_history, surging_rankings, clusters]
    instructions: |
      Produce investment research on this project. You have:
      - _item: project metadata (name, metrics, coingeckoData, tokens)
      - narrative, signals, momentum, price_history: per-project data
      - surging_rankings, clusters: shared reference data
      Write a structured report: Narrative Arc, Fundamental Assessment,
      Momentum Assessment, Market Context, Key Risks, Thesis.
    returns:
      projectId: "string"
      projectName: "string"
      thesis: "string"
      analysis: "string"

hints:
  combine: [projects, signals, momentum, narrative, price_history]
  key: "id"
  include: [surging_rankings, clusters, project_analyses]

analysis:
  instructions: |
    Present per-project research reports from parallel agents. Add
    cross-project synthesis if multiple projects: sector overlap,
    momentum phase alignment, cluster overlap, narrative convergence.
  output: |
    Detailed research report per project, plus cross-project
    synthesis if applicable.
```

```bash
aixbt recipe run project_deep_dive --tickers SOL
aixbt recipe run project_deep_dive --names "solana,ethereum"
```

### Trade Scanner — Discovery with Agent Gate

Discovery pattern using an agent to select drill-down targets. Demonstrates the segment boundary: post-gate foreach uses `picks.projectIds`. Includes hourly price candles and CoinGecko enrichment.

```yaml
name: trade_scanner
version: "1.0"
estimatedTokens: 25000
description: |
  Trade candidates with signal-backed catalysts and directional bias.
  - Use when looking for active trade setups with specific entry reasoning.

params:
  chain:
    type: string
    required: false
    description: "Filter to a specific blockchain"

steps:
  - id: surging
    action: projects
    params:
      limit: 10
      sortBy: momentumScore
      excludeStables: true
      chain: "{params.chain}"
    transform:
      select: [id, name, description, xHandle, momentumScore, popularityScore, metrics, tokens, coingeckoData, createdAt, reinforcedAt]

  - id: signals
    foreach: surging.data
    action: signals
    params:
      projectIds: "{item.id}"
      reinforcedAfter: "-48h"
    transform:
      sample:
        tokenBudget: 50000
        guaranteeCount: 30
      select: [id, detectedAt, reinforcedAt, description, projectName, projectId, category, hasOfficialSource, clusters]

  - id: momentum
    foreach: surging.data
    action: momentum
    params:
      id: "{item.id}"
      start: "-7d"
      includeClusters: "false"

  - id: price_history
    foreach: surging.data
    action: price-history
    source: coingecko
    params:
      network: "{item.tokens[0].chain}"
      address: "{item.tokens[0].address}"
      geckoId: "{item.coingeckoData.apiId}"
      timeframe: hour
      limit: 168
    fallback: "Look up 7-day hourly price data for this project."

  # --- Segment boundary ---
  - id: picks
    type: agent
    context: [surging, signals, price_history]
    instructions: |
      Identify 2-3 projects with strongest trade setup potential —
      fresh catalysts, expanding cluster engagement, recent
      signal reinforcement. Return project IDs.
    returns:
      projectIds: "string[]"

  - id: narrative
    foreach: picks.projectIds
    action: signals
    params:
      projectIds: "{item}"
      detectedAfter: "-30d"
    transform:
      sample:
        tokenBudget: 50000
        guaranteePercent: 0.3
      select: [description, detectedAt]

  - id: clusters
    action: clusters

  - id: market_context
    action: projects
    params:
      projectIds: "66f4fdc76811ccaef955de3e,66f4fe366811ccaef955dfc7"
    transform:
      select: [id, name, metrics, coingeckoData]

hints:
  combine: [surging, signals, momentum, narrative, price_history]
  key: "id"
  include: [clusters, market_context]

analysis:
  instructions: |
    Surface trade candidates with signal-backed catalysts. For each
    surging project, check tradeability: fresh catalyst with price lag,
    momentum acceleration, multi-cluster convergence, or crowded/late
    signal. Determine directional bias (LONG / SHORT / EVENT-DRIVEN).
    Use 7-day hourly candles to map signal timestamps against price.
    BTC/ETH context for correlation risk.
  output: |
    Trade candidates ranked by freshness and conviction. For each:
    name, directional bias, narrative catalyst, signal freshness,
    momentum phase, cluster conviction, price context, risk factors.
```

```bash
aixbt recipe run trade_scanner
aixbt recipe run trade_scanner --chain solana
```
