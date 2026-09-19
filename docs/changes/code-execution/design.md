---
title: "コード実行（OpenRouter shell server tool）"
status: investigating
priority: medium
summary: "OpenRouter の shell server tool による hosted サンドボックスでのコード実行と、その結果の Discord 表示"
---

# コード実行（OpenRouter shell server tool）

## Why

LLM はコードを書けるが実行できないため、計算結果の検証、データの可視化、ライブラリ挙動の確認といった「書いて動かして観察する」流れを Bot の中で完結できない。
ユーザは別環境にコピーして実行する手間を強いられ、対話の流れが切れる。

OpenRouter の `openrouter:shell` server tool を使い、モデルが必要と判断したときに hosted サンドボックスでコマンドを実行できるようにする。
実行環境は OpenRouter が管理する隔離コンテナなので、Bot のホストに仮想化基盤を持つ必要が無い。

自前の microVM サンドボックス（microsandbox）は採らない。
Bot は Proxmox LXC 上の Docker コンテナで動いており、microVM には `/dev/kvm` を LXC、Docker、Bot コンテナの 3 層に通す必要がある。
加えて、イメージの事前取得、同時実行の制限、クラッシュ時の孤児サンドボックスの回収、ディスク上限の強制を Bot 側で実装し保守することになる。
shell server tool はこれらをすべて OpenRouter 側に持つ。
引き換えに、実行したコードと出力が OpenRouter のサンドボックスを通ること、実行時間が課金されること、beta であることを受け入れる（後述）。

## 依存 / 関連 change

- 先行: [Responses API への移行](../responses-api-migration/design.md) — shell server tool は Responses API と Messages API でしか使えず、Chat Completions では 400 になる。`usage.cost_details.server_tool_cost` と `usage.server_tool_use_details` の parser と集計も同 change が用意する
- 先行: [tool-calling-foundation](../tool-calling-foundation/design.md) — `runToolLoop()` の `serverTools` 引数が server tool を毎ターンの `tools` へ載せる
- 連携: [OpenRouter サーバツール群](../server-tools/design.md) / [Web 検索 + ツイート展開](../web-search/design.md) — server tool の item を client が呼び出し側へ渡す経路（後述の `StreamServerToolChunk`）を共有する。最初に実装する change が経路を作り、後続はそれを使う
- 連携: [chat-response-v2](../chat-response-v2/design.md) — 実行の進捗と結果は V2 updater の tool block hook に描画する
- 連携: [出力マルチモーダル対応](../multimodal-output/design.md) — 生成ファイルと生成画像を `File` / `MediaGallery` で出す部品を共有する
- 連携: [使用統計](../usage-stats/design.md) — サンドボックス課金（`server_tool_cost`）を保存対象に含める
- 関連: [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — 同 change が `session_id` を送り始めると、`container_auto` のコンテナ ID が会話単位に変わる。本 change はコンテナ ID を明示するので影響を受けない（Decisions 参照）

## Goals / Non-Goals

**Goals:**

- コード実行を有効にした guild で、モデルが自律的に shell コマンドを実行し、結果を観察して回答できる
- 既定ではサンドボックスから外部へ通信できない。パッケージ取得に必要な最小限の通信は、guild 設定の別トグルで明示的に許可した場合だけ allowlist で開ける（二段階ゲート）
- 実行したコマンド、各コマンドの stdout / stderr / 終了状態、生成ファイル、生成画像を Discord Components V2 で表示する
- 実行中であることを、コマンドの完了を待たずに表示する
- 停止ボタンで実行中のリクエストを打ち切れる
- サンドボックス課金を footer に表示し、1 リクエストあたりの上限を持つ

**Non-Goals:**

- 自前のサンドボックス基盤（microsandbox、Piston、Judge0 など）
- 会話をまたいだファイルや状態の持続。コンテナは 1 ユーザ発言（1 回の `runToolLoop()`）の間だけ共有する
- `/run` のような、モデルを介さずコードを直接実行するコマンド。shell server tool にはモデルの tool call 以外の実行経路が無い
- 実行前のユーザ承認ボタン。承認者は実行前にコードの安全性を確実には判定できず、承認は封じ込めの代替にならない。境界は OpenRouter のサンドボックス隔離、既定のネットワーク遮断、guild 単位の二段階トグルが担う
- Anthropic Messages API 向けの `openrouter:bash`
- ユーザの添付ファイルをコンテナへ持ち込むこと（Files API と `file_ids`）

**将来別 change 候補:**

- 会話単位の持続コンテナ → `container_reference` の ID を会話の `session_id` から導けば実現できる。network policy がコンテナ起動時に固定される制約（後述）とファイル保持期間の扱いを決める必要があるため、別 change とする
- 添付ファイルのコンテナ持ち込み → Files API へのアップロードと `environment.file_ids`

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 実行基盤 | `openrouter:shell` server tool | ホストに KVM や常駐プロセスを要さず、隔離、リソース上限、タイムアウト、出力上限を OpenRouter が強制する。モデルを問わず使える |
| engine | `"openrouter"` に固定する | 既定の `"auto"` は OpenAI のモデルで OpenAI 自身の hosted shell を使い、出力 item が `shell_call` になる。engine を固定すれば、どのモデルでも item の形（`openrouter:shell`）、コンテナとファイルの API、課金が同じになる |
| tool の渡し方 | `runToolLoop()` の `serverTools` に載せる。`IClientTool` は作らない | 実行は OpenRouter 側で完結し、Bot が受け取るのは結果の item だけである。client tool として包むと、実行の往復が 1 ターン増え、引数検証や timeout の実装が二重になる |
| コンテナの単位 | `environment: { type: "container_reference", container_id: "req_<requestId>" }`。`requestId` は発言の Discord message ID | `runToolLoop()` は client tool を挟むと同じ発言の中で複数回リクエストする。`container_auto` は `session_id` が無いとリクエストごとに別コンテナになり、ターンをまたぐとファイルが消える。ID を明示すれば 1 発言の全ターンが同じコンテナを使い、発言が変われば新しいコンテナになる。ID は 1〜40 文字の英数字と `_` `-` という制約を満たす |
| `container_auto` を使わない理由 | 同上 | `container_auto` は `session_id` があると `sess_<session_id>` をコンテナ ID にする。[対話UX改善](../conversation-context/design.md) が `session_id` を送り始めた時点で、コンテナが暗黙に会話単位へ変わり、途中でネットワークのトグルを変えた guild のリクエストが 409 になる。コンテナの寿命を他 change のフィールドに左右させない |
| ネットワーク既定 | `network_policy` を送らない（= `disabled`） | 最小権限。実測でも既定のコンテナから `pypi.org` へは接続できなかった |
| ネットワーク許可時 | `{ type: "allowlist", allowed_domains: [...] }`。既定の一覧は `pypi.org` / `files.pythonhosted.org` / `registry.npmjs.org` | `pip install` と `npm install` に必要な最小集合。`["*"]` による無制限の egress は設定できないようにする。パッケージのインストールは任意コードの実行を伴うため、コード実行とは別のトグルで管理者が意識して許可する |
| policy とコンテナの整合 | 1 発言の間は最初のターンで決めた policy を使い続ける。コンテナ ID に policy の別（`req_<id>` / `req_<id>_net`）は含めない | policy はコンテナ起動時に固定され、稼働中のコンテナへ別の policy を送ると 409 になる。guild 設定は `runToolLoop()` の開始時に一度だけ読み、`serverTools` を凍結して全ターンへ同じものを送る（foundation の既存の契約）ので、1 発言の途中で policy が変わることは無い |
| 有効化ゲート | `guild_settings.code_execution_enabled`（既定 0）と `code_execution_network_enabled`（既定 0）。前者が 1 のときだけ shell tool を載せ、両方が 1 のときだけ allowlist を付ける | 課金と第三者サンドボックスの利用を伴うので opt-in にする |
| グローバルな無効化 | 環境変数 `CODE_EXECUTION_ENABLED`（既定 `false`）。`false` なら guild 設定に関係なく tool を載せない | beta の tool であり、挙動や課金が変わったときに設定変更だけで止められるようにする |
| 1 リクエストの上限 | `max_tool_calls` をリクエストに載せる（既定 8）。wall-clock は `runToolLoop()` の `STREAM_WALL_TIMEOUT_MS`（600 秒）がそのまま上限になる | server tool の反復は 1 リクエストの内側で起き、`MAX_TURNS` では数えられない。`max_tool_calls` の API 既定は 30 で、1 コマンド最大 300 秒なので、無指定だと 1 リクエストの課金上限が大きい。600 秒で打ち切られた場合の課金は約 $0.06 である |
| コマンドの timeout と出力上限 | モデルが指定する `timeout_ms` / `max_output_length` と、OpenRouter 側の上限（300 秒、65,536 文字）に任せる | Bot からは個々のコマンドに介入できない。Bot 側の上限は wall-clock と `max_tool_calls` で掛ける |
| 結果の受け取り | `response.output_item.added` / `done` のうち `item.type` が `openrouter:` で始まるものを、新しい正規化チャンク `StreamServerToolChunk` として yield する | 現行の client は server tool の item を heartbeat として捨てている。進捗表示と結果表示の両方に item が要る |
| 進捗表示 | `added`（`status: "in_progress"`）で `beginToolBlock("openrouter:shell")`、`done` で `endToolBlock(name, render)` を呼ぶ | 実行中は item が `in_progress` のまま数十秒〜数分続く。V2 updater の既存 hook をそのまま使える |
| idle timeout | 変更しない | 実測で、コマンド実行中は約 0.4 秒間隔で SSE コメント行が流れ、最大の空白は約 4 秒だった。client はコメント行を heartbeat として yield するので、100 秒のコマンドでも `STREAM_IDLE_TIMEOUT_MS`（90 秒）は発火しない |
| 生成ファイルの取得 | `done` の item の `files[]`（`container_file_citation`）を `GET /api/v1/containers/{container_id}/files/{file_id}/content` で取得する | item が返すのはファイルの参照だけで、中身は含まれない。1 コマンド結果あたり最大 10 件で、Discord の添付上限（10）と一致する |
| 表示する添付の上限 | 1 メッセージあたり添付 10 件、1 ファイル 9 MB。PNG / JPEG は `MediaGallery`、それ以外は `File`。上限を超えた分は件数だけを本文に示す | Discord API の上限。SVG は client の inline 描画が安定しないので `File` にする |
| stdout / stderr の表示 | コマンドごとにコードブロックで表示し、長いものは `File` 添付へ逃がす。分割は [chat-response-v2](../chat-response-v2/design.md) の splitter を使う | 1 メッセージの文字数とバイト数の予算は既存の splitter が管理している |
| mention の抑止 | 実行結果を含むメッセージはすべて `allowedMentions: { parse: [] }` で送る | サンドボックスの出力に `@everyone` やロール mention を書かせて ping を発火させる経路を塞ぐ。`TextDisplay` は embed の description と違い mention を発火する |
| キャンセル | 停止ボタンは既存どおり `AbortSignal` で HTTP リクエストを中断する | Bot から実行中のコマンドを直接止める API は無い。中断後にコンテナ側のコマンドが止まるか、課金がいつ止まるかは未検証（Open Questions） |
| 会話履歴への載せ方 | shell の item は履歴へ戻さず、assistant の本文だけを履歴に入れる | 現行の内部 DTO（`ChatMessage`）に server tool の item を表す型が無い。モデルは次の発言で前回の実行結果を本文からしか参照できないが、コンテナも発言ごとに新しくなるので整合する |
| 課金の表示 | `usage.cost_details.server_tool_cost` を footer に `Sandbox: $…` として出す | サンドボックス課金は推論コストと別建てで、実測では 126 秒の実行で推論コストの約 3 倍だった。ユーザと管理者が原因を区別できる必要がある |

## Design

### 実測で確認した事実

以下は 2026-09-19 と 2026-09-20 に、`google/gemini-3.8-flash` と `engine: "openrouter"` で実際にリクエストを送って確認した。

- OpenAI 以外のモデルでも shell が動く。ストリームには `response.output_item.added`（`{type:"openrouter:shell", status:"in_progress"}`）が流れ、完了時に `response.output_item.done` が届く
- `done` の item は次の形である

```json
{
  "id": "st_tmp_a1s4siv5k9l",
  "type": "openrouter:shell",
  "status": "completed",
  "action": {
    "commands": ["mkdir -p out && python3 -c \"print(sum(range(101)))\" | tee out/result.txt", "uname -a"],
    "max_output_length": null,
    "timeout_ms": null
  },
  "output": [
    { "stdout": "5050", "stderr": "", "outcome": { "type": "exit", "exit_code": 0 } },
    { "stdout": "Linux cloudchamber …", "stderr": "", "outcome": { "type": "exit", "exit_code": 0 } }
  ],
  "files": [
    {
      "type": "container_file_citation",
      "container_id": "gen_4b33020edfc9",
      "file_id": "cfile_b3V0L3Jlc3VsdC50eHQ",
      "filename": "out/result.txt",
      "start_index": 0,
      "end_index": 0
    }
  ],
  "container_id": "gen_4b33020edfc9",
  "call_id": "call_89022",
  "arguments": "{\"commands\":[…]}"
}
```

- 同じリクエストの中の 2 回の shell call は同じコンテナ（同じ `container_id`）で実行された
- 環境は Ubuntu 22.04、Python 3.11.14、Node v22.23.2、1 vCPU、メモリ約 1.2 GB、ディスク 3.7 GB（空き約 2.5 GB）。`numpy` / `matplotlib` / `pandas` は入っている。`pip` は PATH に無く `python3 -m pip`（25.3）で使える。`npm` / `npx` / `git` / `curl` / `wget` / `jq` がある。`gcc` と `uv` は無い
- 既定のコンテナから `https://pypi.org` へは接続できず、allowlist に `pypi.org` と `files.pythonhosted.org` を入れたコンテナからは 200 が返った
- コマンドの実行中は約 0.4 秒間隔で SSE コメント行（`:`）が流れる。`sleep 100` の間も途切れず、最大の空白は約 4 秒だった
- 課金は `usage.cost_details.server_tool_cost` に出る。数秒で終わる実行で $0.003（30 秒の最低課金）、`sleep 100` を含む 126 秒のリクエストで $0.0127 だった。同じリクエストの推論コストは $0.0040 である
- `usage.server_tool_use_details` に `tool_calls_requested` / `tool_calls_executed` が出る

実測で遭遇した注意点が一つある。
`pip install` を含む 7 コマンドを 1 call にまとめたリクエストが 16 分たっても完了しなかった（client 側で打ち切った。原因は未特定で、再現は試していない）。
`timeout_ms` を各 20 秒に指定した同種のリクエスト（`pip install` は含まない）は 34 秒で完了した。
Bot 側の wall-clock 上限（600 秒）が効くことが前提になる。

### アーキテクチャ

```text
messageCreate
  → chatService.generateChatResponse()
      guild 設定を読む → shell の ServerTool を組み立てる（無効なら載せない）
  → runToolLoop({ serverTools, requestFields: { max_tool_calls } })
      → OpenRouterClient.chatStream()            POST /api/v1/responses
          response.output_item.added (openrouter:shell, in_progress)
              → StreamServerToolChunk → updater.beginToolBlock("openrouter:shell")
          … SSE コメント行（heartbeat）…
          response.output_item.done  (openrouter:shell, completed)
              → StreamServerToolChunk → shellResultRenderer → updater.endToolBlock(name, render)
          response.output_text.delta → 既存の本文ストリーム
  → containerFileClient.download(container_id, file_id)   GET /api/v1/containers/…/content
  → V2 updater が実行結果の Container と添付を送る
```

### `StreamServerToolChunk`

`chatStream()` が yield する正規化チャンクに次を加える。

```ts
export interface StreamServerToolChunk {
  serverTool: {
    /** `response.output_item` の `output_index`。同じ実行の added と done を対応づける */
    index: number;
    /** `openrouter:shell` など、item の `type` そのまま */
    type: string;
    phase: "started" | "finished";
    /** `finished` のときだけ。wire の item を検証せずに運ぶので、読む側が形を検証する */
    item?: Record<string, unknown>;
  };
  done: false;
}
```

client は `item.type` が `openrouter:` で始まる `output_item.added` / `done` をこのチャンクへ写像し、それ以外の item（`message`、`reasoning` など）は現行どおり heartbeat にする。
`runToolLoop()` はこのチャンクを idle timer のリセットとして扱ったうえで、updater の `beginToolBlock` / `endToolBlock` へ渡す。
tool call の蓄積、`finishReason` の導出、byte 予算には関与させない。
server tool の実行は OpenRouter 側で完結し、loop が dispatch する対象ではないためである。

item の形の検証は client では行わず、tool ごとの renderer（本 change では `shellResultRenderer`）が行う。
server tool の種類ごとに item の形が違い、client に全種類の形を持たせると、新しい server tool を足すたびに client を触ることになるためである。
検証に失敗した item は結果を表示せず、「実行結果を表示できませんでした」とだけ出して本文のストリームは続ける。

### shell の ServerTool の組み立て

```ts
function buildShellTool(requestId: string, networkEnabled: boolean): ServerTool {
  return {
    type: "openrouter:shell",
    parameters: {
      engine: "openrouter",
      environment: {
        type: "container_reference",
        container_id: `req_${requestId}`,
        ...(networkEnabled && {
          network_policy: { type: "allowlist", allowed_domains: CODE_EXECUTION_ALLOWED_DOMAINS },
        }),
      },
    },
  };
}
```

`chatService` は guild 設定を読んだあと、`CODE_EXECUTION_ENABLED` と `code_execution_enabled` の両方が有効なときだけこの tool を `serverTools` に入れる。
`max_tool_calls` は `runToolLoop()` の `requestFields` で渡す。

tool calling に対応しないモデルへ `tools` を送るとエラーになる。
モデルの `supported_parameters` に `tools` が無い場合は shell tool を載せない。
この判定は [tool-calling-foundation](../tool-calling-foundation/design.md) の client tool と共通の問題なので、判定関数は同 change の registry 側に置く。

### 実行結果の表示

実行 1 回（shell call 1 回）を 1 つの Container にまとめる。

```text
┌ Container（accent: 成功 GREEN / 失敗あり RED / timeout あり ORANGE）
│ ### コード実行
│ $ <command 1>            （sh のコードブロック）
│ <stdout 1>               （コードブロック）
│ stderr があれば別のコードブロックで続ける
│ exit code が 0 以外、または timeout ならその旨を 1 行で示す
│ （command 2 以降も同じ）
│ MediaGallery（PNG / JPEG）
│ File（その他の生成ファイル、長すぎた stdout / stderr）
└
```

- 成否は `outcome` で判定する。`{type:"exit", exit_code:0}` だけが成功で、0 以外の exit code と `{type:"timeout"}` は失敗として色と文言を変える
- stdout / stderr がバッククォート 3 連を含む場合のフェンス長の調整は、既存の splitter に任せる
- 1 コマンドの出力が本文予算を超える場合は、先頭だけを本文に出し、全文を `File`（`stdout-<n>.txt`）として添付する。添付の予算は stdout / stderr の退避、画像、その他のファイルの順に使う
- ファイルの取得に失敗した場合は、ファイル名と「取得に失敗しました」を本文に出し、実行結果の表示は続ける
- 実行結果の Container は、モデルの本文（`response.output_text.delta`）とは別のメッセージとして、実行が終わった時点で送る

### 環境変数

| 変数 | 既定 | 用途 |
| ---- | ---- | ---- |
| `CODE_EXECUTION_ENABLED` | `false` | 機能全体の有効化。`false` なら guild 設定に関係なく tool を載せない |
| `CODE_EXECUTION_MAX_TOOL_CALLS` | `8` | リクエストに載せる `max_tool_calls` |
| `CODE_EXECUTION_ALLOWED_DOMAINS` | `pypi.org,files.pythonhosted.org,registry.npmjs.org` | ネットワーク許可時の allowlist。`*` だけの項目は起動時に拒否する |
| `CODE_EXECUTION_FILE_MAX_BYTES` | `9437184` | 取得して添付する 1 ファイルの上限 |

### DB スキーマ

`guild_settings` に 2 列を足す。

```sql
ALTER TABLE guild_settings ADD COLUMN code_execution_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN code_execution_network_enabled INTEGER NOT NULL DEFAULT 0;
```

切り替えは `/config code-execution enabled:<on|off>` と `/config code-execution-network enabled:<on|off>` で行う。
後者は前者が off のあいだ on にできない。

### 変更対象ファイル

- 修正: `src/types/index.ts` — `StreamServerToolChunk` を追加
- 修正: `src/llm/openrouter.ts` — `openrouter:` 接頭辞の item を `StreamServerToolChunk` へ写像
- 修正: `src/llm/toolLoop.ts` — `StreamServerToolChunk` を updater の tool block hook へ渡す
- 新規: `src/llm/serverTools/shell.ts` — `buildShellTool()` と `shellResultRenderer`（item の検証と `ToolRenderPayload` への変換）
- 新規: `src/llm/containerFileClient.ts` — コンテナのファイル取得（サイズ上限つきの bounded read）
- 修正: `src/services/chatService.ts` — guild 設定に応じて `serverTools` と `requestFields` を組み立てる
- 修正: V2 updater と `src/utils/chatContainerBuilder.ts` — 実行中表示と実行結果 Container の描画、footer の `Sandbox:` 表示
- 修正: `src/bot/commands/config.ts` と handler — 2 つのトグル
- 修正: `src/db/` — migration と repository
- 修正: `src/config/envVars.ts` — 上表の環境変数

### セキュリティとプライバシー

- 隔離は OpenRouter のサンドボックスに依存する。コンテナは account と workspace に scope され、他テナントと共有されない（OpenRouter の説明による）
- 実行するコマンド、その出力、生成ファイルは OpenRouter のサンドボックスに渡る。コンテナの home 配下のファイルは最終利用から 30 日間保持され、公開されている API に削除の手段は無い。guild の管理者が有効化する際に、この点を `/config` の確認文に明記する
- `container_id` は Discord の message ID から導くので推測可能だが、コンテナは Bot の API キーの workspace に scope されるため、他者からは参照できない。Bot の内部では、ある発言のコンテナを別の発言が参照する経路を作らない
- ネットワーク許可時も到達できるのは allowlist のホストの 80 / 443 番だけである（OpenRouter のプラットフォーム側の制約）
- コマンドとその出力はログへ全文を出さず、コマンド数、各 exit code、出力のバイト数、`container_id`、`server_tool_cost` だけを記録する

## Tasks

### Phase A: server tool item の受け渡し

- [ ] `StreamServerToolChunk` を追加し、client で `openrouter:` 接頭辞の item を写像する（それ以外の item が heartbeat のままであることをテストで固定）
- [ ] `runToolLoop()` が `StreamServerToolChunk` を updater の `beginToolBlock` / `endToolBlock` へ渡す。tool call の蓄積と `finishReason` に影響しないことをテストで固定
- [ ] 実 wire から採取した shell の item をフィクスチャにする

### Phase B: shell tool の有効化

- [ ] `guild_settings` の 2 列と `/config` の 2 トグル
- [ ] `buildShellTool()` と、`chatService` での `serverTools` / `max_tool_calls` の組み立て
- [ ] tool calling に対応しないモデルでは shell tool を載せない
- [ ] 環境変数と `CODE_EXECUTION_ALLOWED_DOMAINS` の検証

### Phase C: 結果の表示

- [ ] `shellResultRenderer`（item の検証、成否の判定、`ToolRenderPayload` への変換）
- [ ] `containerFileClient`（bounded read、サイズ上限、失敗時の扱い）
- [ ] V2 updater での実行中表示と実行結果 Container、添付予算の配分、`allowedMentions: { parse: [] }`
- [ ] footer の `Sandbox:` 表示
- [ ] `bun run preview` に実行中、成功、失敗、timeout、添付ありの fixture を追加

### Phase D: 検証とリリース

- [ ] 実 API で確認する: `container_reference` で 1 発言の複数リクエストが同じコンテナを使うこと、許可時に `python3 -m pip install` が通ること、client tool と shell を同じ発言で使えること
- [ ] 停止ボタンで中断したあとのコンテナ側の挙動と課金を確認する（Open Questions）
- [ ] Discord 上で確認する: 計算、`matplotlib` による画像生成、長い出力の添付化、失敗するコマンド、timeout
- [ ] README に、課金とデータの取り扱いを追記
- [ ] `docs/changes/code-execution/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **中断後の課金**: HTTP リクエストを中断したとき、実行中のコマンドが止まるか、課金の時計がいつ止まるかは確認できていない。ドキュメントは「レスポンスが完了したとき」に止まるとしか述べていない。中断しても最大 300 秒（1 コマンドの上限）は課金されうる前提で上限を見積もる
- **完了しないリクエスト**: `pip install` を含む複数コマンドの call が 16 分たっても完了しなかった事例が 1 回ある（原因未特定）。Bot 側は 600 秒の wall-clock で打ち切るが、その間の課金（約 $0.06）は発生する
- **`container_reference` の実測が無い**: 上の実測はすべて `container_auto` で行った。`container_reference` で 1 発言の複数リクエストがファイルを共有できることは、ドキュメントの記述に基づく設計であり、Phase D で確認する
- **beta**: server tool は beta で、API と挙動は変わりうる。item の形を renderer で検証し、想定外の形なら結果表示だけを諦めて本文は返す。`CODE_EXECUTION_ENABLED` で全体を止められるようにする
- **実行環境は選べない**: イメージ、言語のバージョン、CPU とメモリは OpenRouter が決める。`gcc` が無いので、コンパイルを要する Python パッケージはインストールできないことがある
- **in-region endpoint では使えない**: shell とコンテナは `openrouter.ai` でのみ動き、`eu.` / `us.` の endpoint では拒否される。現行の Bot は `openrouter.ai` を使っているので影響は無い
- **コンテナの sleep**: コンテナは 5 分の idle で sleep し、再開時に復元されるのは home 配下のファイルだけである。1 発言の途中で client tool が 5 分以上かかった場合、インストール済みのパッケージやプロセスは失われる
- **履歴に実行結果が残らない**: 次の発言でモデルが参照できるのは前回の本文だけである。「さっきのスクリプトを直して」のような依頼では、モデルは本文に書かれた範囲でしか前回を知らない。会話単位の持続コンテナ（将来別 change）と合わせて扱う

## 参照

- [OpenRouter Shell Server Tool](https://openrouter.ai/docs/guides/features/server-tools/shell) — engine、environment、network policy、上限、課金
- [OpenRouter Containers](https://openrouter.ai/docs/guides/features/containers) — コンテナ ID の決まり方、寿命、ファイルの保存と `files[]`
- [OpenRouter Server Tools](https://openrouter.ai/docs/guides/features/server-tools) — `max_tool_calls` と `stop_server_tools_when`
- OpenRouter の公開 OpenAPI 定義（`https://openrouter.ai/openapi.json`）— `GET /containers/{container_id}/files/{file_id}/content`、`ResponsesRequest.max_tool_calls`（既定かつ最大が 30）
