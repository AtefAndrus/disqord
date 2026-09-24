---
title: "権限管理"
status: planned
priority: high
summary: "チャンネル制限と、ギルド設定を変更できるメンバーの共通認可（admin_role_id）"
---

# 権限管理

## Why

Bot が全チャンネル・全ユーザに無制限でアクセス可能な状態は、大規模サーバーでの運用に適さない。
チャンネル単位の制限が必要である。

加えて、ギルド設定を誰が変更できるかが設定ごとにばらばらである。
`/config web-search`・`reasoning-display`・`twitter-expand`・`history` の 4 つは、handler がそれぞれ `ManageGuild` を直接確認している（`src/bot/commands/handlers.ts:247,273,300,328`）。
`/status` の切り替えボタンは同じ 4 設定についてだけ、別の箇所で同じ確認をしている（`src/bot/events/interactionCreate.ts:258`）。
一方で `/config free-only`・`llm-details`・`auto-reply add|remove` と、`/status` の `free_only`・`llm_details` ボタンは誰でも実行できる。
無料モデル限定を切ると有料モデルを選べるようになり、自動応答チャンネルを足すとそのチャンネルの全発言に Bot が応答する。
どちらも Bot の運営者の OpenRouter クレジットを消費する操作だが、現状は一般メンバーが実行できる。

本 change は、ギルド設定を変更できるかの判定を共通関数 1 つにまとめ、すべての入口がそれを呼ぶようにする。
スケジュール実行、使用統計、コード実行、画像生成、Discord 操作ツール、リリース通知、設定階層化、OAuth BYOK の design がこの共通関数を前提にしているため、それらより先に実装する。

## 依存 / 関連 change

- 後続: [スケジュール実行（cron）](../cron/design.md) / [使用統計](../usage-stats/design.md) / [コード実行](../code-execution/design.md) / [画像生成](../image-generation/design.md) / [Discord 操作ツール](../discord-tool/design.md) / [リリース通知](../release-announcement/design.md) / [OAuth BYOK](../oauth-byok/design.md) — 本 change の共通認可関数を使う
- 関連: [Discord 操作ツール](../discord-tool/design.md) — `/config discord-tools` の切り替えは本 change の共通認可関数で判定する。一方、ツール実行時に「依頼者本人がそのチャンネルでその操作をできるか」を確かめる認可は同 change が持ち、本 change の `admin_role_id` には置き換えない
- 関連: [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) — 設定の書き込みに本 change の認可を使う

## Goals / Non-Goals

**Goals:**

- Bot の応答を特定チャンネルに制限可能にする
- ギルド設定を変更できるかの判定を共通関数 1 つで表現し、スラッシュコマンドと `/status` のボタンの両方の入口から呼ぶ
- `/config` のすべての書き込み（無料モデル限定と自動応答チャンネルを含む）を認可の対象にする
- `admin_role_id` 未設定時の既定動作を確定する

**Non-Goals:**

- 使用統計（[使用統計](../usage-stats/design.md)）
- ユーザーごとの使用量制限（レートリミット）
- ロール単位の機能設定（[設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) の scope とは別軸）
- `/model set` の認可（理由と残る懸念は Decisions と Open Questions に書く）
- メッセージ単位の操作（再生成やツールによる Discord 操作など）の認可。対象メッセージの発言者や依頼者の権限で判定するもので、各 change が持つ
- スラッシュコマンドのチャンネル制限（設定は制限外のチャンネルからも変えられる必要がある）

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| チャンネル制限の既定 | 全チャンネル許可 | 既存動作を維持し、制限は明示的に設定したときだけ効かせる |
| 認可の対象 | `/config` のすべての書き込みと、それに対応する `/status` のボタン | 課金への影響でサブコマンドを選り分けると、サブコマンドを足すたびに分類が要り、分類漏れが無料モデル限定のような無防備な設定を生む。規則を「ギルド設定を変えるには認可が要る」の一文にすれば漏れようがない |
| `llm-details` を対象に含めるか | 含める | 課金には影響しないが、全メンバーの表示を変えるギルド全体の設定である。この 1 件だけ例外にすると上の一文の規則が崩れる |
| `/model set` | 認可の対象にしない | 有料モデルを選べるかは無料モデル限定が決め、その切り替えを本 change で保護する。管理者は無料モデル限定を保つことで一般メンバーのモデル選択を無料モデルに限定できる |
| 認可される条件 | `ManageGuild` を持つメンバー、または `admin_role_id` のロールを持つメンバー | `admin_role_id` は権限を委譲する追加の経路にとどめる。ロールだけに絞ると、ロールの削除や設定ミスでサーバー管理者が設定を変えられなくなる。`ManageGuild` の持ち主はサーバー設定そのものを変えられるので、Bot の設定だけ拒んでも守れるものがない |
| `admin_role_id` 自体の変更 | `ManageGuild` のみ | 委譲されたロールの持ち主が委譲先を付け替えられないようにする |
| 認可の表現 | 共通関数 1 つに集約し、各入口はそれを呼ぶ | 同じ確認を入口ごとに書くと、入口を足したときに確認を書き漏らす（`/status` の `free_only` ボタンが現にそうなっている） |
| 自動応答チャンネルと許可チャンネルの関係 | 許可チャンネルが優先する。許可外のチャンネルは自動応答に登録されていても応答しない | 許可チャンネルは Bot を閉じ込めるための設定であり、自動応答がそれを越えられると、制限に別の設定からしか見えない抜け道ができる |
| `setDefaultMemberPermissions` | 使わない | `/config` コマンド全体に作用し、`/config auto-reply list` のような読み取りまで一般メンバーから隠れる。サブコマンドごとの既定権限は設定できない（Discord の仕様としては未検証）ため、handler 内で判定する |

## Design

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `guild_settings` に 2 列を追加
- 修正: `src/db/repositories/guildSettings.ts` / `src/types/index.ts`（`GuildSettings`）— フィールド追加
- 修正: `src/services/settingsService.ts` — setter 追加
- 新規: `src/services/settingsAuthorization.ts` — 共通認可関数。メッセージを読めるかを判定する `src/services/messageAuthorization.ts` とは判定の軸が違うので別ファイルにする
- 修正: `src/bot/commands/config.ts` / `src/bot/commands/handlers.ts` — 許可チャンネルと管理ロールのサブコマンド追加。`/config` の書き込み系 handler すべてで共通関数を呼び、`ManageGuild` の直接確認を削る
- 修正: `src/bot/events/interactionCreate.ts` — `status_set:<key>` のボタン 6 種と、旧形式の `status_toggle_free_only` / `status_toggle_llm_details` ボタンで共通関数を呼ぶ。`ManageGuild` の直接確認と、4 設定だけを対象にした拒否文言の分岐を削る
- 修正: `src/utils/statusMessage.ts` — `/status` の設定一覧に許可チャンネルと管理ロールを表示する
- 修正: `src/bot/events/messageCreate.ts` — 許可チャンネルの確認を応答判定に追加

### DB スキーマ変更

```sql
ALTER TABLE guild_settings ADD COLUMN allowed_channels TEXT;  -- JSON array
ALTER TABLE guild_settings ADD COLUMN admin_role_id TEXT;
```

### 共通認可関数

```ts
function canManageGuildSettings(
  member: { permissions: Readonly<PermissionsBitField> | null; roleIds: readonly string[] },
  settings: Pick<GuildSettings, "adminRoleId">,
): boolean;
```

- `ManageGuild` を持つか、`adminRoleId` が非 NULL でそのロールを持てば true を返す。`permissions` が取れない場合は false とする。
- 引数を discord.js のインタラクションやメッセージではなく権限とロール ID の組にするのは、スラッシュコマンド、ボタン、メッセージ（`message.member`）のどこからでも同じ関数を呼べるようにするためである。
- 拒否したときの文言も 1 つにまとめ、`admin_role_id` の有無に応じて必要な権限またはロールを示す。
- 呼び出し元は次の 3 種類である。
  - `/config` の書き込み系サブコマンド（`interaction.memberPermissions` と、`interaction.member` のロール ID）
  - `/status` の設定ボタン（同上）
  - `messageCreate` から LLM の tool に渡すコンテキスト。会話中に tool がギルドの課金に関わる操作を提案する場合（[スケジュール実行（cron）](../cron/design.md) の登録提案）に、依頼者がこの判定を満たすかを真偽値として渡す。tool の `isEnabled(ctx)` は同期関数で、メンバー情報を持たないため

### チャンネル制限

- `allowed_channels`: NULL = 全チャンネル許可、配列 = 指定チャンネルのみ。
- 判定は `messageCreate` の応答判定で、メンションと自動応答の両方に先立って行う。許可外のチャンネルでは何も返さない。
- スレッドは親チャンネルで判定する（自動応答チャンネルの判定と同じ扱い）。
- コマンドは `/config allowed-channels add|remove|list` とする。最後の 1 つを外すと NULL（全チャンネル許可）に戻り、その旨を返信で伝える。
- `/config auto-reply add` で許可外のチャンネルを登録したときは、登録したうえで「許可チャンネル外のため応答しない」と返信に書く。

### 管理ロール

- `admin_role_id`: ギルド設定の変更を委譲するロール。NULL なら `ManageGuild` の持ち主だけが変更できる。
- コマンドは `/config admin-role set <role>` と `/config admin-role clear` とし、実行には `ManageGuild` を求める。
- ロールが削除されると誰もそのロールを持たなくなるだけで、`ManageGuild` の持ち主は引き続き変更できる。

**参照**:

- [discord.js PermissionsBitField](https://discord.js.org/docs/packages/discord.js/14.27.0/PermissionsBitField:Class) - `has()` で権限を確認する
- [discord.js GuildMember](https://discord.js.org/docs/packages/discord.js/14.27.0/GuildMember:Class) - `roles.cache.has(roleId)` でロール所属を確認する

## Tasks

- [ ] `guild_settings` に `allowed_channels` / `admin_role_id` 列を追加（schema / types / repository / upsert）
- [ ] `settingsService` に setter 追加
- [ ] `settingsAuthorization.ts` に共通認可関数と拒否文言を実装
- [ ] `/config` の書き込み系 handler すべてを共通関数に切り替える（`free-only`・`llm-details`・`auto-reply add|remove` を新たに対象へ含める）
- [ ] `/status` のボタン（`status_set:<key>` と旧形式の `status_toggle_*`）を共通関数に切り替える
- [ ] `/config allowed-channels` と `/config admin-role` を追加し、`/status` に表示する
- [ ] `messageCreate` に許可チャンネルの判定を追加（自動応答より優先）
- [ ] テスト追加（許可チャンネルと自動応答の優先関係、スレッドの親チャンネル判定、`admin_role_id` の設定時と未設定時、ロールを持たない `ManageGuild` 保持者、ボタン入口での拒否）
- [ ] `docs/changes/permissions/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **無料モデル限定を切った後の `/model set`**: 無料モデル限定を切ると、一般メンバーも `/model set` で高価なモデルを選べる。管理者が有料モデルを使いたいが選択は自分で行いたい、という運用には本 change では応えられない。需要が出たら `/model set` を認可の対象にするか、無料モデル限定とは別の設定にするかを決める。
- **既存ギルドへの影響**: `free-only`・`llm-details`・`auto-reply` を一般メンバーが操作していたギルドでは、リリース後に拒否されるようになる。リリースノートで告知する。
