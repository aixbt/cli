# AIXBT CLI Recipe Specification

> Formal specification for recipe YAML files in `@aixbt/cli`.
> Version: 1.1 | Last updated: 2026-03-09

## Table of Contents

- [Overview](#overview)
- [Recipe Structure](#recipe-structure)
- [Parameters](#parameters)
- [Step Types](#step-types)
  - [API Steps](#api-steps)
  - [Foreach Steps](#foreach-steps)
  - [Agent Steps](#agent-steps)
  - [Transform Steps](#transform-steps)
- [Auto-Pagination](#auto-pagination)
- [Transforms](#transforms)
  - [Transform Block](#transform-block)
  - [Select](#select)
  - [Sample](#sample)
  - [Execution Order](#execution-order)
  - [Transforms on Foreach Steps](#transforms-on-foreach-steps)
- [Variable Templating](#variable-templating)
- [Segment Boundary Rule](#segment-boundary-rule)
- [Agent Step Contract](#agent-step-contract)
- [Output Block](#output-block)
- [Analysis Block](#analysis-block)
- [Completion Output](#completion-output)
- [Full Example](#full-example)

---

## Overview

A **recipe** is a declarative YAML file that defines a multi-step data pipeline against the AIXBT API. Recipes orchestrate API calls, iterate over results, and yield execution to external agents for inference tasks. The CLI executes the deterministic parts (HTTP requests, data routing, template resolution) and delegates reasoning to agents via a structured yield/resume protocol.

Recipes fit into the AIXBT ecosystem as the bridge between raw API access and agent-driven analysis. An agent (or human) authors a recipe to define *what data to collect* and *what to do with it*, then the CLI handles the mechanics of fetching, paginating, rate-limiting, and marshalling that data.

Key design principles:

- **Stateless execution** -- the CLI re-parses the entire YAML on every invocation, including resume. No server-side session state.
- **The CLI never calls an LLM** -- it provides data and framing; the agent brings inference.
- **Structured I/O** -- all CLI output is machine-readable JSON, designed for agent consumption.

---

## Recipe Structure

A recipe is a YAML document with the following top-level fields:

| Field         | Type     | Required | Description                              |
|---------------|----------|----------|------------------------------------------|
| `name`        | string   | yes      | Recipe identifier                        |
| `version`     | string   | yes      | Recipe version (also accepts a number, coerced to string) |
| `description` | string   | yes      | Human-readable description               |
| `tier`        | string   | no       | Access tier (e.g., `"pro"`, `"free"`)    |
| `params`      | object   | no       | Parameter definitions                    |
| `steps`       | array    | yes      | Step definitions (must be non-empty)     |
| `output`      | object   | no       | Output configuration                     |
| `analysis`    | object   | no       | Analysis instructions for the agent      |

Minimal valid recipe:

```yaml
name: minimal-example
version: "1.0"
description: Fetch recent signals
steps:
  - id: signals
    endpoint: "GET /v2/signals"
```

---

## Parameters

The `params` block defines named parameters that recipe consumers must (or may) provide at invocation time. Parameters are passed as CLI flags: `--chain solana --limit 50`.

### Parameter Definition

Each key in `params` is a parameter name. Each value is an object with:

| Field         | Type                       | Required | Description                         |
|---------------|----------------------------|----------|-------------------------------------|
| `type`        | `"string"` \| `"number"` \| `"boolean"` | yes | Parameter data type        |
| `required`    | boolean                    | no       | Whether the parameter must be provided |
| `description` | string                     | no       | Human-readable description          |
| `default`     | string \| number \| boolean | no      | Default value if not provided       |

A parameter with `required: true` and no `default` will cause a validation error if omitted.

### Example

```yaml
params:
  chain:
    type: string
    required: true
    description: "Blockchain to filter by"
  limit:
    type: number
    default: 50
    description: "Maximum number of results"
  include_inactive:
    type: boolean
    default: false
```

### Usage in Templates

Parameters are referenced in step fields using `{params.<name>}`:

```yaml
steps:
  - id: projects
    endpoint: "GET /v2/projects"
    params:
      chain: "{params.chain}"
      limit: "{params.limit}"
```

---

## Step Types

Every step must have a unique `id` (string). The step type is determined by which fields are present:

- `type: "agent"` -- agent step
- `foreach` field -- foreach step
- `input` field (no `endpoint`) -- transform step
- Otherwise -- API step (must have `endpoint`)

### API Steps

Standard HTTP API calls against the AIXBT API.

| Field       | Type           | Required | Description                                    |
|-------------|----------------|----------|------------------------------------------------|
| `id`        | string         | yes      | Unique step identifier                         |
| `endpoint`  | string         | yes      | Format: `"METHOD /path"` or `"/path"` (defaults to GET) |
| `params`    | object         | no       | Query parameters with template support         |
| `transform` | TransformBlock | no       | Transform block applied to the response data   |

The `endpoint` string is parsed into an HTTP method and path. If no method prefix is given, GET is assumed.

```yaml
# Explicit method
- id: projects
  endpoint: "GET /v2/projects"
  params:
    chain: "{params.chain}"
    limit: 50

# Implicit GET
- id: signals
  endpoint: "/v2/signals"
  params:
    since: "-24h"
```

Query parameter values support template expressions (`{params.chain}`) and relative time expressions (`-24h`, `-7d`, `-30m`).

### Foreach Steps

Iterate over array data from a previous step, making one API call per item.

| Field       | Type           | Required | Description                                              |
|-------------|----------------|----------|----------------------------------------------------------|
| `id`        | string         | yes      | Unique step identifier                                   |
| `foreach`   | string         | yes      | Bare reference to array data (no braces)                 |
| `endpoint`  | string         | yes      | Endpoint with `{item}` or `{item.field}` references      |
| `params`    | object         | no       | Query parameters with template and `{item}` support      |
| `transform` | TransformBlock | no       | Transform block applied per iteration (see [Transforms on Foreach Steps](#transforms-on-foreach-steps)) |

**Important: the `foreach` field uses a bare reference (no curly braces), while `endpoint` and `params` values use braces for template expressions.**

The `foreach` value points to an array from a previous step's result. Common patterns:

- `step_id.data` -- iterate over the step's data (when data is an array)
- `step_id.data[*].field` -- pluck a field from each item, then iterate over those values

Within the step's `endpoint` and `params`, use `{item}` to reference the current iteration value, or `{item.field}` to access a nested property.

```yaml
# Iterate over project data, fetch details for each
- id: details
  foreach: "projects.data"
  endpoint: "GET /v2/projects/{item.id}"

# Pluck IDs first, then use them
- id: enriched
  foreach: "projects.data[*].id"
  endpoint: "GET /v2/projects/{item}/enrichment"

# With params referencing the current item
- id: project_signals
  foreach: "projects.data"
  endpoint: "GET /v2/signals"
  params:
    projectId: "{item.id}"
    since: "-7d"
```

The CLI automatically manages concurrency and rate limiting for foreach iterations. Items are processed in batches, with batch size derived from the current rate limit state.

### Agent Steps

Yield execution to an external agent for inference, analysis, or decision-making.

| Field         | Type     | Required | Description                                    |
|---------------|----------|----------|------------------------------------------------|
| `id`          | string   | yes      | Unique step identifier                         |
| `type`        | `"agent"`| yes      | Literal string identifying this as an agent step |
| `context`     | string[] | yes      | List of step IDs whose data to include         |
| `task`        | string   | yes      | Short description of what the agent should do  |
| `description` | string   | yes      | Detailed instructions for the agent            |
| `returns`     | object   | yes      | Map of field names to type strings             |

Agent steps do not make API calls. When the CLI reaches an agent step, it halts execution and emits a `RecipeAwaitingAgent` JSON payload containing the collected data from the referenced context steps. The agent processes the data externally and resumes execution by providing the expected return values.

The `returns` object defines the schema the agent must satisfy. Keys are field names, values are type strings:

- `"string"` -- a string value
- `"number"` -- a numeric value
- `"boolean"` -- a boolean value
- `"string[]"` -- an array of strings
- `"object"` -- a JSON object

```yaml
- id: analyze
  type: agent
  context:
    - projects
    - details
  task: "Analyze project data for trends"
  description: |
    Review the project data and detail enrichments.
    Identify emerging trends, notable outliers, and
    any projects showing unusual activity patterns.
  returns:
    summary: string
    insights: "string[]"
    confidence: number
```

### Transform Steps

Reshape data from a previous step without making an API call.

| Field       | Type           | Required | Description                                         |
|-------------|----------------|----------|-----------------------------------------------------|
| `id`        | string         | yes      | Unique step identifier                              |
| `input`     | string         | yes      | Reference to a prior step ID                        |
| `transform` | TransformBlock | yes      | Transform block (at least `select` or `sample`)     |

A transform step reads data from the step referenced by `input` and applies transforms to produce a new result. It cannot have `endpoint` or `foreach`.

```yaml
steps:
  - id: signals
    endpoint: /v2/signals
    params:
      limit: 150

  - id: filtered
    input: signals
    transform:
      sample:
        count: 80
      select: [id, name, category]
```

Transform steps are accessible by subsequent steps via standard step references, just like API or foreach steps. They participate in the same segment boundary rules -- the `input` reference must point to an accessible step within the current segment.

---

## Auto-Pagination

When an API step specifies a `limit` greater than 50, the engine automatically paginates by making multiple API calls and concatenating the results. This is transparent to the recipe author.

```yaml
steps:
  - id: signals
    endpoint: /v2/signals
    params:
      limit: 150
      since: "-24h"
```

In this example, the engine makes 3 internal API calls (each requesting 50 items) and concatenates the `data[]` arrays into a single result of up to 150 items.

**Behavior details:**

- The API's maximum per-page limit is 50. When `limit` exceeds 50, the engine splits the request into pages of 50.
- Results from each page are concatenated into a single `data[]` array.
- Pagination stops when the API reports no more data (`hasMore: false`) or the target limit is reached.
- Rate limits are respected between page requests.
- If a `transform` block is present on the step, transforms apply after pagination completes -- they operate on the full concatenated result, not individual pages.

**No pagination (single call):**

When `limit` is 50 or less (or not specified), the engine makes a single API call as usual. No pagination logic is triggered.

---

## Transforms

Transforms reduce and reshape step result data. A `transform` block can appear on API steps, foreach steps, and standalone transform steps.

### Transform Block

The `transform` block contains one or both of `select` and `sample`:

```yaml
steps:
  - id: signals
    endpoint: /v2/signals
    params:
      limit: 50
    transform:
      select: [id, name, category, metrics.usd]
      sample:
        count: 30
        guarantee: 0.3
```

| Field    | Type           | Required | Description                                    |
|----------|----------------|----------|------------------------------------------------|
| `select` | string[]       | no       | Field paths for projection                     |
| `sample` | SampleTransform | no      | Weighted random sampling configuration         |

At least one of `select` or `sample` must be present in a transform block.

### Select

The `select` field specifies which fields to keep from each item in the result data. It acts as a projection, stripping all fields not listed.

```yaml
transform:
  select: [id, name, category, metrics.usd, metrics.volume]
```

**Supported patterns:**

- **Top-level fields**: `[id, name]` keeps only those top-level properties.
- **Dot notation for nested fields**: `[metrics.usd]` keeps the nested path `{ metrics: { usd: ... } }`.
- **Multiple nested fields from the same parent**: `[metrics.usd, metrics.volume]` merges into `{ metrics: { usd: ..., volume: ... } }`.
- **Arrays**: Arrays are preserved as-is when their parent field is selected.
- **Missing fields**: If a listed field does not exist on an item, it is silently omitted from the output.

### Sample

The `sample` field configures weighted random sampling to reduce the result set size while preserving the most relevant items.

```yaml
transform:
  sample:
    count: 30
    guarantee: 0.3
    weight_by: metrics.score
```

| Field       | Type   | Required | Description                                                 |
|-------------|--------|----------|-------------------------------------------------------------|
| `count`     | number | no*      | Fixed number of items to sample                             |
| `maxTokens` | number | no*      | Token budget (estimated as `JSON.stringify(item).length / 4`) |
| `guarantee` | number | no       | Fraction (0-1) of top items always included (default: 0.3)  |
| `weight_by` | string | no       | Field path for custom weights (dot notation supported)      |

*At least one of `count` or `maxTokens` is required. If both are specified, `count` takes precedence.

**How sampling works:**

1. If the total item count is less than or equal to the target count, all items are returned unchanged (passthrough).
2. The top `guarantee` fraction of items (by weight) are always included in the result.
3. The remaining slots are filled by weighted random sampling without replacement.
4. When `weight_by` is not set, default weights are calculated as `recencyWeight * strengthWeight`, where recency is based on item age and strength is based on activity count.
5. The original array order is preserved after sampling -- items appear in the same relative order as the input.

### Execution Order

Within a single transform block, `sample` always runs before `select`. This ordering is required because sampling may need access to fields that `select` would strip:

- Default weight calculation uses `activity.length` for strength weights
- Custom `weight_by` references a field path that might not be in the `select` list

```yaml
# sample runs first (needs metrics.score for weighting),
# then select strips down to the final fields
transform:
  sample:
    count: 30
    weight_by: metrics.score
  select: [id, name, category]
```

### Transforms on Foreach Steps

When a `transform` block appears on a foreach step, it runs **per iteration** -- each individual API response is transformed before results are aggregated.

```yaml
steps:
  - id: details
    foreach: "projects.data"
    endpoint: "GET /v2/projects/{item.id}"
    transform:
      select: [id, name, metrics.usd]
```

In this example, each project detail response is projected down to `[id, name, metrics.usd]` before being collected into the aggregated result.

For **post-aggregation transforms** (transforming the combined result of all iterations), use a separate transform step with `input`:

```yaml
steps:
  - id: details
    foreach: "projects.data"
    endpoint: "GET /v2/projects/{item.id}"

  - id: sampled_details
    input: details
    transform:
      sample:
        count: 20
      select: [id, name]
```

---

## Variable Templating

Template expressions use curly braces: `{expression}`. They are resolved at execution time.

### Expression Types

| Expression                   | Resolves to                                              |
|------------------------------|----------------------------------------------------------|
| `{params.name}`              | The value of recipe parameter `name`                     |
| `{step_id}`                  | The data from step `step_id`                             |
| `{step_id.data}`             | Same as `{step_id}` -- the data from the step result     |
| `{step_id.data.nested.path}` | Nested property access within the step's data            |
| `{step_id.data[*].field}`    | Pluck: extract `field` from every item in an array       |
| `{item}`                     | Current foreach iteration item                           |
| `{item.field}`               | Property of the current foreach item                     |

### Type Preservation

When an entire string value is a single template expression, the resolved type is preserved:

```yaml
# Resolves to whatever type params.limit is (number if provided as number)
limit: "{params.limit}"

# Resolves to the full array/object from the step
data: "{projects.data}"
```

When a template expression is embedded in a larger string, the result is always coerced to a string:

```yaml
# Always a string: "Project abc123"
label: "Project {item.id}"

# Always a string: "/v2/projects/abc123"
endpoint: "GET /v2/projects/{item.id}"
```

### Relative Time Expressions

Standalone string values matching the pattern `-<amount><unit>` are resolved to ISO 8601 timestamps relative to the current time:

| Expression | Meaning                |
|------------|------------------------|
| `-30m`     | 30 minutes ago         |
| `-24h`     | 24 hours ago           |
| `-7d`      | 7 days ago             |

```yaml
params:
  since: "-24h"    # Resolves to e.g. "2026-03-02T12:00:00.000Z"
  until: "-30m"    # Resolves to e.g. "2026-03-03T11:30:00.000Z"
```

Relative time expressions are resolved before template interpolation. They only apply to standalone string values, not to expressions embedded in templates.

---

## Segment Boundary Rule

Recipes are divided into **segments** by agent steps. A segment is a contiguous group of API/foreach steps terminated by an agent step (or the end of the recipe).

### The Rule

API and foreach steps can only reference data from:

1. Steps within their own segment (preceding them)
2. The preceding agent step's input (the agent step that starts the segment)

They **cannot** reference steps from earlier segments (before the preceding agent step).

This constraint is validated at parse time AND enforced at runtime. It exists to enable stateless yield/resume: when an agent resumes execution, only the agent's input and the current segment's data need to exist.

### Diagram

```
Segment 0:     [api_step_1] -> [foreach_step] -> [agent_step_1]
                                                      | yield
Segment 1:     [api_step_2] -> [api_step_3]
                ^ can access: agent_step_1 input + own segment data
                x cannot access: api_step_1, foreach_step (previous segment)
```

### Example

```yaml
steps:
  # --- Segment 0 ---
  - id: projects            # can access: nothing (first step)
    endpoint: "GET /v2/projects"

  - id: details             # can access: projects
    foreach: "projects.data"
    endpoint: "GET /v2/projects/{item.id}"

  - id: analyze             # agent step -- ends Segment 0
    type: agent
    context:
      - projects
      - details
    task: "Pick top projects"
    description: "Select the most promising projects"
    returns:
      selected_ids: "string[]"

  # --- Segment 1 (after resume) ---
  - id: deep_dive           # can access: analyze (preceding agent step)
    endpoint: "GET /v2/projects/{analyze.data.selected_ids}"
    # CANNOT reference: projects, details (Segment 0)
```

If a step in Segment 1 attempts to reference `projects` or `details`, the validator will reject the recipe with an error like:

```
Step "deep_dive" references "projects" which is not accessible in this segment.
Accessible steps: [analyze]
```

---

## Agent Step Contract

The yield/resume protocol defines how the CLI hands off to an agent and how the agent hands back.

### Yield: `RecipeAwaitingAgent`

When execution reaches an agent step, the CLI outputs a JSON object to stdout:

```json
{
  "status": "awaiting_agent",
  "recipe": "my-recipe",
  "version": "1.0",
  "step": "analyze",
  "task": "Analyze project data for trends",
  "description": "Review the project data and identify emerging trends...",
  "returns": {
    "summary": "string",
    "insights": "string[]"
  },
  "data": {
    "projects": [ ... ],
    "details": [ ... ]
  },
  "resumeCommand": "aixbt recipe run my-recipe.yaml --resume-from step:analyze --input '<agent_output_json>' --chain solana"
}
```

Field descriptions:

| Field           | Description                                                    |
|-----------------|----------------------------------------------------------------|
| `status`        | Always `"awaiting_agent"`                                      |
| `recipe`        | Recipe name from the YAML                                      |
| `version`       | Recipe version from the YAML                                   |
| `step`          | The agent step's `id`                                          |
| `task`          | The agent step's `task` string                                 |
| `description`   | The agent step's `description` string                          |
| `returns`       | The expected return schema (field names to type strings)        |
| `data`          | Object mapping context step IDs to their collected data        |
| `resumeCommand` | Pre-built CLI command to resume execution with agent output    |

The `data` object contains only the steps listed in the agent step's `context` array. Each key is a step ID, each value is that step's result data.

### Resume

The agent processes the data, calls its own LLM or logic, and resumes by invoking the CLI:

```bash
aixbt recipe run my-recipe.yaml \
  --resume-from step:analyze \
  --input '{"summary": "Strong DeFi momentum on Solana...", "insights": ["...", "..."]}' \
  --chain solana
```

Key details:

- `--resume-from step:<id>` identifies which agent step to resume from. The `step:` prefix is required.
- `--input '<json>'` provides the agent's output as a JSON string. It must satisfy the `returns` schema.
- All original recipe parameters (e.g., `--chain solana`) must be re-provided. The CLI is stateless.
- The recipe source (file path or registry name) must also be re-provided.

On resume, the CLI:

1. Re-parses the entire YAML from scratch
2. Validates the `--input` JSON matches the agent step's `returns` schema (checks required fields, validates array types)
3. Injects the agent's output as the result for that agent step
4. Continues execution from the next segment

If the `--input` is missing required fields or has type mismatches, the CLI exits with a validation error.

### Stdin Resume

If the original recipe was provided via `--stdin`, the resume command uses `--stdin` instead of a file path:

```bash
cat recipe.yaml | aixbt recipe run --stdin \
  --resume-from step:analyze \
  --input '{"summary": "..."}'
```

---

## Output Block

The optional `output` block describes how step results relate to each other. It is passed through verbatim in the `RecipeComplete` payload for consumers to interpret.

| Field      | Type     | Description                                              |
|------------|----------|----------------------------------------------------------|
| `combine`  | string[] | Step IDs whose data represents the same entities         |
| `key`      | string   | Shared field that relates the combined datasets           |
| `include`  | string[] | Step IDs to include as reference data alongside combined  |

The CLI does not combine or transform the data itself -- it passes these directives through so consumers can assemble the data as needed.

```yaml
output:
  combine:
    - projects
    - details
  key: "id"
  include:
    - projects
    - details
    - signals
```

---

## Analysis Block

The optional `analysis` block provides instructions for the agent that will consume the recipe's output. Like the output block, it is passed through verbatim.

| Field           | Type   | Description                              |
|-----------------|--------|------------------------------------------|
| `instructions`  | string | High-level analysis instructions         |
| `context`       | string | Additional context for the agent         |
| `task`          | string | Specific task to perform                 |
| `output_format` | string | Desired output format                    |

```yaml
analysis:
  instructions: |
    Analyze the collected project data to identify emerging trends
    in the DeFi sector. Focus on TVL changes and new protocol launches.
  context: "Q1 2026 market conditions have been volatile"
  task: "Generate a trend report with actionable insights"
  output_format: "markdown"
```

The CLI does not interpret these fields. They appear in the `RecipeComplete` output for the agent to read and act on.

---

## Completion Output

When all steps finish (or all steps in the final segment after the last agent resume), the CLI outputs a `RecipeComplete` JSON object:

```json
{
  "status": "complete",
  "recipe": "my-recipe",
  "version": "1.0",
  "timestamp": "2026-03-03T12:00:00.000Z",
  "data": {
    "projects": [ ... ],
    "details": [ ... ],
    "signals": [ ... ]
  },
  "output": {
    "combine": ["projects", "details"],
    "key": "id",
    "include": ["projects", "details", "signals"]
  },
  "analysis": {
    "instructions": "Analyze the collected project data...",
    "task": "Generate a trend report"
  }
}
```

| Field       | Description                                                       |
|-------------|-------------------------------------------------------------------|
| `status`    | Always `"complete"`                                               |
| `recipe`    | Recipe name                                                       |
| `version`   | Recipe version                                                    |
| `timestamp` | ISO 8601 timestamp of completion                                  |
| `data`      | Object mapping step IDs to their result data                      |
| `output`    | The recipe's `output` block (if defined), passed through verbatim |
| `analysis`  | The recipe's `analysis` block (if defined), passed through verbatim |

### Output Directory Mode

When `--output-dir <path>` is provided, step data is written to individual JSON files instead of being inlined in the output:

```json
{
  "status": "complete",
  "recipe": "my-recipe",
  "version": "1.0",
  "timestamp": "2026-03-03T12:00:00.000Z",
  "data": {
    "projects": { "dataFile": "/tmp/output/segment-001.json" },
    "details": { "dataFile": "/tmp/output/segment-002.json" }
  }
}
```

This is useful for large datasets where inlining everything in a single JSON payload is impractical.

---

## Full Example

A complete working recipe demonstrating parameters, API steps with auto-pagination and transforms, foreach iteration, an agent step, a post-resume segment with a transform step, output configuration, and analysis instructions.

```yaml
name: chain-analysis
version: "1.1"
description: >
  Collect project data for a blockchain, enrich with details,
  have an agent select top projects, then fetch signals for those.

params:
  chain:
    type: string
    required: true
    description: "Blockchain to analyze (e.g., solana, ethereum)"
  limit:
    type: number
    default: 25
    description: "Number of projects to fetch"
  since:
    type: string
    default: "-7d"
    description: "How far back to look for signals"

steps:
  # --- Segment 0: Data Collection ---

  - id: projects
    endpoint: "GET /v2/projects"
    params:
      chain: "{params.chain}"
      limit: "{params.limit}"

  - id: details
    foreach: "projects.data"
    endpoint: "GET /v2/projects/{item.id}"
    transform:
      select: [id, name, category, metrics.usd, metrics.volume]

  - id: select
    type: agent
    context:
      - projects
      - details
    task: "Select top projects for deep analysis"
    description: |
      Review the project list and their enriched details.
      Select the top 5 most noteworthy projects based on:
      - Recent activity and momentum
      - Community engagement signals
      - Technical development indicators
      Return the selected project IDs and a brief rationale.
    returns:
      selected_ids: "string[]"
      rationale: string

  # --- Segment 1: Post-Agent Deep Dive ---

  # Auto-pagination: limit 150 triggers 3 pages of 50
  - id: signals
    foreach: "select.data.selected_ids"
    endpoint: "GET /v2/signals"
    params:
      projectId: "{item}"
      since: "{params.since}"
      limit: 150

  # Post-aggregation transform: sample down and project fields
  - id: top_signals
    input: signals
    transform:
      sample:
        count: 50
        guarantee: 0.3
      select: [id, name, category, metrics.usd]

output:
  include:
    - select
    - top_signals

analysis:
  instructions: |
    Synthesize the agent's project selection with the signal data.
    Produce a concise trend report covering:
    1. Key themes across selected projects
    2. Notable signals and what they indicate
    3. Risk factors and opportunities
  context: "Focus on actionable insights for crypto researchers"
  task: "Generate a chain analysis report"
  output_format: "markdown"
```

### Running This Recipe

**First run** (collects data, yields at agent step):

```bash
aixbt recipe run chain-analysis.yaml --chain solana --limit 25
```

Output: a `RecipeAwaitingAgent` JSON with project and detail data.

**Resume** (after agent processes and selects projects):

```bash
aixbt recipe run chain-analysis.yaml \
  --resume-from step:select \
  --input '{"selected_ids": ["proj_1", "proj_2", "proj_3"], "rationale": "Selected based on TVL growth..."}' \
  --chain solana --limit 25
```

Output: a `RecipeComplete` JSON with signal data for the selected projects, plus the output and analysis blocks.

### Validation

Validate a recipe without executing:

```bash
aixbt recipe validate chain-analysis.yaml
```

### Registry

Recipes can also be fetched from the AIXBT registry:

```bash
# List available recipes
aixbt recipe list

# Run a registry recipe by name
aixbt recipe run chain-analysis --chain solana

# Download a registry recipe to a local file
aixbt recipe clone chain-analysis
```
