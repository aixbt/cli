# Changelog

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
