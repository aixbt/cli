# Changelog

## 0.3.1

- **Fix** — recipe list/info/clone commands now hit the correct `/v2/recipes` endpoint (was using removed `/v2/cli/recipes` path)
- **Fix** — smarter rate limit retry with jitter and daily limit bailout

## 0.3.0

- **New** — `aixbt chat` command for conversational interaction with the AIXBT agent
- **New** — `projects:metrics` virtual action for project metric queries
- **Deprecation** — `--pay-per-use` flag deprecated with hard shim (exits non-zero with migration guidance)

## 0.2.0

- **Breaking** — `aixbt signals` is now a deprecation shim that exits non-zero (code 2). Use `aixbt intel` instead. Old endpoint sunsets 2026-07-15.
- **New** — `aixbt intel` command with `intel clusters` and `intel categories` subcommands; mirrors the previous `signals` interface against `/v2/intel`.
- **Sort default** — `aixbt intel` now sorts by `reinforcedAt` by default to match the homepage (use `--sort-by detectedAt` for first-detection order).

## 0.1.9

- **Candles** -- `aixbt projects candles <id>` subcommand with candlestick chart renderer
- **AIXBT provider** -- new `candles` action; `market.chart` recipe prefers AIXBT candles when available

## 0.1.8

- **Server-side recipe execution** -- recipes now execute via the API endpoint instead of client-side, with provider enrichment layer for server fallbacks
- **Recipe validate** -- `aixbt recipe validate` supports registry names, `--stdin`, and server-side validation; local schema checks are reported as warnings
- **Grounding history** -- `aixbt grounding history` subcommand with `--sections`, `--from`, `--to`, `--page` params
- **Structured output pagination** -- JSON/toon output now includes pagination hints
- **Doc URL updates** -- recipe help text points to `/builders/recipes/` (surface-agnostic)
- **Cleanup** -- removed dead client-side transforms and stale internal docs

## 0.1.7

- **Free tier removal** — remove `--delayed` flag and free tier auth mode; unauthenticated grounding users see upgrade nudge
- **User-Agent versioning** — API requests now include CLI version in the User-Agent header

## 0.1.6

- **Rank nudge** — agent context now guides LLMs to treat rank as volatile background signal, not a headline number

## 0.1.5

- **Fixes** — rank display shows full history instead of last 20 points, null for drop-outs

## 0.1.4

- **Grounding command** — `aixbt grounding` with section filters
- **Historical queries** — `--at` flag for projects, signals, momentum, and recipes
- **Rank command** — `aixbt projects rank <id>` for position history in the top 100
- **Carry-forward context** — recipes preserve context across yield boundaries
- **Update notifications** — alerts when a newer CLI version is available
- **Fixes** — x402 pay-per-use request routing, timeAgo relative to `--at` anchor
