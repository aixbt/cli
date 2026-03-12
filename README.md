# @aixbt/cli

> AIXBT intelligence from your terminal. Direct API commands and declarative recipe workflows.

[![npm version](https://img.shields.io/npm/v/@aixbt/cli)](https://www.npmjs.com/package/@aixbt/cli)

## Install

```bash
npm install -g @aixbt/cli
```

Requires Node.js 18 or later.

## Authenticate

```bash
aixbt login
```

Four access modes: API key, x402 purchase pass, x402 pay-per-use, and delayed (free). See the [docs](https://docs.aixbt.tech/builders/cli) for details.

## Commands

| Command | Description |
|---------|-------------|
| `login` | Authenticate with the AIXBT API |
| `logout` | Remove stored credentials |
| `whoami` | Show current authentication status |
| `projects` | Query tracked projects and momentum |
| `signals` | Query real-time detected signals |
| `clusters` | Explore signal clusters |
| `recipe` | Build and run analysis pipelines |

## Documentation

Full documentation, recipe specification, and agent integration guide:

**https://docs.aixbt.tech/builders/cli**

## Development

```bash
git clone https://github.com/aixbt/cli.git
cd cli
pnpm install
pnpm build
pnpm test
```

## License

MIT
