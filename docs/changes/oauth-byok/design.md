# OAuth BYOK（OpenRouter キー接続）

## Why

現状、ボットを使うには各自が OpenRouter API キーを発行してホスティングする必要がある。
一般ユーザーにとってこのハードルは高く、ボットの利用拡大を阻害している。
OAuth PKCE でユーザーまたは Guild 管理者が OpenRouter アカウントを接続し、
自分のクレジットで LLM を利用できるようにする。

## Goals / Non-Goals

**Goals:**

- Discord ユーザーが `/connect user` で自分の OpenRouter アカウントを接続できる
- Guild 管理者が `/connect guild` で Guild 用の OpenRouter アカウントを接続できる
- キー解決の優先順位: ユーザーキー → Guild キー → デフォルトキー
- `/disconnect user|guild` で接続を解除できる
- API キーは暗号化して DB に保存する
- 未接続時のフォールバック動作をホスティング者が制御可能

**Non-Goals:**

- OpenRouter 以外のプロバイダーへの対応
- ユーザー/Guild ごとの利用量制限・課金管理（OpenRouter 側の機能に委ねる）
- リフレッシュトークンの管理（OAuth PKCE で発行されるのは永続的な API キー）
- Guild ポリシー（キー解決順序のカスタマイズ）は初回スコープ外。需要に応じて後追加

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 認証方式 | OAuth PKCE (S256) | OpenRouter 公式サポート。セキュリティ面で plain より優位 |
| キー保存 | SQLite + AES-256-GCM 暗号化 | 既存 DB インフラを活用。暗号化キーは環境変数で管理 |
| キー解決順序 | ユーザー → Guild → デフォルト | ユーザーの自律性を尊重しつつ Guild 一括設定も可能 |
| フォールバック | デフォルトキー使用（設定可能） | `ALLOW_UNAUTHENTICATED` で制御 |
| OAuth state 管理 | インメモリ Map + TTL | 短命（10分）のため DB 保存は不要 |
| コールバック方式 | 既存 HTTP サーバーに `/auth/callback` を追加 | 新規サーバー不要 |
| キー検証 | 接続時に `/api/v1/credits` を呼んで検証 | キーの有効性を即時確認 |
| DB テーブル設計 | `api_keys` 1テーブル + `scope` カラム | user/guild を統一管理。テーブル分割は不要な複雑さ |

## Design

### フロー図

```text
Discord                    Bot                     OpenRouter
  │                         │                          │
  │  /connect user|guild    │                          │
  ├────────────────────────>│                          │
  │                         │  state + PKCE 生成       │
  │                         │  state を Map に保存     │
  │                         │  (userId, scope, guildId)│
  │  認証URL (Ephemeral)    │                          │
  │<────────────────────────┤                          │
  │                         │                          │
  │  ブラウザで認証URL を開く│                          │
  ├─────────────────────────┼─────────────────────────>│
  │                         │                          │  ログイン・承認
  │                         │  GET /auth/callback      │
  │                         │  ?code=xxx&state=yyy     │
  │                         │<─────────────────────────┤
  │                         │                          │
  │                         │  POST /api/v1/auth/keys  │
  │                         │  (code + code_verifier)  │
  │                         ├─────────────────────────>│
  │                         │  { key: "sk-or-..." }    │
  │                         │<─────────────────────────┤
  │                         │                          │
  │                         │  キーを暗号化して DB 保存 │
  │                         │  GET /api/v1/credits     │
  │                         │  で有効性を確認           │
  │                         │                          │
  │  「接続完了」DM          │                          │
  │<────────────────────────┤                          │
```

### キー解決ロジック

```text
resolveApiKey(userId, guildId):
  1. api_keys WHERE owner_id = userId AND scope = 'user' → 見つかれば使用
  2. api_keys WHERE owner_id = guildId AND scope = 'guild' → 見つかれば使用
  3. ALLOW_UNAUTHENTICATED = true → デフォルトキー使用
  4. エラー: 「/connect でアカウントを接続してください」
```

### DB スキーマ変更

```sql
CREATE TABLE api_keys (
  owner_id TEXT NOT NULL,              -- Discord User ID or Guild ID
  scope TEXT NOT NULL CHECK (scope IN ('user', 'guild')),
  encrypted_key TEXT NOT NULL,         -- AES-256-GCM 暗号化済みキー
  iv TEXT NOT NULL,                    -- 初期化ベクトル (Base64)
  auth_tag TEXT NOT NULL,              -- 認証タグ (Base64)
  connected_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, scope)
);
```

### 新規環境変数

| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| `ENCRYPTION_KEY` | OAuth 使用時 | API キー暗号化用の 256-bit キー (hex) |
| `OAUTH_CALLBACK_URL` | OAuth 使用時 | OAuth コールバック URL (例: `https://bot.example.com/auth/callback`) |
| `ALLOW_UNAUTHENTICATED` | No | 未接続時にデフォルトキーを使わせるか (`true`/`false`, default: `true`) |

### 変更対象ファイル

#### 新規ファイル

| ファイル | 役割 |
| -------- | ---- |
| `src/services/oauthService.ts` | OAuth フロー管理、PKCE 生成、キー交換、キー解決 |
| `src/services/cryptoService.ts` | API キーの暗号化/復号 |
| `src/db/repositories/apiKey.ts` | API キーの CRUD |
| `src/bot/commands/connect.ts` | `/connect` コマンド定義 |
| `tests/unit/services/oauthService.test.ts` | OAuth サービスのテスト |
| `tests/unit/services/cryptoService.test.ts` | 暗号化サービスのテスト |
| `tests/unit/db/repositories/apiKey.test.ts` | リポジトリのテスト |

#### 変更ファイル

| ファイル | 変更内容 |
| -------- | -------- |
| `src/config/index.ts` | 新規環境変数の追加（optional） |
| `src/config/envVars.ts` | 環境変数定義の追加 |
| `src/db/schema.ts` | `api_keys` テーブルのマイグレーション追加 |
| `src/health.ts` | `/auth/callback` エンドポイント追加 |
| `src/llm/openrouter.ts` | API キーを引数で受け取れるようにメソッド拡張 |
| `src/services/chatService.ts` | キー解決ロジック追加 (userId 引数追加) |
| `src/bot/commands/index.ts` | `/connect`, `/disconnect` コマンド登録 |
| `src/bot/commands/handlers.ts` | connect/disconnect ハンドラー追加 |
| `src/bot/events/messageCreate.ts` | auto-reply 時のキー解決 |
| `src/types/index.ts` | `ApiKeyRecord`, `ApiKeyScope` 型の追加 |
| `src/index.ts` | 新規サービスの DI 配線 |
| `src/errors/index.ts` | `OAuthError` クラス追加 |

### インターフェース設計

```typescript
// types
type ApiKeyScope = "user" | "guild";

interface ApiKeyRecord {
  ownerId: string;          // Discord User ID or Guild ID
  scope: ApiKeyScope;
  encryptedKey: string;
  iv: string;
  authTag: string;
  connectedAt: string;
  updatedAt: string;
}

// OAuth state (in-memory)
interface OAuthState {
  userId: UserId;
  scope: ApiKeyScope;
  guildId?: GuildId;        // scope='guild' の場合に必要
  codeVerifier: string;
  createdAt: number;
}
```

```typescript
// src/services/oauthService.ts
interface IOAuthService {
  /** 認証URLとstateを生成 */
  createAuthorizationUrl(
    userId: UserId,
    scope: ApiKeyScope,
    guildId?: GuildId
  ): { url: string; state: string };

  /** コールバックからAPIキーを取得・保存 */
  handleCallback(state: string, code: string): Promise<{
    userId: UserId;
    scope: ApiKeyScope;
    ownerId: string;
  }>;

  /** キー解決: ユーザー → Guild → デフォルト → null */
  resolveApiKey(userId: UserId, guildId?: GuildId): Promise<string | null>;

  /** 接続を解除 */
  disconnect(ownerId: string, scope: ApiKeyScope): Promise<void>;

  /** 接続状態を確認 */
  isConnected(ownerId: string, scope: ApiKeyScope): Promise<boolean>;
}

// src/services/cryptoService.ts
interface ICryptoService {
  encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string };
  decrypt(ciphertext: string, iv: string, authTag: string): string;
}

// src/db/repositories/apiKey.ts
interface IApiKeyRepository {
  findByOwner(ownerId: string, scope: ApiKeyScope): ApiKeyRecord | null;
  upsert(record: ApiKeyRecord): void;
  deleteByOwner(ownerId: string, scope: ApiKeyScope): void;
}
```

### OpenRouterClient の変更

```typescript
// 現状: 固定キー
chat(request: ChatCompletionRequest): Promise<...>

// 変更後: オプショナルでキーを上書き可能に
chat(request: ChatCompletionRequest, apiKeyOverride?: string): Promise<...>
chatStream(request: ChatCompletionRequest, signal?: AbortSignal, apiKeyOverride?: string): AsyncGenerator<...>
```

### ChatService の変更

```typescript
// 現状
generateResponseStream(guildId: GuildId, userMessage: string, requestId: string)

// 変更後: userId を追加
generateResponseStream(
  guildId: GuildId,
  userId: UserId,
  userMessage: string,
  requestId: string
)
```

キー解決は `IOAuthService.resolveApiKey(userId, guildId)` に委譲。
返値が `null` かつ `ALLOW_UNAUTHENTICATED=false` の場合はエラー。

### コマンド設計

```text
/connect user       -- 自分の OpenRouter アカウントを接続
/connect guild      -- Guild 用の OpenRouter アカウントを接続 (ManageGuild 権限必要)
/disconnect user    -- 自分の接続を解除
/disconnect guild   -- Guild の接続を解除 (ManageGuild 権限必要)
/connect status     -- 自分と Guild の接続状態を確認
```

### コールバックページ

`/auth/callback` のレスポンスは最小限の HTML を返す:

- 成功時: 「接続完了。Discord に戻ってください。」
- 失敗時: 「接続に失敗しました。もう一度お試しください。」

加えて、Bot から Discord DM で接続結果を通知する。

### セキュリティ考慮事項

- **暗号化キー**: `ENCRYPTION_KEY` は 256-bit (32バイト) の hex 文字列。`openssl rand -hex 32` で生成
- **State パラメータ**: CSRF 防止。crypto.randomUUID() で生成、10分 TTL
- **PKCE**: code_verifier は 43-128 文字のランダム文字列、S256 ハッシュで送信
- **Ephemeral メッセージ**: 認証 URL は本人のみ見える Ephemeral で送信
- **DM 通知**: 接続完了/失敗は DM で通知（サーバーチャットに漏れない）
- **Guild 権限**: `/connect guild` は `ManageGuild` 権限を持つユーザーのみ実行可能

## Tasks

- [ ] 1. DB: `api_keys` テーブルのマイグレーション追加 (`schema.ts`)
- [ ] 2. 型定義: `ApiKeyRecord`, `ApiKeyScope`, `OAuthState` を追加 (`types/index.ts`)
- [ ] 3. `CryptoService`: AES-256-GCM 暗号化/復号の実装 + テスト
- [ ] 4. `ApiKeyRepository`: CRUD 実装 + テスト
- [ ] 5. `OAuthService`: PKCE 生成、認証 URL 作成、コールバック処理、キー解決 + テスト
- [ ] 6. `OpenRouterClient`: `apiKeyOverride` パラメータ追加
- [ ] 7. HTTP サーバー: `/auth/callback` エンドポイント追加 (`health.ts`)
- [ ] 8. `/connect`, `/disconnect` コマンド定義 + ハンドラー実装
- [ ] 9. `ChatService`: キー解決ロジック追加 (userId 引数追加)
- [ ] 10. `messageCreate`: auto-reply 時の userId 伝搬
- [ ] 11. 環境変数: `ENCRYPTION_KEY`, `OAUTH_CALLBACK_URL`, `ALLOW_UNAUTHENTICATED` 追加
- [ ] 12. DI 配線: `index.ts` に新規サービス追加
- [ ] 13. 結合テスト: connect → chat → disconnect のフロー確認
