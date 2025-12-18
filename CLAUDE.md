# DisQord

A Discord Bot that communicates with LLMs through OpenRouter.

## Documentation

| Document | Description |
|----------|-------------|
| [README.md](README.md) | Project overview, features, setup instructions |
| [Functional Requirements](docs/disqord-functional-requirements.md) | Bot features, commands, response behavior |
| [Non-Functional Requirements](docs/disqord-non-functional-requirements.md) | Tech stack, deployment, hosting |
| [Design Document](docs/disqord-design.md) | Architecture, DB schema, interfaces |
| [Progress Checklist](docs/disqord-progress.md) | Implementation progress tracking |
| [Test Plan](docs/disqord-test-plan.md) | Test strategy, cases, and coverage |
| [PR Template](.github/pull_request_template.md) | Pull request template |

## Tech Stack

- Runtime: Bun 1.3+
- Language: TypeScript (ESNext, strict mode)
- Framework: discord.js v14
- LLM API: OpenRouter
- Database: SQLite (Bun built-in)
- Linter/Formatter: Biome
- Validation: Zod

## Directory Structure

```text
src/
├── index.ts              # Entry point
├── config/               # Environment variable loading (Zod validation)
├── bot/
│   ├── client.ts         # Discord client creation
│   ├── commands/         # Slash command definitions
│   └── events/           # Event handlers
├── db/
│   ├── index.ts          # DB connection (singleton)
│   ├── schema.ts         # Migrations
│   └── repositories/     # Data access layer
├── llm/                  # LLM client
├── services/             # Business logic
├── types/                # Type definitions
└── utils/                # Utilities
```

## Commands

```bash
bun start          # Production start
bun dev            # Development mode (--watch)
bun test           # Run tests (typecheck + test)
bun test:watch     # Run tests in watch mode
bun test:coverage  # Run tests with coverage report
bun typecheck      # Type checking
bun lint           # Lint with Biome
bun format         # Format with Biome
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| DISCORD_TOKEN | Yes | Discord Bot token |
| DISCORD_APPLICATION_ID | Yes | Discord application ID |
| OPENROUTER_API_KEY | Yes | OpenRouter API key |
| DATABASE_PATH | No | SQLite file path (default: data/disqord.db) |
| NODE_ENV | No | Execution environment (default: development) |
| DEFAULT_MODEL | No | Default LLM model (default: openai/gpt-oss-120b:free) |

## Coding Conventions

### TypeScript

- Use `import type` for type-only imports
- Add explicit return types to functions
- Avoid using `any`, define proper types
- Prefix interfaces with `I` (e.g., `ILLMClient`)

### Biome Configuration

- Indentation: 2 spaces
- Line width: 100 characters
- Auto-organize imports: enabled

### Architecture Patterns

- Repository pattern: Abstract data access
- Service pattern: Encapsulate business logic
- Dependency injection: Use constructor injection

### Naming Conventions

- File names: camelCase (e.g., `chatService.ts`)
- Class names: PascalCase (e.g., `ChatService`)
- Interfaces: `I` + PascalCase (e.g., `IChatService`)
- Type aliases: PascalCase (e.g., `GuildId`)
- Constants: UPPER_SNAKE_CASE (e.g., `DISCORD_MESSAGE_LIMIT`)

## Testing

- Test framework: Bun test
- Test files: Place in `tests/` directory
- File naming: `*.test.ts`

### Test Directory Structure

```text
tests/
├── helpers/
│   └── mockFactories.ts    # Shared mock factories
├── unit/
│   ├── utils/              # Utility function tests
│   ├── services/           # Service layer tests
│   └── llm/                # LLM client tests
└── integration/
    └── db/                 # Database integration tests (in-memory)
```

### Running Tests

```bash
bun test                    # Run all tests
bun test --coverage         # Run with coverage report
bun test --watch            # Watch mode
bun test --grep "pattern"   # Run specific tests
```

### Coverage

Current coverage: **98.55% lines**, **93.27% functions** (src/ only)

## Git

- Commit messages: English only
- Branch: main

## Notes

- Discord message limit: 2000 characters (requires split sending)
- Default LLM model: `openai/gpt-oss-120b:free`
- SQLite WAL mode enabled
