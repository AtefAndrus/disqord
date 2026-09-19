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
- 連携: [OpenRouter サーバツール群](../server-tools/design.md) / [Web 検索 + ツイート展開](../web-search/design.md) — server tool の item を client が呼び出し側へ渡す経路（後述の `StreamServerToolChunk`）と、1 発言あたりの server tool 実行回数の予算（後述）を共有する。最初に実装する change が作り、後続はそれを使う
- 連携: [chat-response-v2](../chat-response-v2/design.md) — 実行の進捗と結果は V2 updater の tool block hook に描画する
- 先行: [出力マルチモーダル対応](../multimodal-output/design.md) — 添付、component 数、合計バイト数の予算をまとめて配分する layout planner を使う。同 change より先に実装する場合は、同等の planner を本 change で実装し、同 change がそれを引き取る
- 連携: [権限管理](../permissions/design.md) — 2 つのトグルの変更は、同 change の設定変更の共通認可契約に従う
- 連携: [使用統計](../usage-stats/design.md) — サンドボックス課金（`server_tool_cost`）を保存対象に含める
- 関連: [対話UX改善（会話履歴ストア）](../conversation-context/design.md) — 同 change が `session_id` を送り始めると、`container_auto` のコンテナ ID が会話単位に変わる。本 change はコンテナ ID を明示するので影響を受けない（Decisions 参照）

## Goals / Non-Goals

**Goals:**

- コード実行を有効にした guild で、モデルが自律的に shell コマンドを実行し、結果を観察して回答できる
- 既定ではサンドボックスから外部へ通信できない。パッケージ取得に必要な最小限の通信は、guild 設定の別トグルで明示的に許可した場合だけ allowlist で開ける（二段階ゲート）
- 実行したコマンド、各コマンドの stdout / stderr / 終了状態、生成ファイル、生成画像を Discord Components V2 で表示する
- 実行中であることを、コマンドの完了を待たずに表示する
- 停止ボタンで実行中のリクエストを打ち切れる
- server tool の課金を footer に表示し、1 発言あたりの実行回数と待ち時間に上限を持つ

**Non-Goals:**

- 自前のサンドボックス基盤（microsandbox、Piston、Judge0 など）
- 会話をまたいだファイルや状態の持続。コンテナは 1 回の生成（1 回の `runToolLoop()`）の間だけ共有する
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
| コンテナの単位 | `environment: { type: "container_reference", container_id: "run_<messageId>_<乱数 8 桁の 16 進>" }`。ID は `runToolLoop()` の開始時に一度だけ採番し、その生成の全ターンで使う | `runToolLoop()` は client tool を挟むと同じ生成の中で複数回リクエストする。`container_auto` は `session_id` が無いとリクエストごとに別コンテナになり、ターンをまたぐとファイルが消える。message ID だけを ID にしない理由は、同じ発言に対する再生成（[conversation-regeneration](../conversation-regeneration/design.md)）やリトライが同じコンテナに当たり、前回の生成のファイルや実行中のコマンドを引き継いでしまうこと、その間に guild がネットワークのトグルを変えていると 409 になることである。ID は 1〜40 文字の英数字と `_` `-` という制約を満たす（`run_` + 最大 20 桁 + `_` + 8 桁 = 最大 33 文字） |
| `container_auto` を使わない理由 | 同上 | `container_auto` は `session_id` があると `sess_<session_id>` をコンテナ ID にする。[対話UX改善](../conversation-context/design.md) が `session_id` を送り始めた時点で、コンテナが暗黙に会話単位へ変わり、途中でネットワークのトグルを変えた guild のリクエストが 409 になる。コンテナの寿命を他 change のフィールドに左右させない |
| ネットワーク既定 | `network_policy` を送らない（= `disabled`） | 最小権限。実測でも既定のコンテナから `pypi.org` へは接続できなかった |
| ネットワーク許可時 | `{ type: "allowlist", allowed_domains: [...] }`。既定の一覧は `pypi.org` / `files.pythonhosted.org` / `registry.npmjs.org`。一覧に書けるのは完全一致のホスト名だけで、`*` を含む項目は起動時に拒否する | OpenRouter の allowlist は glob を受け付け、`*.*` のような項目は事実上すべての公開ホストを許す。`*` 単体だけを弾いても無制限の egress は防げないので、glob 自体を受け付けない。このトグルが許すのは「一覧のホストへの通信」であり、用途をパッケージ取得に限定する手段は無い。パッケージのインストールは任意コードの実行を伴うため、コード実行とは別のトグルで意識して許可する |
| policy とコンテナの整合 | 1 回の生成の間は最初のターンで決めた policy を使い続ける | policy はコンテナ起動時に固定され、稼働中のコンテナへ別の policy を送ると 409 になる。guild 設定は `runToolLoop()` の開始時に一度だけ読み、`serverTools` を凍結して全ターンへ同じものを送る（foundation の既存の契約）。コンテナ ID も生成ごとに新しいので、別の生成の policy と衝突しない |
| 有効化ゲート | `guild_settings.code_execution_enabled`（既定 0）と `code_execution_network_enabled`（既定 0）。前者が 1 のときだけ shell tool を載せ、両方が 1 のときだけ allowlist を付ける。どちらも新しい生成を始めるときの入口の制御であり、実行中の生成は止めない | 課金と第三者サンドボックスの利用を伴うので opt-in にする。`serverTools` は生成の開始時に凍結するので、トグルを off にしても進行中の生成の残りのターンには効かない。止めたい場合は停止ボタンを使う |
| トグルの認可 | 2 つのトグルの変更は [権限管理](../permissions/design.md) の共通認可契約（`admin_role_id`）に従う。同 change が未実装の間は、handler で `ManageGuild` 権限を要求する | 現行の `/config` の handler は guild 内であることしか確認しておらず、同じ作りで足すと一般メンバーが課金を伴う実行と外部通信を有効化できてしまう |
| グローバルな無効化 | 環境変数 `CODE_EXECUTION_ENABLED`（既定 `false`）。`false` なら guild 設定に関係なく tool を載せない。環境変数は起動時に読むので、切り替えには Bot の再起動が要る | beta の tool であり、挙動や課金が変わったときに、再ビルドや guild ごとの設定変更なしで止められるようにする |
| 1 発言あたりの実行回数 | `runToolLoop()` に server tool の実行回数の予算（既定 8）を持たせる。各ターンのリクエストに残り予算を `max_tool_calls` として載せ、ターンの usage の `server_tool_use_details.tool_calls_requested` を予算から引く。予算が尽きたターン以降は server tool を `tools` から外す。`stop_server_tools_when` は送らない | `max_tool_calls` は 1 HTTP リクエストの上限であり、`runToolLoop()` は 1 発言で最大 4 回、tool を載せたリクエストを送る。固定値をそのまま全ターンへ送ると 1 発言の上限はその 4 倍になる。`max_tool_calls` は shell だけでなく全 server tool の合計に効くので、予算は shell ではなく loop が持ち、[Web 検索](../web-search/design.md) など他の server tool と共有する。`stop_server_tools_when` は指定すると `max_tool_calls` が無視されるので使わない |
| 待ち時間の上限 | `runToolLoop()` の `STREAM_WALL_TIMEOUT_MS`（1 ターン 600 秒）に任せる。これは Bot が待つ時間の上限であり、課金の上限ではない | HTTP リクエストを中断したあと、コンテナ側で実行中や実行待ちのコマンドが止まるか、課金がいつ止まるかは未検証である（Open Questions）。1 call は最大 100 コマンドを順に実行でき、timeout はコマンドごとに掛かるので、中断後の実行時間を Bot 側からは制限できない。課金が中断時点で止まると仮定した場合、1 ターンの上限は 600 秒 × $0.0001 = 約 $0.06 になる |
| コマンドの timeout と出力上限 | モデルが指定する `timeout_ms` / `max_output_length` と、OpenRouter 側の上限（300 秒、65,536 文字）に任せる | Bot からは個々のコマンドに介入できない。Bot 側の上限は wall-clock と `max_tool_calls` で掛ける |
| 結果の受け取り | `response.output_item.added` / `done` のうち `item.type` が `openrouter:` で始まるものを、新しい正規化チャンク `StreamServerToolChunk` として yield する。item の外形（object であること、`type`、`output_index` の範囲、`added` と `done` の対応）は client と loop の境界で検証し、tool 固有の中身は renderer が検証する | 現行の client は server tool の item を heartbeat として捨てている。進捗表示と結果表示の両方に item が要る。中身の形は server tool ごとに違い、client に全種類の形を持たせると、server tool を足すたびに client を触ることになる |
| 進捗表示 | updater に `beginServerToolBlock(key, type)` と `endServerToolBlock(key, type, result)` を足し、`added` で前者、`done` で後者を呼ぶ。`key` は `<ターン番号>:<output_index>` | 既存の `beginToolBlock(name)` / `endToolBlock(name, render)` は tool 名しか受け取らず、同じ生成の中で shell が複数回呼ばれたときや、`output_index` が後のターンで再び現れたときに、開始と終了を対応づけられない。既存の hook は client tool 用にそのまま残す |
| idle timeout | 変更しない | 実測で、コマンド実行中は約 0.4 秒間隔で SSE コメント行が流れ、最大の空白は約 4 秒だった。client はコメント行を heartbeat として yield するので、100 秒のコマンドでも `STREAM_IDLE_TIMEOUT_MS`（90 秒）は発火しない |
| 生成ファイルの取得 | `done` の item の `files[]`（`container_file_citation`）を `GET /api/v1/containers/{container_id}/files/{file_id}/content` で取得する | item が返すのはファイルの参照だけで、中身は含まれない。1 コマンド結果あたり最大 10 件で、Discord の添付上限（10）と一致する |
| 表示の割り付け | 1 回の shell call は論理的な 1 つの結果であり、複数の Container や複数のメッセージにまたがってよい。添付（1 メッセージ 10 件、1 ファイル 9 MB）、component 数、合計バイト数の予算は、ファイルを取得する前に [出力マルチモーダル対応](../multimodal-output/design.md) の layout planner でまとめて配分する。PNG / JPEG は `MediaGallery`、それ以外は `File`。割り付けから漏れた分は件数だけを本文に示す | 添付 10 件と文字数の splitter だけでは、1 つの Container が有効になることを保証できない。`File` 10 個だけで component の枠を使い、見出しやコマンドや出力が入らなくなる。SVG は client の inline 描画が安定しないので `File` にする |
| コマンドと出力の表示 | コマンド、stdout、stderr をそれぞれコードブロックで表示し、長いものは `File` 添付へ逃がす。フェンスを壊さないための加工は renderer が行う: 表示用の文字列では、3 個以上連続するバッククォートの間にゼロ幅スペース（U+200B）を挟む。加工していない全文は `File` 添付で取得できる | 既存の splitter は 3 連バッククォートのフェンスをチャンク境界で閉じて開き直すだけで、任意の出力に含まれるバッククォートからフェンスを守る機能は無い |
| mention の抑止 | 実行結果を含むメッセージはすべて `allowedMentions: { parse: [] }` で送る | サンドボックスの出力に `@everyone` やロール mention を書かせて ping を発火させる経路を塞ぐ。`TextDisplay` は embed の description と違い mention を発火する |
| キャンセル | 停止ボタンは既存どおり `AbortSignal` で HTTP リクエストを中断する。同じ signal で、進行中のファイル取得も中断する | Bot から実行中のコマンドを直接止める API は無い。中断後にコンテナ側のコマンドが止まるか、課金がいつ止まるかは未検証（Open Questions） |
| 生成の途中の文脈 | 同じ生成の後続ターンへは、shell の item を `input` にそのまま再送する。`runToolLoop()` は、永続する会話履歴（`ChatMessage[]`）とは別に、その生成の間だけ保持する server tool item の列を持つ。再送する item の合計は 64 KB までとし、超える場合は古い item の stdout / stderr を切り詰める | shell の実行のあとにモデルが client tool を呼ぶと、loop は assistant の tool call と tool の結果だけを履歴に足して再リクエストする。shell のコマンド、出力、終了状態、ファイルの参照は次のリクエストに含まれず、コンテナにファイルは残っているのに、モデルは自分が何を実行したかを知らない状態になる。Containers のドキュメントは「再送された会話の中の直近の `container_id`」に言及しており、item の再送は想定された使い方だと読めるが、実測はしていない（Phase D で確認し、受け付けられない場合は、コマンドと出力の要約を system メッセージとして次のターンに渡す） |
| 会話履歴への載せ方 | 生成が終わったあとの会話履歴には、assistant の本文だけを入れる | 内部 DTO（`ChatMessage`）に server tool の item を表す型が無く、コンテナも生成ごとに新しくなる。次の発言でモデルが参照できるのは前回の本文だけである（Open Questions） |
| 課金の表示 | `usage.cost_details.server_tool_cost` を footer に `Server tools: $…` として出す。値が報告されなかった場合は 0 と表示せず、項目ごと出さない | この値は shell に限らず、計量課金される server tool 全体の合計である。shell 以外の server tool と併用したときに内訳は分からないので、shell の費用として表示しない。実測では 126 秒の実行で推論コストの約 3 倍だった |

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
      guild 設定を読む → コンテナ ID を採番 → shell の ServerTool を組み立てる（無効なら載せない）
  → runToolLoop({ serverTools, serverToolBudget })
      → OpenRouterClient.chatStream()            POST /api/v1/responses（max_tool_calls = 残り予算）
          response.output_item.added (openrouter:shell, in_progress)
              → StreamServerToolChunk(started)  → updater.beginServerToolBlock(key, type)
          … SSE コメント行（heartbeat）…
          response.output_item.done  (openrouter:shell, completed)
              → StreamServerToolChunk(finished) → shellResultRenderer → updater.endServerToolBlock(key, type, result)
          response.output_text.delta → 既存の本文ストリーム
      ターン終了: usage から予算を引き、server tool の item をその生成の文脈に足す
  → shellResultPublisher: layout planner で割り付け → containerFileClient で取得 → 結果メッセージを送る
  → messageCreate の finalization: 本文のメッセージだけを確定し、結果メッセージには触れない
```

### `StreamServerToolChunk`

`chatStream()` が yield する正規化チャンクに次を加える。

```ts
export type StreamServerToolChunk = {
  serverTool:
    | { phase: "started"; index: number; type: string }
    | { phase: "finished"; index: number; type: string; item: Record<string, unknown> };
  done: false;
};
```

`index` は `response.output_item` の `output_index`、`type` は item の `type`（`openrouter:shell` など）そのままである。
`finished` は必ず item を持つ。

client は `item.type` が `openrouter:` で始まる `output_item.added` / `done` をこのチャンクへ写像し、それ以外の item（`message`、`reasoning` など）は現行どおり heartbeat にする。
client は item の外形だけを検証する: item が object であること、`type` が文字列であること、`output_index` が function call と同じ範囲の非負整数であること、`done` が同じ `output_index` の `added` に対応し、同じ `type` を持つこと、同じ `output_index` に `done` が二度届かないこと。
違反は function call と同じく protocol error にする。
中身（shell なら `action` / `output` / `files` / `container_id`）は server tool ごとに形が違うので、tool ごとの renderer が検証する。
renderer の検証に失敗した item は結果を表示せず、「実行結果を表示できませんでした」とだけ出して本文のストリームは続ける。

`runToolLoop()` はこのチャンクを idle timer のリセットとして扱い、`<ターン番号>:<index>` を key にして updater の `beginServerToolBlock` / `endServerToolBlock` へ渡す。
`output_index` はリクエストごとに 0 から振り直されるので、key にターン番号を含める。
tool call の蓄積、`finishReason` の導出、byte 予算には関与させない。
server tool の実行は OpenRouter 側で完結し、loop が dispatch する対象ではないためである。

`started` のまま `finished` が届かずにターンが終わった block（キャンセル、timeout、エラー、`response.incomplete`）は、loop がターンの終了時に `endServerToolBlock(key, type, { kind: "aborted" })` を呼んで閉じる。
updater は「実行中」の表示を「中断されました」に変える。

### 大きな item と SSE のフレーム上限

client は 1 行の SSE フレームを `MAX_SSE_FRAME_BYTES`（1 MiB）で打ち切っている。
shell の `done` の item は全コマンドの stdout と stderr を 1 フレームに載せるので、この上限を超えうる。
出力上限の既定値（1 ストリーム 16,384 文字）でも、32 コマンド分の stdout と stderr が埋まれば 1 MiB に達し、モデルが上限の 65,536 文字を指定すれば 9 コマンドで達する。

上限は 4 MiB に引き上げる。
有限の上限は残す。
上限が無いと、壊れたストリームや悪意のあるストリームでメモリを使い切るためである。
4 MiB を超えるフレームは現行どおり protocol error になり、そのターンはエラーで終わる。
この場合、renderer による「結果表示だけを諦めて本文は続ける」扱いにはできない。
フレームを捨てて読み進めるには行の終端まで読み飛ばす必要があり、その間に届くはずの `response.output_item.done` を失ったまま function call の整合を判定することになるためである。
4 MiB を超える item のフィクスチャをテストに加え、protocol error になることを固定する。

### 生成の途中の文脈

`runToolLoop()` は、永続する会話履歴（`ChatMessage[]`）とは別に、その生成の間だけ保持する server tool item の列を持つ。
ターンが `tool_calls` で終わって次のリクエストを組むとき、そのターンまでに `finished` になった item を、assistant の function call より前の位置で `input` に再送する。
再送する item の合計が 64 KB を超える場合は、古い item から順に `output[].stdout` / `stderr` を先頭と末尾だけ残して切り詰める。

内部 DTO には、`OpenRouterClient` が `input` へそのまま写す型を 1 つ足す。

```ts
/** 生成の間だけ使う。会話履歴へは保存しない */
export interface ServerToolItemMessage {
  role: "server_tool_item";
  item: Record<string, unknown>;
}
```

生成が終わって会話履歴へ返すときは、この型のメッセージを取り除く。

### shell の ServerTool の組み立て

```ts
function buildShellTool(containerId: string, networkEnabled: boolean): ServerTool {
  return {
    type: "openrouter:shell",
    parameters: {
      engine: "openrouter",
      environment: {
        type: "container_reference",
        container_id: containerId,
        ...(networkEnabled && {
          network_policy: { type: "allowlist", allowed_domains: CODE_EXECUTION_ALLOWED_DOMAINS },
        }),
      },
    },
  };
}
```

`chatService` は guild 設定を読んだあと、`CODE_EXECUTION_ENABLED` と `code_execution_enabled` の両方が有効なときだけこの tool を `serverTools` に入れる。
コンテナ ID は `run_${requestId}_${randomBytes(4).toString("hex")}` として、`runToolLoop()` を呼ぶ直前に一度だけ採番する。
`max_tool_calls` は `requestFields` ではなく、loop が残り予算から毎ターン計算して載せる。
`requestFields` は全ターンに同じ値を送る仕組みなので、ターンごとに減る値には使えない。

tool calling に対応しないモデルへ `tools` を送るとエラーになる。
モデルの `supported_parameters` に `tools` が無い場合は shell tool を載せない。
この判定は [tool-calling-foundation](../tool-calling-foundation/design.md) の client tool と共通の問題なので、判定関数は同 change の registry 側に置く。

### 実行結果の表示

1 回の shell call は論理的な 1 つの結果で、次の要素からなる。

```text
見出し（### コード実行）と成否（成功 GREEN / 失敗あり RED / timeout あり ORANGE）
コマンドごとに: コマンド、stdout、stderr（あれば）、exit code が 0 以外または timeout ならその旨
MediaGallery（PNG / JPEG）
File（その他の生成ファイル、本文に収まらなかった stdout / stderr の全文）
```

- 成否は `outcome` で判定する。`{type:"exit", exit_code:0}` だけが成功で、0 以外の exit code と `{type:"timeout"}` は失敗として色と文言を変える
- コマンド、stdout、stderr はコードブロックで表示する。表示用の文字列では、3 個以上連続するバッククォートの間にゼロ幅スペース（U+200B）を挟み、出力の中身でフェンスが閉じないようにする。加工していない全文は `File` 添付に入れる
- 割り付けは layout planner が行う。planner は、表示したい要素の一覧（テキストの長さ、画像とファイルの件数とサイズ）を受け取り、1 メッセージの文字数、バイト数、component 数、添付 10 件の上限を満たす Container とメッセージの列を返す。1 つの結果が複数のメッセージに分かれてよい
- ファイルの取得は割り付けのあとに行い、割り付けられたファイルだけを取得する。添付の枠は、stdout / stderr の全文、画像、その他のファイルの順に使う
- ファイルの取得に失敗した場合は、ファイル名と「取得に失敗しました」を本文に出し、結果の表示は続ける

### 結果メッセージの所有と finalization

実行結果は、モデルの本文とは別のメッセージとして、`done` が届いた時点で送る。

現行の `messageCreate` の finalization は、`updater.messages` を本文のページとして書き直し、余ったメッセージを削除する。
結果メッセージをこの列に入れると、finalization で上書きされるか削除される。
そこで updater は結果メッセージを別の列（`resultMessages`）で持ち、finalization は本文の列だけを扱う。

結果の公開（割り付け、ファイルの取得、送信）は `shellResultPublisher` が所有し、次を守る。

- ファイルの取得には、リクエストの `AbortSignal` と、1 ファイルあたりの期限（`CODE_EXECUTION_FILE_DEADLINE_MS`）を組み合わせた signal を渡す。サイズ上限つきの読み取りだけでは、応答が途中で止まった取得が終わらない
- finalization は、成功、キャンセル、エラーのどの経路でも、進行中の公開をまず中断してから本文を確定する。中断された公開は、送信済みの結果メッセージを残し、未送信の分は送らない
- finalization のあとに完了した取得や送信が結果を公開しないよう、publisher は finalization 済みのフラグを送信の直前に確認する
- 停止ボタンで中断された生成では、`started` のままの block を「中断されました」で閉じる

### 環境変数

| 変数 | 既定 | 用途 |
| ---- | ---- | ---- |
| `CODE_EXECUTION_ENABLED` | `false` | 機能全体の有効化。`false` なら guild 設定に関係なく tool を載せない |
| `SERVER_TOOL_CALL_BUDGET` | `8` | 1 発言あたりの server tool 実行回数の予算（全 server tool の合計） |
| `CODE_EXECUTION_ALLOWED_DOMAINS` | `pypi.org,files.pythonhosted.org,registry.npmjs.org` | ネットワーク許可時の allowlist。完全一致のホスト名だけを受け付け、`*` を含む項目や、scheme、path、port を含む項目は起動時に拒否する |
| `CODE_EXECUTION_FILE_MAX_BYTES` | `9437184` | 取得して添付する 1 ファイルの上限 |
| `CODE_EXECUTION_FILE_DEADLINE_MS` | `15000` | 1 ファイルの取得に掛ける時間の上限 |

### DB スキーマ

`guild_settings` に 2 列を足す。

```sql
ALTER TABLE guild_settings ADD COLUMN code_execution_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN code_execution_network_enabled INTEGER NOT NULL DEFAULT 0;
```

切り替えは `/config code-execution enabled:<on|off>` と `/config code-execution-network enabled:<on|off>` で行う。
どちらも Decisions「トグルの認可」の権限を要求し、権限の無い実行は設定を変えずに拒否する。

2 つの列は独立に保存する。
コード実行を off にしてもネットワークの設定値は消さず、再び on にしたときに元の値が効く。
`/config` の表示では、保存されている値と、実際に効いている値（`CODE_EXECUTION_ENABLED` と 2 つの列を合わせた結果）の両方を示す。
ネットワークのトグルの説明文は「一覧のホストへの通信を許可する」とし、パッケージのインストール専用であるかのような表現にしない。

### 変更対象ファイル

- 修正: `src/types/index.ts` — `StreamServerToolChunk` を追加
- 修正: `src/llm/openrouter.ts` — `openrouter:` 接頭辞の item を `StreamServerToolChunk` へ写像し、外形を検証する。`server_tool_item` を `input` へ写す。`MAX_SSE_FRAME_BYTES` を 4 MiB にする
- 修正: `src/llm/toolLoop.ts` — `StreamServerToolChunk` を updater の server tool block hook へ渡す。server tool の実行回数の予算、生成の途中の文脈、閉じられなかった block の後始末
- 新規: `src/llm/serverTools/shell.ts` — `buildShellTool()` と `shellResultRenderer`（item の中身の検証と、表示用の要素への変換）
- 新規: `src/bot/shellResultPublisher.ts` — 割り付け、ファイルの取得、結果メッセージの送信、中断
- 新規: `src/llm/containerFileClient.ts` — コンテナのファイル取得（サイズ上限つきの bounded read）
- 修正: `src/services/chatService.ts` — guild 設定に応じて `serverTools` と `requestFields` を組み立てる
- 修正: V2 updater と `src/utils/chatContainerBuilder.ts` — `beginServerToolBlock` / `endServerToolBlock`、結果メッセージの列、footer の `Server tools:` 表示
- 修正: `src/bot/events/messageCreate.ts` — finalization で進行中の公開を中断し、結果メッセージを本文の確定から除外する
- 修正: `src/bot/commands/config.ts` と handler — 2 つのトグルと、その認可
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

- [ ] `StreamServerToolChunk` を追加し、client で `openrouter:` 接頭辞の item を写像する。外形の違反（`added` の無い `done`、`type` の食い違い、二重の `done`）が protocol error になること、それ以外の item が heartbeat のままであることをテストで固定
- [ ] `MAX_SSE_FRAME_BYTES` を 4 MiB にし、上限を超える shell item が protocol error になることをフィクスチャで固定
- [ ] updater に `beginServerToolBlock` / `endServerToolBlock` を足し、`runToolLoop()` から `<ターン番号>:<index>` を key にして呼ぶ。閉じられなかった block を `aborted` で閉じる
- [ ] `runToolLoop()` に server tool の実行回数の予算を実装する（残り予算を `max_tool_calls` に載せる、usage から引く、尽きたら server tool を外す）
- [ ] 生成の途中の文脈（`server_tool_item` の再送と 64 KB の切り詰め）を実装し、shell → client tool → 継続の列で、2 回目のリクエストに shell の item が含まれることをテストで固定。会話履歴へ返す前に取り除くこともテストで固定
- [ ] 実 wire から採取した shell の item をフィクスチャにする

### Phase B: shell tool の有効化

- [ ] `guild_settings` の 2 列と `/config` の 2 トグル。権限の無い実行が拒否されること、off にしてもネットワークの設定値が残ること、保存値と実効値の両方が表示されることをテストで固定
- [ ] `buildShellTool()` と、`chatService` でのコンテナ ID の採番と `serverTools` の組み立て
- [ ] tool calling に対応しないモデルでは shell tool を載せない
- [ ] 環境変数と `CODE_EXECUTION_ALLOWED_DOMAINS` の検証（`*`、scheme、path、port を含む項目を拒否）

### Phase C: 結果の表示

- [ ] `shellResultRenderer`（item の中身の検証、成否の判定、表示用の要素への変換、バッククォートの加工）
- [ ] layout planner による割り付け（[出力マルチモーダル対応](../multimodal-output/design.md) が未実装なら本 change で実装する）
- [ ] `containerFileClient`（サイズ上限、期限、`AbortSignal`）
- [ ] `shellResultPublisher` と `messageCreate` の finalization の統合。成功、キャンセル、エラーの各経路で、結果メッセージが上書きも削除もされないこと、finalization のあとに結果が公開されないことをテストで固定
- [ ] `allowedMentions: { parse: [] }`（返信では既存どおり `repliedUser: false`）
- [ ] footer の `Server tools:` 表示
- [ ] `bun run preview` に実行中、成功、失敗、timeout、中断、添付ありの fixture を追加

### Phase D: 検証とリリース

- [ ] 実 API で確認する: `container_reference` で 1 回の生成の複数リクエストが同じコンテナを使うこと、shell の item を `input` に再送できること、許可時に `python3 -m pip install` が通ること、`max_tool_calls` が全 server tool の合計に効くこと
- [ ] 停止ボタンで中断したあとのコンテナ側の挙動と課金を確認する（Open Questions）
- [ ] Discord 上で確認する: 計算、`matplotlib` による画像生成、長い出力の添付化、失敗するコマンド、timeout、実行中の停止
- [ ] README に、課金とデータの取り扱いを追記
- [ ] `docs/changes/code-execution/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **中断後の課金に上限を置けない**: HTTP リクエストを中断したとき、実行中や実行待ちのコマンドが止まるか、課金の時計がいつ止まるかは確認できていない。ドキュメントは「レスポンスが完了したとき」に止まるとしか述べていない。1 call は最大 100 コマンドを順に実行でき、timeout はコマンドごとなので、止まらない場合の実行時間は Bot 側から制限できない。課金の確かな上限は、OpenRouter 側で止まることを Phase D で確認できた場合にだけ言える。確認できなければ、OpenRouter の API キーに設定するクレジット上限を唯一の確かな上限として README に書く
- **完了しないリクエスト**: `pip install` を含む複数コマンドの call が 16 分たっても完了しなかった事例が 1 回ある（原因未特定）。Bot 側は 600 秒の wall-clock で待つのをやめるが、その間の課金は発生し、中断後の課金は上の項目のとおり不明である
- **実測していない前提が 2 つある**: 実測はすべて `container_auto` で行った。`container_reference` で 1 回の生成の複数リクエストがファイルを共有できることと、shell の item を `input` に再送できることは、ドキュメントの記述に基づく設計であり、Phase D で確認する。後者が受け付けられない場合の代替は Decisions「生成の途中の文脈」に書いた
- **beta**: server tool は beta で、API と挙動は変わりうる。item の中身を renderer で検証し、想定外の形なら結果表示だけを諦めて本文は返す。外形が崩れた場合と 4 MiB を超えた場合はターンがエラーになる。`CODE_EXECUTION_ENABLED` と再起動で全体を止められる
- **実行環境は選べない**: イメージ、言語のバージョン、CPU とメモリは OpenRouter が決める。`gcc` が無いので、コンパイルを要する Python パッケージはインストールできないことがある
- **in-region endpoint では使えない**: shell とコンテナは `openrouter.ai` でのみ動き、`eu.` / `us.` の endpoint では拒否される。現行の Bot は `openrouter.ai` を使っているので影響は無い
- **コンテナの sleep**: コンテナは 5 分の idle で sleep し、再開時に復元されるのは home 配下のファイルだけである。1 発言の途中で client tool が 5 分以上かかった場合、インストール済みのパッケージやプロセスは失われる
- **履歴に実行結果が残らない**: 次の発言でモデルが参照できるのは前回の本文だけである。「さっきのスクリプトを直して」のような依頼では、モデルは本文に書かれた範囲でしか前回を知らない。会話単位の持続コンテナ（将来別 change）と合わせて扱う

## 参照

- [OpenRouter Shell Server Tool](https://openrouter.ai/docs/guides/features/server-tools/shell) — engine、environment、network policy、上限、課金
- [OpenRouter Containers](https://openrouter.ai/docs/guides/features/containers) — コンテナ ID の決まり方、寿命、ファイルの保存と `files[]`
- [OpenRouter Server Tools](https://openrouter.ai/docs/guides/features/server-tools) — `max_tool_calls` と `stop_server_tools_when`
- OpenRouter の公開 OpenAPI 定義（`https://openrouter.ai/openapi.json`）— `GET /containers/{container_id}/files/{file_id}/content`、`ResponsesRequest.max_tool_calls`（既定かつ最大が 30）
