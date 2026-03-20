# Recipe Specification

Formal YAML schema reference for `@aixbt/cli` recipes (v1.1).

## 1. Overview

A **recipe** is a declarative YAML file that defines a multi-step data pipeline. Recipes fetch data from the AIXBT API (and optionally external providers for enrichment), iterate over results, apply transforms to control output size, and yield execution to agents for inference. The CLI handles all deterministic work — the recipe author defines *what* data to gather and *when* to involve an agent.

## 2. Recipe Structure

Top-level fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Recipe identifier |
| `version` | string | no | Recipe version (defaults to `"1.0"`, number also accepted and coerced to string) |
| `description` | string | no | Human-readable description (defaults to `""`) |
| `estimatedTokens` | number \| null | no | Author estimate of output token count. Informational only. |
| `params` | object | no | Parameter definitions (see [Parameters](#3-parameters)) |
| `requiredOneOf` | string[] | no | Exactly one of these params must be provided (see [Parameters](#3-parameters)) |
| `steps` | array | **yes** | Step definitions — must be non-empty |
| `hints` | object | no | Structural hints for data consumers (see [Hints](#hints)) |
| `analysis` | object | no | Analysis instructions for the consuming agent (see [Analysis](#analysis)) |

Minimal valid recipe:

```yaml
name: example
version: "1.0"
steps:
  - id: projects
    action: projects
    params:
      limit: 5
```

## 3. Parameters

Runtime parameters, provided via `--<name> <value>` flags:

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `"string"` \| `"number"` \| `"boolean"` | yes | Parameter data type |
| `required` | boolean | no | Whether the caller must provide this parameter |
| `description` | string | no | Human-readable description |
| `default` | string \| number \| boolean | no | Default value if not provided |

Parameters are referenced in steps via `{params.<name>}`. A required parameter with no default causes an error if omitted. Template resolution skips params that were not provided — `"{params.tickers}"` resolves to nothing if `--tickers` was not passed, so the API param is omitted from the request.

```yaml
params:
  chain:
    type: string
    required: true
    description: Blockchain to scan
  limit:
    type: number
    default: 10
```

### `requiredOneOf`

For params where the user must provide exactly one of several alternatives, use `requiredOneOf` at the top level:

```yaml
params:
  projectIds: { type: string, description: "Comma-separated project IDs" }
  tickers: { type: string, description: "Comma-separated ticker symbols (e.g. SOL,ETH)" }
  names: { type: string, description: "Comma-separated project names" }
  address: { type: string, description: "Token contract address" }
requiredOneOf: [projectIds, tickers, names, address]
```

**Rules:**
- The list must contain at least 2 param names
- Each name must be a defined param
- Params in the list must not have `required: true` (conflicts with oneOf semantics)
- At runtime, zero provided → error. Two or more provided → error.

The step passes all params through; template resolution skips the ones not provided:

```yaml
- id: projects
  action: projects
  params:
    projectIds: "{params.projectIds}"
    tickers: "{params.tickers}"
    names: "{params.names}"
    address: "{params.address}"
```

```bash
aixbt recipe run project_deep_dive --tickers SOL
aixbt recipe run project_deep_dive --names "solana"
aixbt recipe run project_deep_dive --address 0x...
```

## 4. Step Types

### API Steps

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `action` | string | yes | Action name (e.g., `projects`, `signals`, `price`) |
| `source` | string | no | Provider name. Defaults to `"aixbt"`. |
| `params` | object | no | Parameters with template support |
| `transform` | TransformBlock | no | Transform applied to the response data |
| `fallback` | string | no | Message for agent when step is skipped due to missing/insufficient provider key |

```yaml
- id: projects
  action: projects
  params:
    limit: 10
    sortBy: momentumScore

- id: prices
  action: price
  source: coingecko
  params:
    ids: bitcoin,ethereum
  fallback: "Use publicly available price data instead."
```

### Foreach Steps

Iterate over an array, executing an action for each item.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `foreach` | string | yes | Bare reference to an array (no braces) |
| `action` | string | yes | Action name |
| `source` | string | no | Provider name. Defaults to `"aixbt"`. |
| `params` | object | no | Parameters — may use `{item}` and `{item.field}` |
| `transform` | TransformBlock | no | Transform applied **per iteration** |
| `fallback` | string | no | Message for agent when items fail |

The `foreach` value is a **bare reference** (no curly braces) to an array-valued step result.

```yaml
- id: momentum
  foreach: projects.data
  action: momentum
  params:
    id: "{item.id}"
    start: "-7d"
    includeClusters: "false"
```

When individual items fail in a foreach with `fallback`, those items degrade gracefully instead of failing the step. See [Fallback Mechanism](#6-fallback-mechanism).

### Agent Steps

Yield execution to an external agent for inference, analysis, or decision-making.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `type` | `"agent"` | yes | Literal string identifying this as an agent step |
| `context` | string[] | yes | Step IDs whose data to include |
| `instructions` | string | yes | Detailed instructions for the agent |
| `returns` | object | yes | Map of field names to type strings |
| `foreach` | string | no | If present, creates a parallel agent step (see below) |

Pauses execution and yields to an external agent. The `returns` type strings: `"string"`, `"number"`, `"boolean"`, `"string[]"`, `"object"`.

```yaml
- id: picks
  type: agent
  context:
    - recent_signals
    - top_projects
    - clusters
  instructions: |
    Select 3-5 projects with the strongest recent signal activity.
    Focus on projects with rising momentum and multiple signal reinforcements.
  returns:
    projectIds: "string[]"
    rationale: "string"
```


### Parallel Agent Steps

An agent step with a `foreach` field creates a **fan-out pattern** — the agent receives all the data but is told to process it per-item.

```yaml
- id: analyze
  type: agent
  foreach: projects.data
  context:
    - projects
    - momentum
    - signals
  instructions: |
    For each project, analyze its momentum trajectory and signal activity.
    Produce a brief assessment of risk and opportunity.
  returns:
    assessment: "string"
    risk_level: "string"
```

### Transform Steps

Apply transforms to a previous step's data without making an API call.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique step identifier |
| `input` | string | yes | Reference to a prior step ID |
| `transform` | TransformBlock | yes | Transform block |

```yaml
- id: sampled_signals
  input: raw_signals
  transform:
    sample:
      tokenBudget: 25000
      guaranteePercent: 0.3
    select:
      - description
      - projectName
      - category
      - detectedAt
```

Transforms on foreach steps run **per-iteration**. Transform steps run **post-aggregation** — use them when you need to sample across a collected dataset.

## 5. Provider System

The `action`/`source` pair determines which provider handles a step.

### Source Resolution

| `source` value | Provider |
|---|---|
| omitted or `"aixbt"` | AIXBT API (default) |
| `"coingecko"` | CoinGecko / GeckoTerminal |
| `"defillama"` | DeFiLlama |
| `"goplus"` | GoPlus |

### Tier Requirements

Each action has a minimum tier (`free`, `demo`, or `pro`). If the configured key's tier is too low, the step degrades gracefully — add a `fallback` field to control the message the agent receives. See [Fallback Mechanism](#6-fallback-mechanism).


## 6. Fallback Mechanism

The `fallback` field on API and foreach steps provides graceful degradation when a provider key is missing or the tier is insufficient. The string you write becomes an instruction to the agent running the recipe, telling it what to do instead.

**API steps** — the agent receives a message prefixed with context:

```
Step "<id>" was skipped — no <source> API key configured — <your fallback text>
```

```yaml
- id: prices
  action: price
  source: coingecko
  params:
    ids: bitcoin,ethereum
  fallback: "Use publicly available price data instead."
```

The agent sees: `Step "prices" was skipped — no coingecko API key configured — Use publicly available price data instead.`

**Foreach steps** — items that succeed return data normally. Items that fail degrade gracefully, and the agent receives a collated note listing which items need alternative handling:

```
<your fallback text> for: <item1>, <item2>, <item3>
```

```yaml
- id: tvl
  foreach: projects.data
  action: protocol
  source: defillama
  params: { protocol: "{item.name}" }
  fallback: "Look up TVL data using available tools."
```

If 3 of 10 items fail, the agent sees: `Look up TVL data using available tools for: Uniswap, Aave, Compound`

Without `fallback`, a provider *unavailability* (missing key, tier too low) still degrades gracefully rather than failing the recipe, but you lose control over the instruction.


## 7. Transforms

Transforms reduce and reshape data before it reaches agents, controlling token consumption.

### Transform Block

| Field | Type | Description |
|---|---|---|
| `select` | string[] | Field projection — keep only these fields |
| `sample` | SampleTransform | Weighted random sampling |

At least one of `select` or `sample` should be present (both can be used together).

**Execution order:** `sample` always runs **before** `select`. This ensures weight fields are available during sampling even if they're excluded from the final projection.

### Select

Selects specified fields from each item. Supports dot notation for nested fields.

```yaml
transform:
  select:
    - id
    - name
    - metrics.usd
    - metrics.volume
```

Produces: `{ id: "...", name: "...", metrics: { usd: ..., volume: ... } }` — nested structure is preserved.

### Sample

Weighted random sampling that controls output size by item count or token budget.

| Field | Type | Required | Description |
|---|---|---|---|
| `count` | number | no* | Fixed number of items to sample |
| `tokenBudget` | number | no* | Approximate token budget for the sampled output |
| `guaranteePercent` | number | no | Fraction (0-1) of top-weighted items always included (default: 0.3) |
| `guaranteeCount` | number | no | Fixed number of top-weighted items always included |
| `weight_by` | string | no | Field path for custom weights (dot notation supported) |

**Rules:**
- At least one of `count` or `tokenBudget` is required
- If both are specified, `count` takes precedence
- `guaranteePercent` and `guaranteeCount` are **mutually exclusive**
- Guaranteed items are selected first (top by weight), then remaining slots are filled by weighted random sampling without replacement
- Default weighting (when `weight_by` is omitted): favors recent, high-activity items

```yaml
transform:
  sample:
    tokenBudget: 25000
    guaranteePercent: 0.3
    weight_by: momentumScore
  select:
    - id
    - name
    - description
    - momentumScore
```

## 8. Variable Templating

Template expressions use `{...}` syntax and are resolved in `action`, `params`, `foreach`, `fallback`, and `analysis` fields. They are **not** resolved in `hints` (passed through verbatim).

### Expression Reference

| Expression | Resolves to |
|---|---|
| `{params.name}` | Value of recipe parameter `name` |
| `{step_id}` | Step result data (shorthand for `{step_id.data}`) |
| `{step_id.data}` | Step result data (explicit) |
| `{step_id.field}` | Shorthand for `{step_id.data.field}` |
| `{step_id.data.nested.path}` | Nested field access |
| `{step_id.data[*].field}` | Pluck: extract `field` from every array item |
| `{step_id[*].field}` | Shorthand pluck (equivalent to above) |
| `{item}` | Current foreach iteration item |
| `{item.field}` | Property of the current foreach item |

### Relative Time Expressions

Bare relative time strings are converted to ISO 8601 timestamps at execution time:

| Expression | Meaning |
|---|---|
| `-30m` | 30 minutes ago |
| `-24h` | 24 hours ago |
| `-7d` | 7 days ago |

```yaml
params:
  detectedAfter: "-48h"                    # direct — resolved at execution
  start: "{params.lookback}"               # template — if lookback="-7d", resolved to ISO timestamp
```

### Type Preservation

When an entire param value is a single template expression (`"{step_id.field}"`), the resolved type is preserved (arrays stay arrays, numbers stay numbers). When the expression is part of a larger string (`"prefix {value} suffix"`), it's interpolated as a string.

## 9. Segment Boundary Rule

Recipes are divided into **segments** by agent steps. This is the most important structural constraint to understand when writing recipes.

### How segments work

```
Segment 0:  [api_step_1] → [foreach_step] → [agent_step_1]
                                                  | yield
Segment 1:  [api_step_2] → [api_step_3]
             ^ can access: agent_step_1 output + own segment steps
             x cannot access: api_step_1, foreach_step
```

An agent step **ends** a segment. The next segment begins after the agent step, and can access:

1. The preceding agent step's output (the `returns` data provided at resume)
2. Steps within its own segment that precede it

It **cannot** access steps from earlier segments (before the agent step). This is enforced at parse time.

## 10. Hints and Analysis Blocks

### Hints

Passed through verbatim to the consuming agent — the CLI does not act on hints. They tell the agent how to interpret the data.

| Field | Type | Description |
|---|---|---|
| `combine` | string[] | Step IDs whose data represents the same entities |
| `key` | string | Shared field that relates the combined datasets |
| `include` | string[] | Step IDs to include as reference data alongside combined |

```yaml
hints:
  combine:
    - projects
    - momentum
  key: id
  include:
    - clusters
```

### Analysis

Instructions for the consuming agent's final analysis. Template expressions (`{params.*}`) are resolved at execution time.

| Field | Type | Description |
|---|---|---|
| `instructions` | string | Main analysis instructions |
| `output` | string | Output format directive |

```yaml
analysis:
  instructions: |
    Analyze the momentum patterns for {params.chain} projects.
    Focus on divergences between momentum score and price action.
  output: markdown
```


## 11. Recipe Writing Guide

### Composition patterns

**Single-segment (no agent):** Pure data pipeline. All steps execute and the result is returned directly. Good for data collection and enrichment without inference.

```yaml
steps:
  - id: protocols
    action: protocols
    source: defillama
    transform:
      sample:
        count: 20
      select: [name, tvl, chain, category]
  - id: chains
    action: chains
    source: defillama
```

**Agent gate (two segments):** Broad data fetch → agent picks → deep enrichment on picks. The most common pattern.

```yaml
steps:
  # Segment 0: broad scan
  - id: signals
    action: signals
    params: { reinforcedAfter: "-48h", limit: 50 }
  - id: top_projects
    action: projects
    params: { limit: 10, sortBy: momentumScore }
  - id: picks
    type: agent
    context: [signals, top_projects]
    instructions: "Select 3-5 standout projects..."
    returns: { projectIds: "string[]" }
  # Segment 1: targeted enrichment
  - id: details
    action: projects
    params: { projectIds: "{picks.projectIds}" }
  - id: narrative
    foreach: details.data
    action: signals
    params:
      projectIds: "{item.id}"
      detectedAfter: "-30d"
    transform:
      sample: { tokenBudget: 25000, guaranteePercent: 0.3 }
      select: [description, detectedAt, category]
```

**Multi-provider enrichment:** Combine AIXBT data with external providers in a single pipeline.

```yaml
steps:
  - id: projects
    action: projects
    params: { limit: 10, hasToken: "true" }
  - id: tvl
    foreach: projects.data
    action: protocol
    source: defillama
    params: { protocol: "{item.name}" }
    fallback: "TVL data unavailable for this project."
    transform:
      select: [name, tvl, chainTvls]
```

## Appendix: Validation

Run `aixbt recipe validate <file>` to check a recipe for errors without executing it.
