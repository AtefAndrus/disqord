# DisQord

Discord Bot that communicates with LLMs through OpenRouter.

## Repository

- GitHub: [AtefAndrus/disqord](https://github.com/AtefAndrus/disqord)

## Documentation

### ドキュメント方針

| Document | 役割 | 参照タイミング |
| -------- | ---- | -------------- |
| [progress.md](docs/progress.md) | バックログ・進捗 | **最初に参照**。未完了タスクと完了済み機能を把握 |
| [infrastructure-setup.md](docs/infrastructure-setup.md) | インフラ設定手順 | Webhook設定時のみ参照 |
| [changes/TEMPLATE.md](docs/changes/TEMPLATE.md) | Change設計テンプレート | 新機能の設計書作成時にコピー |
| `docs/changes/<name>/design.md` | 個別機能の設計書 | 該当機能の実装時に参照 |

### 更新ルール

#### progress.md（バックログ・インデックス）

- **新機能検討時**: バックログに追加
  - 機能名、優先度（高/中/低）、changeフォルダへのリンクを記載
  - 優先度に応じた位置に挿入（上が高優先度）
  - タスク詳細は changeフォルダの Tasks セクションに記載（progress.md には書かない）
- **実装完了時（commit前）**: バックログから該当項目を削除し、「完了済み」セクションへ移動
  - バージョン番号（リリース時に決定）、実装日、主な変更内容を記載

#### docs/changes/（機能別設計書）

- **新機能検討時**: `docs/changes/<feature-name>/design.md` を `TEMPLATE.md` からコピーして作成
  - フォルダ名は kebab-case（例: `web-search`, `model-compare`）
  - テンプレートに従い Why / Goals・Non-Goals / Decisions / Design / Tasks を記載
  - 詳細設計は段階的に追記可能（一度に完成させる必要なし）
- **実装完了時**: changesフォルダを削除
  - Git履歴がアーカイブとして機能するため、別途保存は不要

#### README.md（自動生成セクション）

- README.md の一部セクションは `<!-- AUTO:SECTION:START/END -->` マーカーで囲まれており、pre-commit hook で自動生成される
- **手動で編集しない** こと。ソースを編集すれば commit 時に自動反映される

| セクション | 編集先 |
| ---------- | ------ |
| コマンド一覧 | `src/bot/commands/` の各コマンド定義 |
| 環境変数 | `src/config/envVars.ts` |

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
   - Update `README.md` (if needed)

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

## References

### API・SDK

- [OpenRouter API Documentation](https://openrouter.ai/docs)
- [OpenRouter TypeScript SDK](https://www.npmjs.com/package/@openrouter/sdk)
- [discord.js v14 Documentation](https://discord.js.org/docs/packages/discord.js/14.16.3)
- [discord.js Guide](https://discordjs.guide/)

### Infrastructure

- [GitHub Webhook Events](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Bun Runtime](https://bun.sh/docs)
