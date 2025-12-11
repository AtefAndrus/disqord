# DisQord

A Discord Bot that communicates with LLMs through OpenRouter.

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

## Git

- Commit messages: Japanese allowed
- Branch: main

## Notes

- Discord message limit: 2000 characters (requires split sending)
- Default LLM model: `x-ai/grok-4.1-fast:free`
- SQLite WAL mode enabled
