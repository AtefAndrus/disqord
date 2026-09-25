---
title: "設定階層化 + LLMパラメータ + カスタムプロンプト"
status: investigating
priority: medium
summary: "guild/channel/user 設定階層 + LLM パラメータ + カスタムプロンプト"
---

# 設定階層化 + LLMパラメータ + カスタムプロンプト

## Why

Bot の設定は Guild 単位でしか持てず、チャンネルやユーザーごとに使い分けられない。
例えば、技術チャンネルではコード向けのモデル、雑談チャンネルでは汎用モデルを使うといった運用ができない。
temperature などの LLM パラメータや、システムプロンプトを変える手段もない。

## 依存 / 関連 change

- 先行: [Responses API への移行](https://github.com/AtefAndrus/disqord/blob/2b2a78350778992e14d014a42b09825df05718c1/docs/changes/responses-api-migration/design.md) — 解決済みパラメータを全ターンへ渡す経路（`IToolLoopParams.requestFields`）は同 change が用意した。あわせて送信できるパラメータ集合が Chat Completions より狭い（後述）
- 連携: [reasoning-output](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/reasoning-output/design.md) — reasoning の effort と token 上限は本 change の LLM パラメータで解決し、推論本文を表示するかどうかは同 change が入れた Guild 設定 `reasoning_display_enabled` で扱う
- 先行: [ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) — guild スコープと channel スコープへの書き込みは同 change の共通認可関数 `canManageGuildSettings` で認可する
- 先行: [設定パネル（/config の再構成）](../config-panel/design.md) — プロンプトと LLM パラメータの編集は、同 change の「プロンプトとパラメータ」ページと本人にだけ見える「自分の設定」のパネルに載せる。`/config` はサブコマンドを持たないので、本 change はサブコマンドや別のスラッシュコマンドを足さない
- 連携: [OAuth BYOK](../oauth-byok/design.md) — ユーザーが自分のキーで払う場合に `free_models_only` を課すかは、両 change のどちらかで決める必要がある

## Goals / Non-Goals

**Goals:**

- モデル、LLM パラメータ、カスタムシステムプロンプトを Guild / Channel / User の各スコープで上書きできる
- モデルごとの既定パラメータを考慮して LLM パラメータを解決する
- Guild が課す制約（`free_models_only`）を、下位スコープの上書きで迂回できないようにする

**Non-Goals:**

- ロール単位の設定（解決順序にロール間の優先度が加わり、複雑になりすぎる）
- 既存の Guild 設定トグル（Web 検索、会話履歴など）の階層化
- パラメータのプリセット機能
- プロンプトのバージョン管理
- reasoning 本文の取得と表示 UI（[reasoning-output](https://github.com/AtefAndrus/disqord/blob/5f1bfa49759e1d5ee74e97718d61adff81f2b601/docs/changes/reasoning-output/design.md) が実装済み）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 階層化する設定 | モデル、LLM パラメータ、システムプロンプトの 3 つ | チャンネルやユーザーで使い分けたい動機があるのはこの 3 つである。既存のトグルを Guild 専用に残す理由は設計メモ「階層化する設定と Guild 専用の設定」に書く |
| 設定優先順位 | User > Channel > Guild > モデル既定値 | 細かいスコープが粗いスコープを上書きする |
| Guild 制約との関係 | `free_models_only` は解決後のモデルに常に適用し、違反する上書きは飛ばす | ユーザーやチャンネルの上書きで有料モデルを選べると、Guild が費用を抑えるために有効にした制約が意味を失う |
| ユーザー設定の単位 | Guild ごと（`guild_id`, `user_id`） | Guild の制約や運用方針は Guild ごとに違い、ある Guild 向けのプロンプトが別の Guild で適切とは限らない |
| 書き込みの認可 | guild と channel は `canManageGuildSettings`、user は本人のみ | guild と channel の設定は他のメンバーの応答を変える。user の設定は本人の応答だけを変える |
| NULL 値の扱い | 上位スコープを継承 | 明示的に設定した項目だけを上書きする |
| パラメータ形式 | JSON 文字列（SQLite カラム） | 送信できるパラメータが増えてもスキーマを変えずに済む |
| パラメータの許可リスト | 本 change が持つ対応表のキー | Models API の `supported_parameters` は Chat Completions の名前を返し、Responses API で送れる名前と一致しない |
| カスタムプロンプトの置き場所 | Responses の `input` 先頭の system メッセージ | 設計メモ「プロンプトの置き場所と順序」に書く |
| 編集の入口 | プロンプトとパラメータは [設定パネル](../config-panel/design.md) の「プロンプトとパラメータ」ページと「自分の設定」のパネルで編集する。モデルは `/model set <model> [scope]` で設定する | 自由入力は modal に向き、保存値と実効値と由来を並べて見せられる。モデルは数百件から autocomplete で選ぶ必要があり、選択メニュー（最大 25 件）に収まらないのでスラッシュコマンドに残す |

## Design

### 階層化する設定と Guild 専用の設定

`guild_settings` の各カラム（`src/db/schema.ts:13-98`）を次のように扱う。

| カラム | 扱い | 理由 |
| ------ | ---- | ---- |
| `default_model` | 階層化（Guild の値になる） | 本 change の主目的である |
| `llm_params`（新規） | 階層化 | 同上 |
| `system_prompt`（新規） | 階層化 | 同上 |
| `free_models_only` | Guild 専用。解決後のモデルに対する制約として働く | 費用を抑えるための Guild の方針であり、下位スコープで緩められると意味がない |
| `web_search_enabled` | Guild 専用 | 検索ごとに課金されるので、費用の方針として Guild が決める |
| `history_enabled` | Guild 専用 | 会話履歴を読むかどうかは、その Guild のプライバシー方針として決める |
| `reasoning_display_enabled` | Guild 専用 | 推論本文を表示するかは、チャンネルに出る内容の方針として決める |
| `show_llm_details` | Guild 専用 | 表示の好みであり、階層化の需要が出たら別 change で扱う |
| `twitter_expand_enabled` | Guild 専用 | 同上 |
| `auto_reply_channels` | Guild 専用 | 値そのものがチャンネルの一覧なので、チャンネル単位の上書きと重なる |

Guild 専用のトグルは、[設定パネル](../config-panel/design.md) の「応答」「機能」ページで切り替える。

### 解決順序と Guild 制約

各項目を User → Channel → Guild の順に見て、最初に NULL でない値を使う。
LLM パラメータだけは JSON のキー単位でマージし、モデル既定値の上に Guild、Channel、User の順に重ねる。

モデルは解決した後に Guild 制約を当てる。
Guild の `free_models_only` が有効で、User または Channel で解決したモデルが無料でない場合は、そのスコープを飛ばして次のスコープのモデルを使う。
Guild のモデルも解決時に同じく確かめる。
`free_models_only` を有効にする時点の確認（`src/services/settingsService.ts` の `assertCanEnableFreeOnly`）はその時点の価格に対するもので、後でモデルが有料に変わると Guild のモデルも制約を満たさなくなる。
Guild のモデルまで制約を満たさない場合はリクエストを送らず、管理者に `/model set` で無料モデルを選び直すよう促すエラーを返す。
書き込み時にも、channel や user のモデルを `ModelService.validateModelSelection(model, freeModelsOnly)` で検証する。
それでも解決時に確かめるのは、上書きを保存した後に `free_models_only` が有効になる場合や、モデルが有料に変わる場合があるからである。

解決結果のモデルは、`ChatService.generateChatResponse` が現在 `settings.defaultModel` を使っているすべての箇所（ツイート展開の画像対応判定、モデル詳細の取得、リクエストの組み立て）と、`messageCreate` のモデル名表示と画像対応判定で使う。
`generateChatResponse` の `ctx`（`ChatRequestContext`）はすでに `channelId` と `userId` を持つので、解決に必要な情報は揃っている。

### 書き込みの認可

- guild スコープと channel スコープ: [ギルド設定変更の共通認可](https://github.com/AtefAndrus/disqord/blob/72517eb35f9d3e8928a954f83e12da2f445d9424/docs/changes/permissions/design.md) の共通認可関数 `canManageGuildSettings` で、書き込みのたびに認可する。パネルの「編集」の modal の送信と「上書きを削除」の押下、`/model set` の実行のすべてが対象である。
- user スコープ: 本人が自分の設定だけを書き換えられる。「自分の設定」のパネルは本人にだけ見える（ephemeral）ので、他のメンバーからは押せない。解決時に Guild 制約が常に勝つので、本人の上書きで Guild の費用方針を迂回することはできない。

### DB スキーマ変更

```sql
CREATE TABLE channel_settings (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT,  -- JSON: {temperature, top_p, ...}
    version INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
);

CREATE TABLE user_settings (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    model TEXT,
    system_prompt TEXT,
    llm_params TEXT,  -- JSON
    version INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
);

ALTER TABLE guild_settings ADD COLUMN llm_params TEXT;
ALTER TABLE guild_settings ADD COLUMN system_prompt TEXT;
```

DB は `PRAGMA foreign_keys = ON` で開く（`src/db/index.ts:11`）が、`guild_settings` の行は最初の書き込み時に作られる（`GuildSettingsRepository.update` の `insertDefaultRow`）。
そのため channel や user の設定を書く前に、Guild の既定行を同じトランザクションで作っておく必要がある。

### 設定パネルでの編集

[設定パネル](../config-panel/design.md) の「スコープ付き設定のページ」の形に載せる。

- 「プロンプトとパラメータ」ページ（チャンネルに公開）は guild と channel のスコープを扱う。対象のスコープを String Select で選び、channel のときは Channel Select で対象のチャンネルを選ぶ。
- 項目はモデル、LLM パラメータ、システムプロンプトの 3 つで、それぞれに選んだスコープの保存値、実際に効いている値、その値がどのスコープ由来か（モデル既定値を含む）を表示する。LLM パラメータの由来はキーごとに示す。
- LLM パラメータとシステムプロンプトは「編集」で modal を開いて書き換える。LLM パラメータは JSON の Text Input とし、送信時に後述の検証を行う。
- channel と user のスコープでは、3 項目とも「上書きを削除」で選んだスコープの値を NULL に戻して上位を継承させる。guild スコープでは LLM パラメータとシステムプロンプトだけを削除でき、モデルは削除できない（`guild_settings.default_model` は NOT NULL で、解決の最後の段なので継承先が無い）。モデルの設定は `/model set` で行い、パネルでは表示と上書きの削除だけを扱う。
- user スコープは、パネルの「自分の設定」ボタンから開く、本人にだけ見えるパネルで同じ操作を行う。
- modal の版の比較、下書き、「入力を修正する」による復旧は設定パネルの仕組みをそのまま使う。`channel_settings` と `user_settings` は、`guild_settings.settings_version` と同じ意味の `version` 列を行ごとに持ち、書き換えるたびに 1 増やす。modal はその行の版と比べる。

### /status の表示

`/status` は状態の表示に専念し、設定を変える部品を持たない（[設定パネル](../config-panel/design.md)）。
`/status` は Ephemeral ではない返信なので、Guild の設定の要約を表示し、実行したチャンネルに channel スコープの上書きがあれば、そのモデルと、プロンプトとパラメータが設定されているかどうかを 1 項目として加える。
user スコープの値は `/status` には出さず、本人が「自分の設定」のパネルで確かめる。

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `channel_settings`, `user_settings` テーブル追加、`guild_settings` へのカラム追加
- 新規: `src/db/repositories/` — channel と user の設定 Repository
- 修正: `src/services/settingsService.ts` — 階層解決と Guild 制約の適用
- 修正: `src/services/modelService.ts` — モデル既定パラメータの取得
- 修正: `src/services/chatService.ts` — 解決済みのモデル、パラメータ、プロンプトの適用
- 修正: `src/bot/events/messageCreate.ts` — 解決済みモデルでの表示と画像対応判定
- 修正: `src/bot/commands/` — `/model set` の scope
- 修正: `src/utils/configPanel.ts` / `src/bot/events/configPanelHandler.ts` — 「プロンプトとパラメータ」ページ、「自分の設定」のパネル、編集の modal と上書きの削除
- 修正: `src/utils/statusMessage.ts` — channel 上書きの表示

---

### LLM パラメータ

**モデルごとの既定パラメータ**:

1. `GET /api/v1/models` のレスポンスに含まれる `default_parameters` を使う。型は `object | null` なので、取得側で `default_parameters ?? {}` としてからマージする。object の場合の中身は `temperature` / `top_p` / `top_k` / `frequency_penalty` / `presence_penalty` / `repetition_penalty` で、いずれも nullable である。
2. `ModelService` がモデル一覧をキャッシュするときに一緒に保存する。
3. `repetition_penalty` は Responses API で送れない（後述）ので、既定値に含まれていてもマージの対象から外す。

**送信できるパラメータと対応表**:

Responses API（`POST /api/v1/responses`、`ResponsesRequest`）で送れるパラメータの集合は、Models API の `supported_parameters` が返す名前と一致しない。

- Responses に無いもの: `logit_bias` / `logprobs` / `min_p` / `repetition_penalty` / `response_format` / `seed` / `stop` / `top_a`。これらは `supported_parameters` に載っていても送れない。
- 名前や位置が違うもの: `max_tokens` / `max_completion_tokens` は `max_output_tokens`、`reasoning_effort` は `reasoning.effort`、`verbosity` は `text.verbosity` になる。
- `supported_parameters` は Chat Completions のパラメータ名を返す。全 445 モデル中 432 件が `max_tokens` を返し、`max_completion_tokens` を返すのは 63 件である（2026-09-18 に `GET /api/v1/models` で確認）。

そこで本 change は、能力判定に使う名前（Models API が返す名前）と、実際に送信するフィールドの対応表を持つ。

| 設定キー | 能力判定に使う `supported_parameters` の名前 | 送信先（`ResponsesRequest`） |
| -------- | ------------------------------------------ | ---------------------------- |
| `temperature` | `temperature` | `temperature` |
| `top_p` | `top_p` | `top_p` |
| `top_k` | `top_k` | `top_k` |
| `presence_penalty` | `presence_penalty` | `presence_penalty` |
| `frequency_penalty` | `frequency_penalty` | `frequency_penalty` |
| `max_output_tokens` | `max_tokens` または `max_completion_tokens` | `max_output_tokens` |
| `reasoning_effort` | `reasoning` または `reasoning_effort` | `reasoning.effort` |
| `reasoning_max_tokens` | `reasoning` | `reasoning.max_tokens` |
| `verbosity` | `verbosity` | `text.verbosity` |

対応表のキーだけが設定できるパラメータであり、表に無いキーは書き込み時に拒否する。
リクエストを組み立てるときは、解決したパラメータのうち、使うモデルの `supported_parameters` に対応する名前があるものだけを送る。
対応表は、ユーザー設定の検証とリクエストの組み立ての両方が参照する単一の定義にする。
`reasoning` は、`reasoning_display_enabled` が有効なときに `ChatService` が `{ summary: "auto" }` を設定している（`src/services/chatService.ts`）ので、`reasoning.effort` と `reasoning.max_tokens` はこのオブジェクトにマージする。
`temperature` などのトップレベルのフィールドは `IToolLoopParams.requestFields` で渡し、`runToolLoop()` がリクエスト body に展開する（`src/llm/toolLoop.ts:1037`）。

**設定の入口**:

- モデル: `/model set <model> [scope]`。scope は `guild`（既定）/ `channel` / `user` で、`channel` は実行したチャンネルを対象にする
- LLM パラメータ: 設定パネルの「編集」の modal に JSON で入力する。「上書きを削除」でそのスコープの設定を消して上位を継承させる
- 解決後の値と、各キーがどのスコープ由来かは、設定パネルの「プロンプトとパラメータ」ページと「自分の設定」のパネルに表示する

**JSON パラメータの検証**:

- `llm_params TEXT`（JSON 文字列）は、先に `JSON.parse` を自前の try/catch で呼び、その結果を `z.object({...}).strict().safeParse(parsed)` で検証する。`z.object` のキーは対応表から作り、`.strict()` で表に無いキーを拒否する。
- `z.string().transform(JSON.parse)` とは書かない。transform 内の throw は Zod に捕捉されず、`safeParse` でも `SyntaxError` が外に出る。
- zod v4 の `z.json()` は任意の JSON 値を検証するバリデータで、文字列をパースしないので使わない。

---

### カスタムシステムプロンプト

**編集**:

- 設定パネルの「編集」で開く modal の Text Input（段落形式、最大 2000 文字）に入力する。modal を開くときは、そのスコープの保存値を初期値に入れる。
- 「上書きを削除」でそのスコープのプロンプトを消し、上位のスコープのプロンプトを継承させる。
- パネルには保存値と実効値の先頭だけを表示し、全文は「編集」の modal で読む。1 つのパネルに複数のスコープのプロンプトの全文を並べると、メッセージの文字数の上限に近づくからである。

どのスコープにもプロンプトが設定されていなければ、カスタムプロンプトは送らない（現在と同じリクエストになる）。

**プロンプトの置き場所と順序**:

`ChatService` は現在、Bot 自身の指示をすべて `role: "system"` のメッセージとして組み立て、`OpenRouterClient` がそれを Responses の `input` に system 項目として並べる（`src/llm/openrouter.ts` の `toResponsesInput`）。
会話履歴ありのリクエストの `input` は、次の順に並ぶ（`src/services/chatService.ts` の `buildHistoryMessages`）。

1. 先頭の system メッセージ: Web 検索の固定指示（検索が有効なとき）、会話履歴を非信頼データとして扱う安全指示（`buildConversationSafetyMessage`、履歴があるとき）
2. 引用する会話履歴と返信先
3. 末尾の system メッセージ: ツイート展開の指示（展開したとき）、現在日時（`buildDateTimeSystemMessage`、常に）
4. 今回のユーザー発言

カスタムプロンプトは 1 の先頭に system メッセージとして置く。
Bot 自身の安全指示と日時指示はその後ろに来るので、カスタムプロンプトがそれらより後に読まれて打ち消す並びにはならない。
リクエストごとに変わらない内容を先頭に集める現在の並びも崩さない。

Responses の `instructions` フィールドに入れる方法は採らない。
OpenRouter が `instructions` と `input` 内の system 項目を、OpenAI 以外のプロバイダーでどう合成して渡すかは未検証であり、Bot の指示の置き場所が二つに分かれると、その順序を Bot 側で決められなくなる。

## Tasks

- [ ] フォルダ分割の要否を決める（Open Questions 参照）
- [ ] `channel_settings`, `user_settings` テーブル追加と `guild_settings` へのカラム追加
- [ ] 階層解決と Guild 制約の適用（`SettingsService`）
- [ ] `ChatService` と `messageCreate` で解決済みモデルを使う
- [ ] `/model set` の scope 対応と書き込み時の認可
- [ ] モデル既定パラメータの取得と保存（`ModelService`）
- [ ] パラメータ対応表と検証、リクエストへの適用
- [ ] 設定パネルの「プロンプトとパラメータ」ページ（スコープと対象チャンネルの選択、保存値と実効値と由来の表示、編集の modal、上書きの削除）
- [ ] 「自分の設定」のパネル（user スコープ、本人にだけ見える）
- [ ] 設定パネルの modal の仕組み（版の比較と保存を同じトランザクションで行うこと、下書き、「入力を修正する」）を、[設定パネル](../config-panel/design.md) の「modal の下書き」の仕様どおりに実装する
- [ ] modal の handler の単体テスト（書き込み時の認可、版の衝突、入力エラー、下書きの期限切れと本人以外の押下）
- [ ] 手動確認: PC とスマホで、プロンプトとパラメータを modal で編集し、入力エラーからの「入力を修正する」と版の衝突の表示を確かめる
- [ ] プロンプトの適用
- [ ] `/status` に channel 上書きを表示
- [ ] `docs/changes/settings-hierarchy/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- このフォルダは、設定階層化、LLM パラメータ、カスタムプロンプトの 3 機能を束ねている。LLM パラメータとカスタムプロンプトは、階層化なしでも Guild スコープだけで先に出荷できる。一方、両者の scope 指定と解決ロジックは階層化に依存するので、先に Guild だけで出すと、後から scope を足すときにコマンドと保存先をもう一度変えることになる。3 機能を同じリリースで出すならこのフォルダのままでよく、LLM パラメータやカスタムプロンプトを Guild スコープだけで先に出すなら、そのリリース単位でフォルダを分けることを勧める。
- スレッドでの解決: スレッドのメッセージの `channelId` はスレッドの ID である。スレッドに channel スコープの設定が無いとき、親チャンネルの設定を継承するかを決める必要がある。
- `default_parameters` を明示的に送ることと、送らずにプロバイダーの既定に任せることで結果が変わるかは未検証である。変わらないなら、モデル既定値のマージは設定パネルの表示のためだけに使い、送信からは外せる。
- [OAuth BYOK](../oauth-byok/design.md) で、ユーザーが自分のキーで支払うときにも `free_models_only` を適用するか。適用しないなら、Guild 制約を当てる条件に「解決したキーが Guild またはデフォルトのキーであること」を加える。

## 参照

- [OpenRouter OpenAPI 定義](https://openrouter.ai/openapi.json) — `ResponsesRequest`（`temperature`, `top_p`, `top_k`, `presence_penalty`, `frequency_penalty`, `max_output_tokens`, `top_logprobs`, `text`, `reasoning`, `instructions`。`logit_bias`, `seed`, `stop` は無い）と `DefaultParameters`
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models) — `default_parameters` と `supported_parameters`
- [Zod v4](https://zod.dev/v4)
