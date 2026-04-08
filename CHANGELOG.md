# Changelog

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
