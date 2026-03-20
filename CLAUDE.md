# @aixbt/cli

CLI tool for the AIXBT v2 API and recipe engine. Direct API commands and declarative recipe workflows.

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm build` | Build TypeScript (outputs to `dist/`) |
| `pnpm dev` | Watch mode |
| `pnpm test` | Run Vitest tests |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |

## Structure

```
src/
├── cli.ts              # Entry point, command registration
├── types.ts            # Shared types
├── commands/           # CLI command handlers
│   ├── clusters.ts
│   ├── login.ts
│   ├── projects.ts
│   ├── signals.ts
│   ├── recipe.ts
│   └── provider.ts
└── lib/                # Core libraries
    ├── api-client.ts   # API client
    ├── auth.ts         # Authentication
    ├── config.ts       # Configuration
    ├── output.ts       # Output formatting
    ├── recipe/         # Recipe engine
    ├── providers/      # Data providers
    └── agents/         # Agent runner
```

## Git Workflow

Forking workflow — see [Branch Guidelines](../about/howto/branch-guidelines.md) for full details.

**Remotes:**
- `origin` = main repo (`aixbt/cli`) — DO NOT push feature branches here
- `mine` = user's personal fork — push feature branches here

**Branches:**
- `main` = production (protected, PR only)
- `develop` = default branch, **default PR target** (protected, PR only)

**Flow:** feature branch → PR to `develop` → merge to `main` for release

**Branch naming:** `feature/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`

**Commit format:** `type(scope): short description`

## Package Manager

Use `pnpm`.
