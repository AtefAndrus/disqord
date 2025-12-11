# DisQord

OpenRouterを通じてLLMと会話するDiscord Bot。

## 技術スタック

- ランタイム: Bun 1.3+
- 言語: TypeScript (ESNext, strict mode)
- フレームワーク: discord.js v14
- LLM API: OpenRouter
- データベース: SQLite (Bun組み込み)
- リンター/フォーマッター: Biome
- バリデーション: Zod

## ディレクトリ構造

```text
src/
├── index.ts              # エントリーポイント
├── config/               # 環境変数ロード (Zod検証)
├── bot/
│   ├── client.ts         # Discordクライアント生成
│   ├── commands/         # スラッシュコマンド定義
│   └── events/           # イベントハンドラ
├── db/
│   ├── index.ts          # DB接続 (シングルトン)
│   ├── schema.ts         # マイグレーション
│   └── repositories/     # データアクセス層
├── llm/                  # LLMクライアント
├── services/             # ビジネスロジック
├── types/                # 型定義
└── utils/                # ユーティリティ
```

## コマンド

```bash
bun start          # 本番起動
bun dev            # 開発モード (--watch)
bun test           # テスト実行 (typecheck + test)
bun typecheck      # 型チェック
bun lint           # Biomeによるリント
bun format         # Biomeによるフォーマット
```

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| DISCORD_TOKEN | Yes | Discord Botトークン |
| DISCORD_APPLICATION_ID | Yes | DiscordアプリケーションID |
| OPENROUTER_API_KEY | Yes | OpenRouter APIキー |
| DATABASE_PATH | No | SQLiteファイルパス (default: data/disqord.db) |
| NODE_ENV | No | 実行環境 (default: development) |

## コーディング規約

### TypeScript

- `import type` を型のみのインポートに使用する
- 明示的な戻り値の型を関数に付与する
- `any` の使用を避け、適切な型定義を行う
- インターフェースは `I` プレフィックスを付ける (例: `ILLMClient`)

### Biome設定

- インデント: 2スペース
- 行幅: 100文字
- import自動整理: 有効

### アーキテクチャパターン

- Repository パターン: データアクセスを抽象化
- Service パターン: ビジネスロジックをカプセル化
- 依存性注入: コンストラクタインジェクションを使用

### 命名規則

- ファイル名: camelCase (例: `chatService.ts`)
- クラス名: PascalCase (例: `ChatService`)
- インターフェース: `I` + PascalCase (例: `IChatService`)
- 型エイリアス: PascalCase (例: `GuildId`)
- 定数: UPPER_SNAKE_CASE (例: `DISCORD_MESSAGE_LIMIT`)

## テスト

- テストフレームワーク: Bun test
- テストファイル: `tests/` ディレクトリに配置
- ファイル命名: `*.test.ts`

## Git

- コミットメッセージ: 日本語可
- ブランチ: main

## 注意事項

- Discord メッセージ上限: 2000文字 (分割送信が必要)
- デフォルトLLMモデル: `x-ai/grok-4.1-fast:free`
- SQLite WALモード有効
