# DisQord

Discord Bot that communicates with LLMs through OpenRouter.

## Repository

- GitHub: [AtefAndrus/disqord](https://github.com/AtefAndrus/disqord)

## Documentation

詳細は [docs/](docs/) を参照:

| Document | Description |
| -------- | ----------- |
| [requirements.md](docs/requirements.md) | 機能・非機能要件 |
| [design.md](docs/design.md) | アーキテクチャ、DBスキーマ |
| [progress.md](docs/progress.md) | 実装進捗（未完了タスク優先） |
| [test-plan.md](docs/test-plan.md) | テスト戦略 |

## Tech Stack

- Runtime: Bun 1.3+
- Language: TypeScript (ESNext, strict mode)
- Framework: discord.js v14
- LLM API: OpenRouter
- Database: SQLite (Bun built-in)
- Linter/Formatter: Biome

## Directory Structure

```text
src/
├── index.ts              # Entry point
├── health.ts             # Health check HTTP server
├── config/               # Environment variable loading
├── bot/
│   ├── client.ts         # Discord client
│   ├── commands/         # Slash commands
│   └── events/           # Event handlers
├── db/
│   ├── index.ts          # DB connection
│   ├── schema.ts         # Migrations
│   └── repositories/     # Data access layer
├── llm/                  # LLM client
├── services/             # Business logic
├── types/                # Type definitions
└── utils/                # Utilities
```

## Commands

```bash
bun dev            # Development mode
bun start          # Production start
bun test           # Run tests
bun typecheck      # Type checking
bun lint           # Lint with Biome
bun format         # Format with Biome
```

## Coding Conventions

### TypeScript

- Use `import type` for type-only imports
- Add explicit return types to functions
- Avoid `any`, define proper types
- Prefix interfaces with `I` (e.g., `ILLMClient`)

### Biome

- Indentation: 2 spaces
- Line width: 100 characters
- Auto-organize imports

### Architecture Patterns

- Repository pattern for data access
- Service pattern for business logic
- Constructor injection for DI

### Naming

- Files: camelCase (e.g., `chatService.ts`)
- Classes: PascalCase (e.g., `ChatService`)
- Interfaces: `I` + PascalCase (e.g., `IChatService`)
- Constants: UPPER_SNAKE_CASE

## Testing

- Framework: bun:test
- Directory: `tests/`
- Coverage: 98.71% lines, 94.02% functions

## Git

- Commit messages: English
- Branch: main

## Notes

- Discord message limit: 2000 characters (split required)
- Default model: `deepseek/deepseek-r1-0528:free`
- SQLite WAL mode enabled
