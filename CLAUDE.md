# DisQord

Discord Bot that communicates with LLMs through OpenRouter.

## Repository

- GitHub: [AtefAndrus/disqord](https://github.com/AtefAndrus/disqord)

## Documentation

### ドキュメント方針

| Document | 役割 | 参照タイミング |
| -------- | ---- | -------------- |
| [progress.md](docs/progress.md) | 進捗・ロードマップ | **最初に参照**。未完了タスクと完了済み機能を把握 |
| [design.md](docs/design.md) | 仕様・アーキテクチャ・設計判断 | 実装時に参照。DBスキーマ、エラー設計など |
| [infrastructure-setup.md](docs/infrastructure-setup.md) | インフラ設定手順 | Webhook設定時のみ参照 |

### 更新ルール

- 機能実装完了時: progress.md の該当タスクを「完了済み」へ移動
- 設計変更時: design.md を更新（将来計画の詳細は実装時に追記）
- 新機能追加時: design.md に仕様・設計を追記

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
├── index.ts              # Entry point + DI setup
├── health.ts             # HTTP server (health check + webhook)
├── config/               # Environment variable loading
├── bot/
│   ├── client.ts         # Discord client
│   ├── commands/         # Slash commands
│   └── events/           # Event handlers
├── db/
│   ├── index.ts          # DB connection
│   ├── schema.ts         # Migrations
│   └── repositories/     # Data access layer
├── llm/                  # OpenRouter client
├── services/             # Business logic
├── errors/               # Custom error classes
├── http/                 # Webhook signature verification
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
- Run: `bun test` (includes typecheck)

### Mock Strategy

| 依存 | モック方法 |
| ---- | ---------- |
| `fetch` | `mock()` でグローバル置換 |
| `bun:sqlite` | インメモリDB (`:memory:`) |
| Repository/Service | `mock()` でインターフェース実装 |
| `console.*` | `spyOn()` で出力検証 |

## Git

- Commit messages: English
- Branch: main

## Notes

- Discord message limit: 2000 characters (split required)
- Default model: `deepseek/deepseek-r1-0528:free`
- SQLite WAL mode enabled
