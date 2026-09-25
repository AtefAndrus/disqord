---
title: "OAuth BYOK（ユーザー別 OpenRouter キー）"
status: investigating
priority: high
summary: "OAuth PKCE によるユーザー別 OpenRouter API キー（BYOK）"
---

# OAuth BYOK（OpenRouter キー接続）

## Why

ボットの LLM 利用料は、ホスティング者が環境変数で渡す 1 本の OpenRouter API キーにすべて請求される。
利用者が増えるほどホスティング者の負担が増え、利用者は自分のクレジットで高いモデルを使うこともできない。
OAuth PKCE でユーザーまたは Guild 管理者が自分の OpenRouter アカウントを接続し、そのクレジットで LLM を利用できるようにする。

## 依存 / 関連 change

- 連携: [使用量統計](../usage-stats/design.md) — どのキーが支払ったか（user / guild / default）を記録する列が要る。本 change のキー解決結果がその値の出どころになる
- 連携: [設定階層化](../settings-hierarchy/design.md) — ユーザー → Guild → デフォルトという解決順序は似ているが、API キーは設定値ではなく秘密情報なので、テーブルも解決ロジックも分けたままにする
- 先行: [ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) — `/connect guild` と `/disconnect guild` の認可は同 change の共通認可関数 `canManageGuildSettings` で判定する
- 関連: [設定パネル（/config の再構成）](https://github.com/AtefAndrus/disqord/blob/67291dde3d1ca40f9243d10430e98c3600341dbf/docs/changes/config-panel/design.md) — `/connect` と `/disconnect` は同 change のパネルに載せず、独立したコマンドのままにする
- 連携: [コード実行](../code-execution/design.md) — コンテナは API キーの workspace に scope されるので、生成ファイルの取得は、その生成に使ったのと同じキーで行う必要がある

## Goals / Non-Goals

**Goals:**

- Discord ユーザーが `/connect user` で自分の OpenRouter アカウントを接続できる
- Guild 管理者が `/connect guild` で Guild 用の OpenRouter アカウントを接続できる
- キー解決の優先順位: ユーザーキー → Guild キー → デフォルトキー
- `/disconnect user|guild` で接続を解除できる
- API キーは暗号化して DB に保存する
- 未接続時にデフォルトキーを使わせるかをホスティング者が制御できる

**Non-Goals:**

- OpenRouter 以外のプロバイダーへの対応
- ユーザー / Guild ごとの利用量制限と課金管理（OpenRouter 側の機能に委ねる）
- リフレッシュトークンの管理（OAuth PKCE で発行されるのは失効期限のない API キーである）
- Guild ポリシー（キー解決順序のカスタマイズ）
- `ENCRYPTION_KEY` のローテーション

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 認証方式 | OAuth PKCE (S256) | OpenRouter が公式にサポートする。plain より S256 のほうが code_verifier の漏洩に強い |
| 認可コードの受け取り | 未決（推奨は headless モード） | 設計メモ「認可コードの受け取り方」で比較する |
| キー保存 | SQLite + AES-256-GCM 暗号化 | 既存 DB をそのまま使う。暗号化キーは環境変数で渡す |
| キー解決順序 | ユーザー → Guild → デフォルト | 本人が接続していれば本人が払い、Guild が一括で払う運用も選べる |
| 未接続時の扱い | `ALLOW_UNAUTHENTICATED` で制御（既定 `true`） | 既定を `true` にすれば、本 change を入れても既存の Guild の挙動が変わらない |
| 解決したキーが無効だった場合 | 下位のキーへフォールバックせずエラーにする | 失効したユーザーキーの代わりに Guild やホスティング者のキーへ黙って請求すると、支払う側が意図しない請求を受ける |
| キーの渡し方 | キーごとに `OpenRouterClient` を生成する | 設計メモ「OpenRouterClient へのキーの渡し方」で比較する |
| キー検証 | 接続時に `GET /api/v1/key` を取得したキーで呼ぶ | 取得したキー自身の Bearer で呼べる。`GET /api/v1/credits` は Management key を要するため使わない |
| DB テーブル設計 | `api_keys` 1 テーブル + `scope` カラム | user と guild を同じ処理で扱える。テーブルを分けても得るものがない |

## Design

### OpenRouter OAuth の仕様（2026-09-24 に OAuth ガイドと `openapi.json` で確認）

| 段階 | エンドポイント | 内容 |
| ---- | -------------- | ---- |
| 認可 | `https://openrouter.ai/auth?code_challenge=<S256(code_verifier)>&code_challenge_method=S256[&callback_url=<URL>][&key_label=<ラベル>]` | ユーザーのブラウザで開く。`callback_url` を付けると認可後に `?code=` 付きでそこへリダイレクトし、付けないと（headless モード）認可コードを画面に表示する |
| キー交換 | `POST /api/v1/auth/keys`（body: `{ code, code_verifier, code_challenge_method: "S256" }`） | レスポンスは `{ key, user_id }`。`user_id` は nullable の OpenRouter アカウント識別子で、Discord の ID とは別物なので保存しない |
| キー検証 | `GET /api/v1/key`（`Authorization: Bearer <取得したキー>`） | 200 なら有効、401 なら無効。`limit_remaining` などキー単位の情報が返る |

- 認可コードは一度しか使えず、発行から 10 分で失効する（期限切れは `403 Authorization code expired`）。
- headless モードでは `code_challenge` が必須である。コードが画面に表示されても、Bot が持つ `code_verifier` なしには交換できない。
- 任意パラメータに `key_label`（作成されるキーのラベルの初期値）、`workspace_id`（workspace の初期選択）、`required_workspace_id`（workspace の固定）がある。本 change は `key_label` だけを使い、workspace の選択は接続するユーザーに任せる。
- ガイドの認可 URL には `state` パラメータがなく、リダイレクト先に付くのは `code` だけである。
- `openapi.json` は `POST /api/v1/auth/keys` に操作個別の `security` を定義しておらず、グローバルの `apiKey` security を継承する。一方ガイドの例は `Authorization` ヘッダなしで呼んでいる。ヘッダが要るかは未検証で、実装時に実際に交換して確かめる。
- `POST /api/v1/auth/keys/code` は、サーバー側から認可コードを作るための別の操作であり、ユーザーがブラウザで認可するこのフローでは使わない。
- `POST /api/v1/oauth/token` は workload identity 向けのトークン交換（RFC 8693）であり、このフローとは関係がない。

### 認可コードの受け取り方

Bot が認可コードを受け取る方法は二つあり、どちらを採るかが本 change の主な未決事項である。

**A. headless モード（推奨）**：`callback_url` を付けずに認可 URL を開かせ、OpenRouter の画面に表示された認可コードを、ユーザーが Discord の Modal に貼り付ける。

```text
Discord                        Bot                          OpenRouter
  │ /connect user|guild         │                               │
  ├────────────────────────────>│ code_verifier 生成             │
  │                             │ pending に保存 (15 分)         │
  │ Ephemeral: [認可ページを開く]│                               │
  │            [コードを入力]    │                               │
  │<────────────────────────────┤                               │
  │ ブラウザで認可ページを開く、ログインして承認                    │
  ├─────────────────────────────┼──────────────────────────────>│
  │ 画面に認可コードが表示される                                   │
  │<────────────────────────────┼───────────────────────────────┤
  │ [コードを入力] → Modal に貼り付けて送信                         │
  ├────────────────────────────>│ POST /api/v1/auth/keys        │
  │                             ├──────────────────────────────>│
  │                             │ { key, user_id }              │
  │                             │<──────────────────────────────┤
  │                             │ GET /api/v1/key で検証         │
  │                             │ 暗号化して DB 保存              │
  │ Ephemeral: 接続完了          │                               │
  │<────────────────────────────┤                               │
```

- 公開 HTTPS の受け口が要らず、`OAUTH_CALLBACK_URL` も要らない。self-hosted の Bot では、HTTP サーバー（`src/health.ts` の `startHttpServer`）を外部に公開しない構成が多いと考えられるので、この差が大きい。
- CSRF 対策の `state` が要らない。pending エントリは `/connect` を実行した Discord ユーザーに紐づき、Modal の送信は Discord がそのユーザーからのものとして届けるので、別人が他人の pending に認可コードを差し込む経路がない。
- 結果は Modal 送信の interaction に Ephemeral で返すので、DM も元の返信の編集も要らない。
- 代わりにユーザーはコードをコピーして貼り付ける手間が一つ増える。
- ガイドは、localhost の callback ではアプリ名が `localhost:<port>` に固定され、公開 URL の callback を使うとアプリ名と marketplace への掲載が得られると書いている。headless で作られたキーのアプリ帰属がどう表示されるかは未検証である。

**B. 公開コールバック**：`callback_url` に Bot の公開 HTTPS URL を渡し、OpenRouter からのリダイレクトを Bot の HTTP サーバーで受ける。

- ユーザーは認可ページで承認するだけで済み、コードの貼り付けが要らない。
- ホスティング者が Bot の HTTP サーバーを公開 HTTPS で到達可能にし、その URL を `OAUTH_CALLBACK_URL` で渡す必要がある。受け口は `src/health.ts` の `Bun.serve` の `routes` に `/auth/callback` を足し、処理本体は管理 API（`src/http/adminEndpoints.ts`）と同じく `src/http/` に置く。
- リダイレクトには `code` しか付かないので、CSRF 対策の `state` は `callback_url` 自体のクエリに埋め込み（例: `callback_url=https%3A%2F%2Fbot.example.com%2Fauth%2Fcallback%3Fstate%3D<state>`）、pending エントリと突合する。OpenRouter がこのクエリを保ったままリダイレクトするかは未検証である。
- 結果はコールバックとは別の経路で Discord に届ける必要がある。DM はユーザーが DM を閉じていると送れないので使わない。`/connect` の interaction token は 15 分有効であり、認可コードの寿命（10 分）より長いので、`/connect` の Ephemeral 返信を編集して結果を伝える。
- コールバックページ自体は最小限の HTML（「接続完了。Discord に戻ってください。」または失敗の案内）を返す。

A を推奨する。
B の利点はコードの貼り付けを省けることだが、そのためにホスティング者全員に公開 HTTPS の用意を求め、`state` の受け渡しという未検証の前提を抱えることになる。
接続は一人一回の操作なので、貼り付けの手間は利用のたびに払うものではない。
アプリ名の帰属を重視するなら、A を既定にして `OAUTH_CALLBACK_URL` が設定されたときだけ B を使う併用も考えられるが、受け口と `state` 管理を両方持つことになるので、需要が出てから追加する。

### キー解決

```text
resolveApiKey(userId, guildId):
  1. api_keys WHERE owner_id = userId AND scope = 'user'  → { key, source: 'user' }
  2. api_keys WHERE owner_id = guildId AND scope = 'guild' → { key, source: 'guild' }
  3. ALLOW_UNAUTHENTICATED = true → { key: デフォルトキー, source: 'default' }
  4. null（呼び出し側が「/connect でアカウントを接続してください」と返す）
```

`source` は使用量統計が支払元として記録する値であり、コード実行のファイル取得など、同じ応答の後続処理が同じキーを使うための手がかりにもなる。

`src/` の OpenRouter クライアント呼び出し元と、それぞれが使うキーは次のとおりである。

| 呼び出し元 | 用途 | 使うキー |
| ---------- | ---- | -------- |
| `runToolLoop()` の `llmClient.chatStream()`（`src/llm/toolLoop.ts:527`）。`ChatService.runChatLoop()`（`src/services/chatService.ts:416`）が `llmClient` を渡す | 応答生成 | `resolveApiKey(ctx.userId, guildId)` の結果 |
| `ChatService.generateResponse()` の `llmClient.chat()`（`src/services/chatService.ts:205`） | 非 streaming の応答生成 | 同上。ただし `src/` 内に呼び出し元がないので、キー解決を足すか、メソッドごと削除するかを実装時に決める |
| `/status` の `llmClient.getCredits()`（`src/bot/commands/handlers.ts:173`）と、`/status` のボタン操作後の再描画（`src/bot/events/interactionCreate.ts:356`） | 残クレジット表示（`GET /api/v1/key`） | Guild キーがあれば Guild キー、なければデフォルトキー。`/status` は Ephemeral ではないので、ユーザーキーの残高はここに出さず `/connect status` で本人にだけ見せる。[設定パネル](https://github.com/AtefAndrus/disqord/blob/67291dde3d1ca40f9243d10430e98c3600341dbf/docs/changes/config-panel/design.md) の描き直しは DB の設定だけで行い残高を取りに行かないので、キーの選択は要らない |
| `ModelService` の `listModelsWithPricing()`（`src/services/modelService.ts:65`） | 全 Guild で共有するモデル一覧キャッシュ | デフォルトキー。キャッシュは 1 つなので、キーごとに引き直さない |
| `OpenRouterClient.listModels()`（`src/llm/openrouter.ts:1226`） | モデル ID 一覧 | クライアント内部から `listModelsWithPricing()` を呼ぶだけで、外部の呼び出し元はない。キーは生成元クライアントのものになる |

`ChatService.generateChatResponse(guildId, input, requestId, updater, ctx)` の `ctx`（`ChatRequestContext`）はすでに `userId` と `channelId` を持つ（`src/services/chatService.ts:36-53`）ので、キー解決のために引数を足す必要はない。
`messageCreate` も `ctx` に投稿者の ID を入れて呼んでいるので、自動応答を含めて変更は要らない。

### OpenRouterClient へのキーの渡し方

`OpenRouterClient` はキーをコンストラクタで受け取り（`src/llm/openrouter.ts:620`）、すべてのリクエストでそのキーを `Authorization` ヘッダに使う。
リクエストごとに別のキーを使う方法は二つある。

- **キーごとのインスタンス（採用）**：解決したキーで `OpenRouterClient` を生成し、それを `runToolLoop()` の `llmClient`（`src/llm/toolLoop.ts:96`）に渡す。`ILLMClient` のシグネチャも `runToolLoop()` も変わらない。レート制限の状態（`rateLimitResetAt`、`src/llm/openrouter.ts:618`）もインスタンスごとに分かれるので、あるユーザーのキーが 429 を受けても他のユーザーのリクエストは止まらない。インスタンスはキーのハッシュを鍵にした上限付きのキャッシュで再利用し、429 の状態をリクエストをまたいで保つ。
- **呼び出しごとの上書き**：`chat()` / `chatStream()` / `getCredits()` に `apiKey` 引数を足し、`IToolLoopParams` から `chatStream()` まで運ぶ。`ILLMClient` を実装するすべての mock を変える必要があり、単一インスタンスが持つレート制限の状態もキーごとに分け直す必要がある。キーを `IToolLoopParams.requestFields` で運ぶことはできない。`requestFields` はリクエスト body にそのまま展開される（`src/llm/toolLoop.ts:1037`）ので、キーが body に載ってしまう。

前者を採る理由は、既存の境界（コンストラクタで受け取るキーと、`runToolLoop()` が受け取るクライアント）を変えずに済み、レート制限の分離も構造から得られるからである。
復号済みのキーはキャッシュ中のインスタンスがメモリに保持するので、`/disconnect` ではキャッシュからも除く。

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
| `ENCRYPTION_KEY` | OAuth 使用時 | API キー暗号化用の 256-bit キー (hex)。`openssl rand -hex 32` で生成する |
| `ALLOW_UNAUTHENTICATED` | No | 未接続時にデフォルトキーを使わせるか (`true`/`false`, default: `true`) |
| `OAUTH_CALLBACK_URL` | B を採る場合のみ | OAuth コールバック URL (例: `https://bot.example.com/auth/callback`) |

### 変更対象ファイル

A（headless モード）を採る場合の一覧である。

- 新規: `src/services/oauthService.ts` — PKCE 生成、認可 URL 作成、pending 管理、キー交換と検証、キー解決
- 新規: `src/services/cryptoService.ts` — API キーの暗号化と復号
- 新規: `src/db/repositories/apiKey.ts` — API キーの CRUD
- 新規: `src/bot/commands/connect.ts` — `/connect` と `/disconnect` のコマンド定義
- 新規: `tests/unit/services/oauthService.test.ts` / `tests/unit/services/cryptoService.test.ts` / `tests/unit/db/repositories/apiKey.test.ts`
- 修正: `src/config/envVars.ts` / `src/config/index.ts` — 新規環境変数（optional）
- 修正: `src/db/schema.ts` — `api_keys` テーブル追加
- 修正: `src/services/chatService.ts` — `ctx.userId` と `guildId` でキーを解決し、そのキーのクライアントを `runToolLoop()` に渡す
- 修正: `src/bot/commands/index.ts` / `src/bot/commands/handlers.ts` — `/connect` と `/disconnect` の登録とハンドラー、`/status` の残高表示のキー選択
- 修正: `src/bot/events/interactionCreate.ts` — 「コードを入力」ボタンと Modal 送信の処理、`/status` 再描画時のキー選択
- 修正: `src/bot/events/messageCreate.ts` — キーを解決できなかったときの案内
- 修正: `src/types/index.ts` — `ApiKeyRecord`, `ApiKeyScope` 型
- 修正: `src/index.ts` — 新規サービスとクライアントキャッシュの DI 配線
- 修正: `src/errors/index.ts` — `OAuthError` クラス

B を採る場合は `src/http/` にコールバック処理を置き、`src/health.ts` の `routes` に `/auth/callback` を登録する。

### インターフェース設計

```typescript
// types
type ApiKeyScope = "user" | "guild";
type ApiKeySource = ApiKeyScope | "default";

interface ApiKeyRecord {
  ownerId: string;          // Discord User ID or Guild ID
  scope: ApiKeyScope;
  encryptedKey: string;
  iv: string;
  authTag: string;
  connectedAt: string;
  updatedAt: string;
}

// pending 接続（in-memory、TTL 15 分）
interface PendingConnection {
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
  /** code_verifier を生成して pending に保存し、認可 URL を返す */
  startConnection(userId: UserId, scope: ApiKeyScope, guildId?: GuildId): string;

  /** pending の code_verifier で認可コードを交換し、検証してから保存する */
  completeConnection(userId: UserId, scope: ApiKeyScope, guildId: GuildId | undefined, code: string): Promise<void>;

  /** ユーザー → Guild → デフォルト。解決できなければ null */
  resolveApiKey(userId: UserId, guildId?: GuildId): Promise<{ key: string; source: ApiKeySource } | null>;

  disconnect(ownerId: string, scope: ApiKeyScope): Promise<void>;
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

### コマンド設計

```text
/connect user       -- 自分の OpenRouter アカウントを接続
/connect guild      -- Guild 用の OpenRouter アカウントを接続（canManageGuildSettings で認可）
/connect status     -- 自分と Guild の接続状態と、自分のキーの残高を Ephemeral で表示
/disconnect user    -- 自分の接続を解除
/disconnect guild   -- Guild の接続を解除（canManageGuildSettings で認可）
```

`/connect guild` と `/disconnect guild` の認可は、[ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) の共通認可関数 `canManageGuildSettings` で判定する。

### セキュリティ考慮事項

- **PKCE**: code_verifier は 43-128 文字のランダム文字列とし、S256 のハッシュだけを認可 URL に載せる。code_verifier はボタンの `customId` にも Modal にも載せず、Bot のメモリにだけ置く。
- **pending の寿命**: 15 分で破棄する。認可コード自体は発行から 10 分で失効するので、ログインや承認に時間がかかっても 15 分あれば足りる。Bot を再起動すると pending は消え、ユーザーは `/connect` からやり直す。
- **Ephemeral メッセージ**: 認可 URL、コード入力の案内、接続結果は、本人にだけ見える Ephemeral で返す。
- **暗号化キー**: `ENCRYPTION_KEY` は 256-bit (32 バイト) の hex 文字列とする。
- **ログ**: 復号済みのキーと認可コードはログに出さない。

## Tasks

- [ ] 認可コードの受け取り方（A: headless / B: 公開コールバック）を確定する
- [ ] `POST /api/v1/auth/keys` に `Authorization` ヘッダが要るかを実キーで確かめる
- [ ] DB: `api_keys` テーブルのマイグレーション追加 (`schema.ts`)
- [ ] 型定義: `ApiKeyRecord`, `ApiKeyScope`, `ApiKeySource`, `PendingConnection` を追加
- [ ] `CryptoService`: AES-256-GCM 暗号化と復号の実装 + テスト
- [ ] `ApiKeyRepository`: CRUD 実装 + テスト
- [ ] `OAuthService`: PKCE 生成、認可 URL 作成、pending 管理、キー交換と検証、キー解決 + テスト
- [ ] キーごとの `OpenRouterClient` キャッシュと、`ChatService` からの利用
- [ ] `/connect`, `/disconnect` コマンド定義 + ハンドラー、コード入力ボタンと Modal の処理
- [ ] `/status` と `/connect status` の残高表示のキー選択
- [ ] 環境変数: `ENCRYPTION_KEY`, `ALLOW_UNAUTHENTICATED`（B なら `OAUTH_CALLBACK_URL`）追加
- [ ] DI 配線: `index.ts` に新規サービスを追加
- [ ] 結合テスト: connect → chat → disconnect のフロー確認
- [ ] `docs/changes/oauth-byok/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- 認可コードの受け取り方（設計メモ「認可コードの受け取り方」）。推奨は A である。
- headless モードで作られたキーが OpenRouter 上でどのアプリに帰属して表示されるかは未検証である。
- ユーザーが接続時に選んだ workspace によって、そのキーで使えるモデルやプロバイダーが Bot のモデル一覧キャッシュ（デフォルトキーで取得）と食い違う可能性がある。キーによって `/api/v1/models` の結果が変わるかは未検証である。
- 設定階層化の `free_models_only` は、ホスティング者や Guild の費用を抑えるための制約である。ユーザーが自分のキーで払う場合にもこの制約を課すかは、両 change のどちらかで決める必要がある。

## 参照

- [OpenRouter OAuth PKCE ガイド](https://openrouter.ai/docs/guides/overview/auth/oauth.md)
- [OpenRouter OpenAPI 定義](https://openrouter.ai/openapi.json) — `POST /auth/keys`, `GET /key`, `GET /credits`
