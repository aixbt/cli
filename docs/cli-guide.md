# AIXBT CLI Guide

The AIXBT CLI gives you direct commands and declarative recipe workflows for crypto signal intelligence.

## Installation

```bash
npm install -g @aixbt/cli
```

Requires Node.js 18 or later. After install, the `aixbt` binary is available globally. If global install fails due to permissions, ask your user to run the install or use `npx @aixbt/cli` as an alternative.

## Authentication

The CLI supports four authentication modes. Credentials resolve automatically based on flags, environment, and stored config.

### Mode 1: API Key

```bash
aixbt login --api-key sk-your-key-here    # non-interactive (use this)
aixbt login                                # interactive prompt (requires your user)
```

Stored in `~/.aixbt/config.json`. Used for all subsequent commands. If you or your user already has an API key, this is the fastest path.

### Mode 2: Purchase Pass (x402)

Buy a time-limited access pass with USDC on Base. No account needed, but requires a wallet.

```bash
# List available passes with pricing
aixbt login --purchase-pass -f json

# Initiate purchase for a specific duration (1d, 1w, 4w)
aixbt login --purchase-pass 1d -f json
```

The CLI returns structured payment details to guide you through the x402 flow. See the [Agent x402 Guide](https://docs.aixbt.tech/builders/agent-x402-guide) for wallet setup and payment execution.

### Mode 3: Pay Per Use (x402)

Append `--pay-per-use` to any command. Pays $0.50 per API call via x402. Requires a wallet with USDC on Base.

```bash
aixbt signals --pay-per-use
```

Not available (but also not required) for the `clusters` endpoint.

### Mode 4: Delayed / Free Tier

Append `--delayed` to any command. Returns data delayed by 24 hours. No authentication needed.

Delayed responses include a `meta` field with data staleness info and upgrade paths. Check this to decide whether the data is fresh enough for the task at hand.

### Credential Resolution Order

When multiple credentials are available, the CLI resolves them in this order:

| Priority | Source                  | Example                          |
| -------- | ----------------------- | -------------------------------- |
| 1        | `--api-key` flag        | `aixbt signals --api-key sk-...` |
| 2        | `AIXBT_API_KEY` env var | `export AIXBT_API_KEY=sk-...`    |
| 3        | `~/.aixbt/config.json`  | Written by `aixbt login`         |

`--delayed` and `--pay-per-use` bypass this chain entirely and cannot be combined with each other.

## Command Reference

The CLI is self-documenting. Use these to discover commands, flags, and options:

```bash
aixbt help all -f json          # full structured reference (all commands, all flags)
aixbt <command> --help           # detailed help for a specific command
aixbt provider <name> --help     # list a provider's available actions
```

This guide covers concepts and workflows — for flag-level detail, use the commands above. The sections below highlight non-obvious behavior.

### projects

```bash
# Filter and sort
aixbt projects --chain ethereum --min-momentum 0.5 --sort-by popularityScore -f json
aixbt projects --tickers "BTC,ETH" -f json

# Subcommands
aixbt projects chains -f json
aixbt projects momentum <id> --start 2026-03-01 --end 2026-03-19 -f json
```

### signals

```bash
aixbt signals --tickers BTC --detected-after 2026-03-18T00:00:00Z -f json
aixbt signals --categories "Price Action,Partnership" --official -f json
```

### recipe

Recipes are the most powerful way to use AIXBT data. They are declarative YAML pipelines that chain API calls, iterate over results, sample and transform data, and yield back to you for inference — all with automatic pagination and rate limiting.

You can run recipes from the official registry, but the real leverage is that you can **author custom pipelines on the fly**. Generate a recipe dynamically, pipe it via `--stdin`, and get structured results back. When a pipeline proves useful, save it to `~/.aixbt/recipes/` so you (or your user) can invoke it by name later. Over time, you can build a library of reusable analysis pipelines tailored to your user's needs.

The `instructions` field in agent steps is a free-form prompt — you can write instructions that direct the executing agent to use specific tools (web search, code execution, file writes, etc.), not just pure inference. This means recipes can orchestrate rich multi-tool workflows, with the CLI handling data assembly and the agent step handling everything else.

See the [Recipe Specification](recipe-specification.md) and [Recipe Building Blocks](recipe-building-blocks.md) for the full YAML reference.

```bash
# Browse the official registry
aixbt recipe list -f json

# Show recipe details (registry name or file path)
aixbt recipe info <name> -f json

# Clone a recipe from the registry to ~/.aixbt/recipes/
aixbt recipe clone <name>
aixbt recipe clone <name> --out ./my-recipe.yaml

# Validate a recipe without executing
aixbt recipe validate <name-or-file>

# Measure context token usage (runs data steps, skips agent steps)
aixbt recipe measure <name-or-file>

# Run a recipe
aixbt recipe run <name-or-file> -f json
aixbt recipe run <name-or-file> --param1 value1 --param2 value2
aixbt recipe run --stdin < my-recipe.yaml

# Run with agent integration (spawns Claude Code or Codex for inference steps)
aixbt recipe run <name> --agent claude
aixbt recipe run <name> --agent codex

# Resume from an agent step (yield/resume protocol)
aixbt recipe run <name> --resume-from step:<id> --input '{"picks": [...]}'

# Write segment data to files instead of stdout
aixbt recipe run <name> --output-dir ./output/
```

**Recipe resolution order:** When given a name (not a file path), the CLI checks the registry first, then `~/.aixbt/recipes/`. Registry takes precedence to prevent accidental or malicious shadowing.

### provider

Manage external data providers (CoinGecko, DeFiLlama, GoPlus) and run provider actions directly.

```bash
# List all providers and their configuration status
aixbt provider list -f json

# Add a provider API key (auto-infers tier, verifies with a probe request)
aixbt provider add coingecko --api-key CG-xxxxx
aixbt provider add defillama --api-key xxxxx --tier pro
aixbt provider add goplus --api-key xxxxx --skip-verify

# Test a provider connection
aixbt provider test coingecko -f json

# Remove a provider key
aixbt provider remove coingecko
```

Providers also expose direct data commands: `aixbt provider <name> --help` lists all available actions.

## Global Flags

These flags are available on every command:

| Flag                  | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `-f, --format <mode>` | Output format: `human`, `json`, `toon` (default: `human`) |
| `-v, --verbose`       | Increase detail level. Stack: `-v`, `-vv`, `-vvv`         |
| `--api-key <key>`     | API key (overrides env and config)                        |
| `--delayed`           | Use free tier with delayed data                           |
| `--pay-per-use`       | Pay per API call via x402                                 |

## Output Formats

Control output format with `-f` or `--format`.

| Format  | Flag                 | Best for                                              |
| ------- | -------------------- | ----------------------------------------------------- |
| `human` | `-f human` (default) | Interactive terminal use. Tables, cards, color.       |
| `json`  | `-f json`            | Scripting, piping to `jq`, agent consumption.         |
| `toon`  | `-f toon`            | Agent consumption with 30-60% fewer tokens than JSON. |

Always use `-f json` or `-f toon`. Human format includes ANSI escape codes and is not machine-parseable.

**TOON** ([toonformat.dev](https://toonformat.dev)) is a compact, lossless encoding of the JSON data model that combines YAML-like indentation with CSV-style tabular arrays. Benchmarks show ~40% fewer tokens than JSON while achieving higher retrieval accuracy across tested models. It's a particularly good fit for AIXBT data, which is mostly uniform arrays of projects and signals — exactly the structure where TOON's tabular format excels. The CLI falls back to JSON automatically if TOON encoding fails for a particular payload. All examples in this guide use JSON for clarity, but everything works the same with `-f toon`.

Resolution order: `--format` flag > `config.format` > `human`. Structured data goes to stdout; spinners and progress go to stderr.

## Verbosity

The `-v` flag controls how much data is included in responses. Each level adds more fields.

| Level  | Projects                                                   | Signals                                                              |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| (none) | name, score, rationale, 24h change                         | name, category, description, detected/reinforced time, cluster count |
| `-v`   | + id, description, metrics, tokens, categories, timestamps | + id, projectId, full clusters, official source, activity            |
| `-vv`  | + inline signals (without activity)                        | (same as -v)                                                         |
| `-vvv` | + full signals with activity, full coingeckoData           | (same as -v)                                                         |

The default page limit is 25 for human format, 50 for structured formats (`json`, `toon`). Override with `--limit`.

## Environment Variables

| Variable              | Description                                       | Default                  |
| --------------------- | ------------------------------------------------- | ------------------------ |
| `AIXBT_API_KEY`       | API key for authentication                        | —                        |
| `AIXBT_API_URL`       | API base URL                                      | `https://api.aixbt.tech` |
| `AIXBT_CONFIG`        | Path to config file                               | `~/.aixbt/config.json`   |
| `AIXBT_AGENT`         | Default agent for recipe inference steps          | —                        |
| `COINGECKO_API_KEY`   | CoinGecko API key (alternative to `provider add`) | —                        |
| `DEFILLAMA_API_KEY`   | DeFiLlama API key                                 | —                        |
| `GOPLUS_ACCESS_TOKEN` | GoPlus API key                                    | —                        |

## Error Handling

All errors are structured. In `json`/`toon` format, errors produce a JSON object with `error` (code) and `message` fields. In human format, errors are printed to stderr.

### Error Codes

| Code                      | Meaning                                              | Recovery                                                        |
| ------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| `NO_API_KEY`              | No credentials configured                            | Run `aixbt login`, use `--delayed`, or `--pay-per-use`          |
| `AUTH_ERROR`              | Generic auth failure                                 | Check key validity                                              |
| `API_KEY_EXPIRED`         | Key has expired                                      | Run `aixbt login` to set a new key                              |
| `INVALID_API_KEY`         | Key is invalid                                       | Run `aixbt login` with a valid key                              |
| `RATE_LIMIT_EXCEEDED`     | API rate limit hit                                   | Wait and retry. Response includes `rateLimit.retryAfterSeconds` |
| `PAYMENT_REQUIRED`        | x402 payment needed                                  | Run `aixbt login --purchase-pass` or use `--pay-per-use`        |
| `NETWORK_ERROR`           | Connection failure                                   | Check internet connection                                       |
| `HTTP_<status>`           | API returned non-OK status                           | Check the message for details                                   |
| `RECIPE_VALIDATION_ERROR` | Recipe YAML is invalid                               | Fix the issues listed in `issues[]`                             |
| `RECIPE_NOT_FOUND`        | Recipe not in registry or local                      | Check the name/path                                             |
| `FILE_NOT_FOUND`          | Local file does not exist                            | Check the file path                                             |
| `FILE_EXISTS`             | Target file already exists (clone)                   | Use `--out` for a different path                                |
| `INVALID_FORMAT`          | Invalid format for context (e.g., human for recipes) | Use `json` or `toon`                                            |
| `INVALID_INPUT`           | Invalid input (e.g., bad JSON for `--input`)         | Fix the input data                                              |
| `NO_SOURCE`               | No recipe source provided                            | Provide a file path, registry name, or `--stdin`                |
| `UNKNOWN_PROVIDER`        | Unrecognized provider name                           | Use one of: coingecko, defillama, goplus                        |
| `X402_NOT_AVAILABLE`      | x402 not available for this endpoint                 | Use API key or `--delayed`                                      |
| `AGENT_NOT_FOUND`         | Agent binary not on PATH                             | Ask your user to install Claude Code or Codex CLI               |
| `AGENT_SPAWN_FAILED`      | Failed to start agent process                        | Ask your user to check agent installation                       |
| `AGENT_EXECUTION_FAILED`  | Agent exited with an error                           | Check agent stderr output                                       |
| `AGENT_PARSE_FAILED`      | Agent returned unparseable response                  | You must return valid JSON for intermediate steps               |

Errors include contextual details — for example, `NO_API_KEY` includes an `options` array with all access modes, and `RATE_LIMIT_EXCEEDED` includes `retryAfterSeconds`.

## Rate Limiting

The CLI handles rate limiting automatically — both for the AIXBT API and external providers. During recipe execution, rate limit waits happen transparently within pagination and foreach loops.

If a command fails with `RATE_LIMIT_EXCEEDED`, wait the indicated `retryAfterSeconds` and retry. You do not need to implement retry logic for recipe execution — it handles this internally.

## Agent Execution

The `--agent` flag on `recipe run` spawns a local LLM agent for inference steps. The CLI handles all data fetching, pagination, and assembly, then delegates analysis to you (or another agent).

### Supported Agents

| Agent       | Binary   | Streaming                 |
| ----------- | -------- | ------------------------- |
| Claude Code | `claude` | Claude stream-json format |
| Codex       | `codex`  | Codex JSONL format        |

### How It Works

1. The CLI executes recipe data steps (API calls, foreach loops, transforms)
2. When an agent step is reached, the recipe yields with `status: "awaiting_agent"`
3. The CLI writes recipe data to temp files (`~/.aixbt/tmp/`) and spawns you with a prompt containing file paths, instructions, and a return schema
4. You read the data files, follow the instructions, and return JSON
5. The CLI resumes recipe execution with your response
6. For final analysis steps, you stream output to stdout

### Configuration

```bash
# Per-command
aixbt recipe run momentum-report --agent claude

# Environment variable
export AIXBT_AGENT=claude

# Config file (~/.aixbt/config.json)
{ "agent": "claude", "agentAllowedTools": ["Read"] }
```

Resolution order: `--agent` flag > `AIXBT_AGENT` env > `config.agent`.

The `agentAllowedTools` config limits which tools the agent can use during inference. This is a safety measure — by default agents have access to all tools.

### No-Agent Mode (Yield/Resume)

Without `--agent`, recipe run outputs the raw recipe result as JSON/TOON. You are responsible for handling agent steps via the yield/resume protocol. This is the more flexible mode — when the recipe yields, you can use any tools available to you (web search, code execution, file I/O, other APIs) to fulfill the instructions, not just LLM inference. The `--agent` flag constrains execution to a single spawned agent; yield/resume lets you bring your full capabilities to bear.

When a recipe reaches an agent step, the CLI returns a `RecipeAwaitingAgent` payload:

```json
{
  "status": "awaiting_agent",
  "recipe": "momentum-scan",
  "version": "1.0",
  "step": "analyze",
  "instructions": "Identify the strongest momentum shift and explain why it matters.",
  "returns": { "summary": "string", "topProject": "string" },
  "data": { "projects": ["..."], "details": ["..."] },
  "tokenCount": 12450,
  "resumeCommand": "aixbt recipe run momentum-scan --resume-from step:analyze --input '<json>'"
}
```

Key fields:

- **instructions**: what you should do with the data
- **returns**: the JSON schema you must produce
- **data**: object mapping context step IDs to their collected data. May include `_fallbackNotes` if any provider steps were skipped due to missing keys
- **tokenCount**: approximate token count of `data` (`JSON.stringify(data).length / 4`), for your context window budgeting
- **resumeCommand**: pre-built CLI command to resume the recipe

To resume, pass the agent's output back:

```bash
aixbt recipe run momentum-scan \
  --resume-from step:analyze \
  --input '{"summary": "...", "topProject": "..."}' \
  -f json
```

Resume is a **stateless re-invocation**. All original `--params` must be re-provided. The `--input` value must conform to the `returns` schema from the yield payload. The CLI re-parses the entire YAML from scratch on resume.

### Parallel Agent Steps

Recipes with agent steps that include a `foreach` field create fan-out patterns. The CLI spawns up to 3 agent invocations in parallel, each processing one item. Results are collected and merged back into the recipe flow.

The yield payload for parallel steps includes additional fields:

- **parallel**: `{ items, itemKey, concurrency, perItemContext, sharedContext }` — describes the fan-out
- **parallelExecution**: instructions for you on how to process items

You must return results wrapped as `{ "_results": [...] }` with one entry per item.

## Workflow Patterns

### Single-Pass Recipes

Recipes with no agent steps return `status: "complete"` immediately. No yield/resume cycle needed.

```bash
aixbt recipe run data-only-recipe -f json
# Returns: { status, recipe, version, timestamp, data, tokenCount, hints?, analysis? }
```

### Multi-Segment Recipes

Recipes with one or more agent steps yield once per agent step.

```
CLI (fetch) → yield → Agent (analyze) → resume → CLI (fetch more) → yield → Agent (summarize) → resume → complete
```

With `--agent`, this loop is handled automatically. Without `--agent`, you must drive each yield/resume cycle manually.

## Provider Configuration

Each provider has tiers (free, demo, pro) that determine available actions and rate limits. Run `aixbt provider list -f json` to see current configuration and tier details. Keys are resolved with the same 3-layer pattern as the AIXBT API key (flag > env var > config file).

### In Recipes

Providers are used in recipe steps via the `source` field:

```yaml
steps:
  - id: price_data
    action: price
    source: coingecko
    params:
      id: bitcoin
```

When a recipe step requires a provider key that isn't configured, behavior depends on the `fallback` field:

- **With `fallback`:** The step is skipped and produces `{ _fallback: true, message: "..." }` instead of failing. The `fallback` value (a string) is included in the message shown to you. The recipe continues.
- **Without `fallback`:** The step fails with an error.

## Config File

The CLI stores configuration in `~/.aixbt/config.json` (0600 permissions). The full schema:

```json
{
  "apiKey": "sk-...",
  "apiUrl": "https://api.aixbt.tech",
  "keyType": "subscription",
  "expiresAt": "2026-04-19T00:00:00Z",
  "scopes": ["read"],
  "format": "toon",
  "limit": 50,
  "agent": "claude",
  "agentAllowedTools": ["Read"],
  "providers": {
    "coingecko": { "apiKey": "CG-xxx", "tier": "demo" },
    "defillama": { "apiKey": "xxx", "tier": "pro" }
  }
}
```

All fields are optional. The file is created by `aixbt login` and updated by `provider add`.

## Quick Start

1. **Discover commands:** `aixbt help all -f json` returns a complete structured reference of every command, flag, and option. Use `aixbt <command> --help` for details on any specific command.

2. **Check auth:** `aixbt whoami -f json`. If not authenticated, use `--delayed` for free access or ask your user to run `aixbt login`.

3. **Use `-f toon`** to save tokens. TOON saves 30-60% vs JSON with equal comprehension accuracy.

4. **Use recipes for complex analysis:** Browse `aixbt recipe list -f json`, then run with `--agent` for automated inference or pipe a recipe via `--stdin`.

5. **Handle errors structurally.** Errors in `-f json` mode include an `error` code and `message`. The [Error Codes](#error-codes) table lists every code with recovery actions.
