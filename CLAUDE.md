# DisQord

Discord Bot that communicates with LLMs through OpenRouter.

## Repository

- GitHub: [AtefAndrus/disqord](https://github.com/AtefAndrus/disqord)

## Documentation

### ドキュメント方針

| Document | 役割 | 参照タイミング |
| -------- | ---- | -------------- |
| [CHANGELOG.md](CHANGELOG.md) | 変更履歴 | git-cliff で自動生成。リリース時に `bun run changelog` で更新 |
| [progress.md](docs/progress.md) | バックログ | **最初に参照**。未完了タスクを把握 |
| [infrastructure-setup.md](docs/infrastructure-setup.md) | インフラ設定手順 | Webhook設定時のみ参照 |
| [changes/TEMPLATE.md](docs/changes/TEMPLATE.md) | Change設計テンプレート | 新機能の設計書作成時にコピー |
| `docs/changes/<name>/design.md` | 個別機能の設計書 | 該当機能の実装時に参照 |

### 更新ルール

#### progress.md（バックログ・インデックス）

- **新機能検討時**: バックログに追加
  - 機能名、優先度（高/中/低）、changeフォルダへのリンクを記載
  - 優先度に応じた位置に挿入（上が高優先度）
  - タスク詳細は changeフォルダの Tasks セクションに記載（progress.md には書かない）
- **実装完了時（リリース時）**: バックログから該当項目を削除
  - 変更履歴は CHANGELOG.md（git-cliff 自動生成）で管理

#### docs/changes/（機能別設計書）

- **新機能検討時**: `docs/changes/<feature-name>/design.md` を `TEMPLATE.md` からコピーして作成
  - フォルダ名は kebab-case 英語（例: `web-search`, `model-compare`）。design.md のタイトル見出しは日本語の機能名で書く
  - 必須セクション: Why / Goals・Non-Goals / Decisions / Design / Tasks
  - 任意セクション: 「依存 / 関連 change」「Open Questions / Risks」「参照」（不要なら節ごと削除）。参照の見出しは日本語「参照」に統一する（「References」は使わない）
  - 詳細設計は段階的に追記可能（一度に完成させる必要なし）
- **change の粒度（フォルダ vs ファイル）**: 分割軸はドキュメントの大きさではなく **リリース単位**
  - 別々にリリースする機能 → 別フォルダ（別 change）。フォルダがバックログ項目・リリース・削除の単位
  - 同時リリースの複数サブ機能（小〜中規模）→ 1 フォルダ・単一 `design.md`、Design 内を `---` で機能別小節に分割
  - 同時リリースの複数サブ機能（大規模かつ共有コアあり）→ 1 フォルダ・複数ファイル。`design.md` をインデックス（共有 Why/Decisions/依存 + リンク）にし、サブ機能を `design.<subfeature>.md` に分割。フォルダはリリース単位として不可分（他 change からの参照は `design.md` に向けてリンク安定性を保つ）
  - サブ機能を別々にリリースしたくなったら、ファイル分割ではなくフォルダ分割（別 change）にする
- **実装完了時**: changesフォルダを削除（Tasks の最終項目に削除を明記しておく）
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

### Commit Message Format

Format: `[type] short description`

| Prefix | 用途 | CHANGELOG カテゴリ |
| ------------ | -------------------- | ----------------- |
| `[feat]` | 新機能 | Added |
| `[fix]` | バグ修正 | Fixed |
| `[docs]` | ドキュメントのみ | Documentation |
| `[refactor]` | リファクタリング | Refactoring |
| `[test]` | テスト追加・修正 | Testing |
| `[perf]` | パフォーマンス改善 | Performance |
| `[chore]` | メンテナンス | スキップ |
| `[release]` | リリースバージョン | スキップ |
| `build(deps)` | Dependabot 自動生成 | Dependencies |

## Release Process

Use the `/release` skill to automate the release process. Example: `/release 1.5.0`

The skill handles: version bump, CHANGELOG.md generation, progress.md update, commit, tag, push, and GitHub release creation with hand-crafted release notes.

### Release Notes Guidelines

- Release notes are delivered to Discord users via webhook
- Only include user-facing changes (new features, bug fixes, UX improvements)
- Do NOT include internal technical changes (test fixes, refactoring, code cleanup)
- Write in Japanese with detailed feature descriptions (see existing releases for style reference)
- End with: `**Full Changelog**: https://github.com/AtefAndrus/disqord/compare/v{previous}...v{current}`

## Notes

- Discord message limit: 2000 characters (split required)
- Default model: `deepseek/deepseek-v4-flash:free`
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
