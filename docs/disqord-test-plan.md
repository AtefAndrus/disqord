# DisQord テスト実装計画

## 1. 概要

本ドキュメントでは、DisQordのテスト実装計画を定義する。

- テストフレームワーク: `bun:test`（Jest互換API）
- テスト種別: ユニットテスト、統合テスト

---

## 2. ディレクトリ構造

```text
tests/
├── unit/
│   ├── utils/
│   │   ├── logger.test.ts
│   │   └── message.test.ts
│   ├── services/
│   │   ├── settingsService.test.ts
│   │   └── chatService.test.ts
│   ├── llm/
│   │   └── openrouter.test.ts
│   └── health.test.ts
├── integration/
│   └── db/
│       └── guildSettingsRepository.test.ts
└── helpers/
    └── mockFactories.ts
```

---

## 3. モック戦略

| 依存 | モック方法 | 理由 |
| ---- | ---------- | ---- |
| `console.*` | `spyOn(console, "log")` | 出力検証、副作用抑制 |
| `fetch` | `mock()` でグローバル置換 | 外部API呼び出し抑制 |
| `bun:sqlite` | インメモリDB (`:memory:`) | 高速・分離された統合テスト |
| Repository | `mock()` でインターフェース実装 | Service層の単体テスト |
| ILLMClient | `mock()` でインターフェース実装 | ChatServiceの単体テスト |

---

## 4. テスト優先順位

| 優先度 | ファイル | 理由 |
| ------ | -------- | ---- |
| 1 | `message.test.ts` | 境界条件が多く、バグが発生しやすい |
| 2 | `chatService.test.ts` | コアビジネスロジック |
| 3 | `settingsService.test.ts` | コアビジネスロジック |
| 4 | `openrouter.test.ts` | 外部API統合、エラーハンドリング |
| 5 | `guildSettingsRepository.test.ts` | データ永続化の正確性 |
| 6 | `logger.test.ts` | 単純だが基盤 |

---

## 5. テストファイル詳細

### 5.1 tests/helpers/mockFactories.ts

共通モックファクトリを提供する。

```typescript
import { mock } from "bun:test";
import type { IGuildSettingsRepository } from "../../src/db/repositories/guildSettings";
import type { ILLMClient } from "../../src/llm/openrouter";
import type { ISettingsService } from "../../src/services/settingsService";
import type { GuildSettings, ChatCompletionResponse } from "../../src/types";

export function createMockGuildSettingsRepository(): IGuildSettingsRepository;
export function createMockLLMClient(): ILLMClient;
export function createMockSettingsService(): ISettingsService;
```

---

### 5.2 tests/unit/utils/message.test.ts

**テストケース:**

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 空文字列は単一要素の配列を返す | `[""]` |
| 2 | 制限以下の文字列は分割しない | 1要素 |
| 3 | 制限ちょうどの文字列は分割しない | 1要素 |
| 4 | 制限を1文字超える場合は2チャンクに分割 | 2要素 |
| 5 | 制限の2倍の長さは2チャンクに分割 | 2要素 |
| 6 | 制限の2倍+1の長さは3チャンクに分割 | 3要素 |
| 7 | 大きな文字列も正しく分割される | 各チャンク<=2000 |
| 8 | 分割後の結合が元の文字列と一致する | 完全一致 |
| 9 | マルチバイト文字を含む文字列も処理できる | 正常分割 |

---

### 5.3 tests/unit/utils/logger.test.ts

**テストケース:**

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | debug: メッセージのみでconsole.debugを呼び出す | `[DEBUG]`含む |
| 2 | debug: メタデータ付きでJSON形式で出力する | JSON含む |
| 3 | info: INFOレベルでconsole.infoを呼び出す | `[INFO]`含む |
| 4 | warn: WARNレベルでconsole.warnを呼び出す | `[WARN]`含む |
| 5 | error: ERRORレベルでconsole.errorを呼び出す | `[ERROR]`含む |
| 6 | error: Errorオブジェクトをメタデータとして渡せる | 呼び出し成功 |
| 7 | ISO 8601形式のタイムスタンプを含む | 形式一致 |

---

### 5.4 tests/unit/services/settingsService.test.ts

**テストケース:**

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | getGuildSettings: 既存の設定がある場合はそれを返す | 既存設定返却 |
| 2 | getGuildSettings: 設定が存在しない場合はデフォルト設定を作成 | upsert呼び出し |
| 3 | getGuildSettings: デフォルトモデルが正しい値 | `google/gemini-2.0-flash-exp:free` |
| 4 | setGuildModel: 指定したモデルでupsertを呼び出す | 正しいパラメータ |
| 5 | setGuildModel: 更新後の設定を返す | 更新済み設定 |
| 6 | setGuildModel: updatedAtが含まれる | タイムスタンプ存在 |

---

### 5.5 tests/unit/services/chatService.test.ts

**テストケース:**

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | SettingsServiceからギルド設定を取得する | getGuildSettings呼び出し |
| 2 | LLMClientにギルドのデフォルトモデルを使用してリクエスト | 正しいmodel値 |
| 3 | LLMClientからのレスポンスを返す | content返却 |
| 4 | choicesが空の場合は空文字を返す | `""` |
| 5 | messageのcontentがundefinedの場合は空文字を返す | `""` |
| 6 | LLMClientがエラーをスローした場合はそのまま伝播 | エラー伝播 |
| 7 | SettingsServiceがエラーをスローした場合はそのまま伝播 | エラー伝播 |

---

### 5.6 tests/unit/llm/openrouter.test.ts

**テストケース:**

#### chat メソッド

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 正常なレスポンスを返す | ChatCompletionResponse |
| 2 | 正しいエンドポイントとヘッダーでfetchを呼び出す | URL・ヘッダー検証 |
| 3 | リクエストボディが正しくJSONシリアライズされる | body検証 |
| 4 | レート制限時はエラーをスローする | エラースロー |
| 5 | 429エラーでレート制限状態になる | isRateLimited=true |
| 6 | 429エラーでX-RateLimit-Resetヘッダーがない場合はデフォルト60秒 | デフォルト適用 |
| 7 | その他のHTTPエラーはメッセージ付きでスローする | エラーメッセージ |
| 8 | エラーレスポンスがパースできない場合はステータスコードを含む | HTTP xxx |

#### listModels メソッド

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | モデルIDの配列を返す | `string[]` |
| 2 | エラー時は空配列を返す | `[]` |

#### getCredits メソッド

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 残高を返す | `{ remaining: number }` |
| 2 | limit_remainingがnullの場合はInfinityを返す | `Infinity` |
| 3 | エラー時は残高0を返す | `{ remaining: 0 }` |

#### isRateLimited メソッド

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 初期状態ではfalseを返す | `false` |

---

### 5.7 tests/unit/health.test.ts

**テストケース:**

#### GET /health

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | Discord接続時は200 OKを返す | status=200, status="ok" |
| 2 | Discord未接続時は503を返す | status=503, status="unhealthy" |
| 3 | ping負値の場合はnullを返す | ping=null |

#### Other endpoints

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 未知のパスは404を返す | status=404 |
| 2 | ルートパスは404を返す | status=404 |

---

### 5.8 tests/integration/db/guildSettingsRepository.test.ts

**使用リソース:** インメモリDB (`:memory:`)

**テストケース:**

#### findByGuildId

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 存在しないギルドIDはnullを返す | `null` |
| 2 | 存在するギルドの設定を返す | GuildSettings |
| 3 | カラムマッピングが正しい（snake_case → camelCase） | プロパティ名変換 |

#### upsert

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 新規レコードを挿入する | INSERT |
| 2 | 既存レコードを更新する | UPDATE |
| 3 | defaultModelが未指定の場合はデフォルト値を使用 | デフォルトモデル |
| 4 | createdAtとupdatedAtが設定される | タイムスタンプ |
| 5 | 更新時にupdatedAtのみ変更される | 部分更新 |

#### delete

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 存在するレコードを削除してtrueを返す | `true` |
| 2 | 存在しないレコードの削除はfalseを返す | `false` |

#### 並行操作

| # | テスト名 | 期待動作 |
| - | -------- | -------- |
| 1 | 複数の異なるギルドを同時に操作できる | 全て成功 |

---

## 6. 統合テストの範囲

### 対象

| テスト | 範囲 | 使用リソース |
| ------ | ---- | ------------ |
| DB統合テスト | Repository + SQLite | インメモリDB |

### 対象外（将来検討）

| テスト | 理由 |
| ------ | ---- |
| Discord.js統合 | Botトークンが必要、E2Eに近い |
| OpenRouter実API | 課金発生、レート制限リスク |

---

## 7. 実行コマンド

```bash
# 全テスト実行
bun test

# 特定ファイル
bun test tests/unit/utils/message.test.ts

# ウォッチモード
bun test --watch

# カバレッジ
bun test --coverage

# 特定パターン
bun test --grep "splitIntoChunks"
```

---

## 8. 実装チェックリスト

- [x] `tests/helpers/mockFactories.ts` - 共通モックファクトリ
- [x] `tests/unit/utils/message.test.ts` - 優先度1
- [x] `tests/unit/services/chatService.test.ts` - 優先度2
- [x] `tests/unit/services/settingsService.test.ts` - 優先度3
- [x] `tests/unit/llm/openrouter.test.ts` - 優先度4
- [x] `tests/integration/db/guildSettingsRepository.test.ts` - 優先度5
- [x] `tests/unit/utils/logger.test.ts` - 優先度6
- [x] `tests/unit/health.test.ts` - v1.0.1追加

---

## 9. 注意事項

### モック復元

各テストファイルで `afterEach` または `afterAll` でモックを復元すること。特に `globalThis.fetch` の復元は必須。

### 非同期テスト

Repository/Serviceメソッドは全て `Promise` を返すため、`await` を忘れないこと。

### 型安全性

モックファクトリでインターフェース型を維持することで、実装変更時にテストも追従しやすくなる。

---

## 更新履歴

| 日付 | 内容 |
| ---- | ---- |
| 2025-12-12 | 初版作成 |
| 2025-12-12 | 全テスト実装完了（54テスト） |
| 2025-12-19 | health.test.ts追加（59テスト） |
