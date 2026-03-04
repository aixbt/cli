# @aixbt/cli

> AIXBT intelligence from your terminal. Direct API commands and declarative recipe workflows.

[![npm version](https://img.shields.io/npm/v/@aixbt/cli)](https://www.npmjs.com/package/@aixbt/cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What is this?

`@aixbt/cli` is a command-line tool for the AIXBT v2 API. It provides:

- **Direct commands** that mirror API endpoints for projects, signals, and clusters
- **A recipe engine** that executes declarative YAML workflows combining multiple API calls
- **Agent integration** via a yield/resume pattern -- agents bring their own LLM, the CLI provides data and analytical framing
- **Dual output modes**: human-readable tables for terminal use, and `--json` for machine consumption

## Installation

```bash
npm install -g @aixbt/cli
```

Requires Node.js 18 or later.

## Quick Start

```bash
# 1. Get an API key at https://aixbt.tech

# 2. Authenticate
aixbt login

# 3. Start exploring
aixbt projects list
```

## Authentication

The CLI supports four access modes:

### API Key

The standard authentication method. Get a key at [aixbt.tech](https://aixbt.tech), then store it:

```bash
aixbt login
# Paste your API key when prompted
```

Or provide it non-interactively:

```bash
aixbt login --api-key sk-your-key-here
```

### Purchase Pass (x402)

Buy a time-limited pass with crypto via the x402 payment protocol:

```bash
aixbt login --purchase-pass 1d    # 1 day ($10)
aixbt login --purchase-pass 1w    # 1 week ($50)
aixbt login --purchase-pass 4w    # 4 weeks ($100)
aixbt login --purchase-pass 10c   # 10 calls ($0.10)
```

### Pay Per Use (x402)

Pay per API call without a subscription. Append `--pay-per-use` to any command:

```bash
aixbt --pay-per-use projects list
```

If payment is required, the CLI outputs payment details and a retry command with `--payment-signature`.

### Delayed / Free Tier

Access data delayed by 12-24 hours, no authentication needed:

```bash
aixbt --delayed projects list
```

### Resolution Order

The API key is resolved in this priority order:

1. `--api-key` flag (highest priority)
2. `AIXBT_API_KEY` environment variable
3. `~/.aixbt/config.json` (set by `aixbt login`)

## Command Reference

### projects

List, search, and inspect AIXBT-tracked projects.

```bash
# List projects (with filters)
aixbt projects [--page <n>] [--limit <n>] [--chain <chain>] [--address <address>]
               [--sort-by <field>] [--min-momentum <score>] [--has-token]
               [--exclude-stables] [--project-ids <ids>] [--names <names>]
               [--x-handles <handles>] [--tickers <tickers>]

# Get project details
aixbt projects <id>

# View momentum history
aixbt projects momentum <id> [--start <date>] [--end <date>]

# List available chains
aixbt projects chains
```

**Examples:**

```bash
# Top projects on Solana
aixbt projects --chain solana --sort-by momentumScore

# Project details with JSON output
aixbt --json projects 507f1f77bcf86cd799439011

# Momentum history for last 7 days
aixbt projects momentum 507f1f77bcf86cd799439011 --start 2025-01-01T00:00:00Z
```

### signals

Query and filter intelligence signals.

```bash
aixbt signals [--page <n>] [--limit <n>] [--project-ids <ids>] [--names <names>]
              [--x-handles <handles>] [--tickers <tickers>] [--address <address>]
              [--cluster-ids <ids>] [--categories <cats>]
              [--detected-after <date>] [--detected-before <date>]
              [--reinforced-after <date>] [--reinforced-before <date>]
              [--sort-by <field>]
```

**Examples:**

```bash
# Recent signals for a specific project
aixbt signals --names "Bitcoin"

# Signals in a specific category, as JSON
aixbt --json signals --categories "DeFi" --limit 50

# Signals detected in the last 24 hours
aixbt signals --detected-after 2025-01-15T00:00:00Z
```

### clusters

Browse signal clusters (groupings of related signals).

```bash
aixbt clusters
```

**Example:**

```bash
# List all clusters as JSON
aixbt --json clusters
```

Note: Pay-per-use is not available for the clusters endpoint. Use an API key or `--delayed`.

### recipe

Run analysis recipes -- declarative YAML workflows that combine multiple API calls and optional agent steps.

```bash
# List recipes from the AIXBT registry
aixbt recipe list

# Show recipe details (params, steps, description)
aixbt recipe info <name>

# Download a recipe to a local file
aixbt recipe clone <name> [--out <path>]

# Validate a recipe YAML file
aixbt recipe validate <file>

# Run a recipe
aixbt recipe run <source> [--format raw|prompt] [--resume-from step:<id>]
                          [--input <json>] [--output-dir <path>] [--stdin]
                          [--<param> <value> ...]
```

The `<source>` for `recipe run` can be:

- A local file path (e.g., `./my-recipe.yaml`)
- A registry recipe name (e.g., `market-scanner`)
- Piped via stdin with `--stdin`

**Examples:**

```bash
# Run a registry recipe with parameters
aixbt recipe run market-scanner --chain solana

# Run a local recipe file
aixbt recipe run ./custom-analysis.yaml --chain ethereum --limit 10

# Run from stdin
cat recipe.yaml | aixbt recipe run --stdin --chain solana

# Run with raw output (no analysis framing)
aixbt recipe run market-scanner --chain solana --format raw

# Write large results to files instead of stdout
aixbt recipe run market-scanner --chain solana --output-dir ./results/
```

### config

Manage CLI configuration.

```bash
# Show all config values
aixbt config get

# Show a specific value
aixbt config get apiKey
aixbt config get apiUrl

# Set a value
aixbt config set apiUrl https://custom-api.example.com
```

Allowed config keys: `apiKey`, `apiUrl`, `keyType`, `expiresAt`, `scopes`.

### auth

```bash
# Store API key
aixbt login
aixbt login --api-key <key>

# Purchase a pass via x402
aixbt login --purchase-pass <duration>

# Remove stored credentials
aixbt logout

# Check current auth status
aixbt whoami
```

## Global Options

These options apply to all commands:

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (machine-readable, all data to stdout) |
| `--delayed` | Use free tier with delayed data (no auth required) |
| `--pay-per-use` | Pay per API call via x402 |
| `--payment-signature <base64>` | Payment proof for x402 |
| `--api-key <key>` | Override API key for this call |
| `--api-url <url>` | Override API base URL |
| `-v, --version` | Show version |
| `-h, --help` | Show help |

Mutually exclusive: `--delayed` and `--pay-per-use` cannot be used together. `--payment-signature` cannot be combined with `--pay-per-use` or `--delayed`.

## Recipe Authoring Guide

Recipes are declarative YAML workflows that chain multiple API calls and optional agent steps into a single analysis pipeline.

### Basic Structure

```yaml
name: my-analysis
version: "1.0"
description: Analyze projects on a given chain

params:
  chain:
    type: string
    required: true
    description: Blockchain to analyze

steps:
  - id: get_projects
    endpoint: /v2/projects
    params:
      chain: "{params.chain}"
      limit: 20
      sortBy: momentumScore

  - id: get_details
    foreach: "get_projects.data"
    endpoint: "/v2/projects/{item.id}"

  - id: analyze
    type: agent
    context: [get_projects, get_details]
    task: Identify the most promising projects
    description: Review project data and momentum scores
    returns:
      summary: string
      insights: "object[]"

output:
  merge: [get_projects, get_details]
  include: [analyze]
```

### Step Types

- **API steps**: Call a single API endpoint with parameters
- **foreach steps**: Iterate over results from a previous step, calling an endpoint per item
- **agent steps**: Yield to an external agent (LLM) with collected data and a task description

### Variable Templating

Use `{expression}` syntax to reference data:

- `{params.chain}` -- recipe parameter
- `{step_id}` or `{step_id.data}` -- result data from a previous step
- `{step_id.data[*].field}` -- pluck a field from each item in an array
- `{step_id.data.nested.path}` -- access nested properties
- `{item}` or `{item.field}` -- current item in a foreach step

Relative time expressions are also supported: `-24h`, `-7d`, `-30m`.

### The Segment Boundary Rule

Agent steps split a recipe into segments. Steps before an agent step run first, then the CLI yields with an `awaiting_agent` status. The agent processes the data, and the recipe resumes from the next segment with the agent's output.

### Analysis Block

Recipes can include an `analysis` block with instructions for post-processing:

```yaml
analysis:
  instructions: "Summarize key findings and rank by opportunity"
  context: "Crypto market analysis"
  task: "Identify actionable insights"
  output_format: "Markdown report with sections"
```

For the complete recipe specification, see [RECIPE_SPEC.md](RECIPE_SPEC.md).

## Agent Integration

The CLI is designed to be used by AI agents as a data and analysis tool. Agents bring their own LLM; the CLI provides structured data and analytical framing.

### Basic Agent Workflow

```bash
# Step 1: Run a recipe in JSON mode
aixbt --json recipe run market-scanner --chain solana
```

If the recipe completes without agent steps, you get a `status: "complete"` response with all data.

If the recipe hits an agent step, you get a `status: "awaiting_agent"` response:

```json
{
  "status": "awaiting_agent",
  "recipe": "market-scanner",
  "version": "1.0",
  "step": "analyze",
  "task": "Identify the most promising projects based on momentum and signals",
  "description": "Review the collected project data...",
  "returns": {
    "summary": "string",
    "insights": "object[]"
  },
  "data": {
    "get_projects": [...],
    "get_details": [...]
  },
  "resumeCommand": "aixbt recipe run market-scanner --resume-from step:analyze --input '<agent_output_json>' --chain solana"
}
```

### Step 2: Agent Processes Data

The agent reads the `data`, `task`, and `description` fields, processes them with its LLM, and produces output matching the `returns` schema.

### Step 3: Resume the Recipe

```bash
aixbt --json recipe run market-scanner --chain solana \
  --resume-from step:analyze \
  --input '{"summary": "Strong momentum in DeFi tokens...", "insights": [{"project": "...", "score": 95}]}'
```

### Key Points for Agents

- Always use `--json` mode -- all output is machine-parseable JSON
- Error responses include structured error codes and actionable suggestions
- The `resumeCommand` in `awaiting_agent` output provides the exact command template
- The `returns` field specifies the expected schema for `--input`
- Recipes can have multiple agent steps, each yielding and resuming independently

## x402 Payment Flows

The CLI supports two x402-based payment flows for users without a subscription.

### Purchase a Pass

A two-step flow to buy a time-limited API key:

```bash
# Step 1: Request pricing (triggers 402 with payment details)
aixbt login --purchase-pass 1d

# Output shows: amount, network, payTo address, and retry command

# Step 2: After completing payment on-chain, retry with proof
aixbt login --purchase-pass 1d --payment-signature <BASE64_PAYMENT_PROOF>
```

Available durations: `10c` (10 calls), `1d` (1 day), `1w` (1 week), `4w` (4 weeks).

### Pay Per Use

A per-call payment flow:

```bash
# Step 1: Make a request with --pay-per-use
aixbt --pay-per-use projects list --chain solana

# If 402: output includes payment details and retry command

# Step 2: After payment, retry with the signature
aixbt projects list --chain solana --payment-signature <BASE64_PAYMENT_PROOF>
```

In `--json` mode, payment details are returned as structured JSON with a `status: "payment_required"` field, including the amount, network, pay-to address, and a retry command template.

## Configuration

### Config File

Location: `~/.aixbt/config.json`

The config file stores your API key and related metadata. It is created automatically by `aixbt login` with `0600` permissions (owner-only read/write).

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AIXBT_API_KEY` | API key (overrides config file) |
| `AIXBT_API_URL` | API base URL (default: `https://api.aixbt.tech`) |
| `AIXBT_CONFIG` | Custom config file path (default: `~/.aixbt/config.json`) |

### Config Commands

```bash
# View all configuration
aixbt config get

# View a specific key
aixbt config get apiKey

# Set the API URL
aixbt config set apiUrl https://custom-api.example.com
```

## Development

```bash
git clone https://github.com/aixbt/cli.git
cd cli
pnpm install
pnpm build
pnpm test
pnpm lint
```

Additional commands:

```bash
pnpm dev          # Watch mode (TypeScript compiler)
pnpm format       # Format code with Prettier
pnpm clean        # Remove dist/
```

## License

MIT
