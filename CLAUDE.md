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

#### progress.md

- **新機能検討時**: ロードマップ（未完了タスク）に追加
  - バージョン番号、機能概要、主要タスクを記載
  - 詳細設計はこの時点では不要（design.mdで後述）
- **実装完了時（commit前）**: 該当タスクを「完了済み」セクションへ移動
  - 実装日、主な変更内容を記載

#### design.md

- **Planning完了時（実装前）**: 詳細設計をdesign.mdに追記
  - 変更ファイル、実装方針、技術的決定事項、制約条件などを記載
  - ロードマップの概要レベルから実装可能な詳細レベルに展開
- **実装完了時（commit前）**: design.mdを「実装済み」扱いに更新
  - 将来計画セクションから該当バージョンを削除
  - 実装済み機能の参照箇所を更新（コマンド説明、アーキテクチャ図など）

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

## Release Process

When creating a new release:

1. **Update documentation**:
   - Move completed tasks in `docs/progress.md` to "完了済み" section
   - Update `docs/design.md` and `README.md` (if needed)

2. **Update package.json version**:

   ```bash
   # Edit package.json to update version field to vX.X.X
   # Example: "version": "1.3.2"
   ```

3. **Commit and push changes**:

   ```bash
   git add .
   git commit -m "[feat] implement vX.X.X ..."
   git push
   ```

4. **Create and push tag**:

   ```bash
   git tag vX.X.X
   git push --tags
   ```

5. **Create GitHub release**:

   ```bash
   gh release create vX.X.X --title "vX.X.X" --notes "..."
   ```

   - Release title: `vX.X.X`
   - Release notes should include:
     - Summary of changes (bullet points)
     - At the end: `**Full Changelog**: https://github.com/AtefAndrus/disqord/compare/v{previous}...v{current}`
   - Release notes are delivered to Discord users via webhook, so:
     - Only include user-facing changes (new features, bug fixes, UX improvements)
     - Do NOT include internal technical changes (test fixes, refactoring, code cleanup)

## Notes

- Discord message limit: 2000 characters (split required)
- Default model: `deepseek/deepseek-r1-0528:free`
- SQLite WAL mode enabled
