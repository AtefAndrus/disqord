---
title: "ギルド設定変更の共通認可"
status: implemented
priority: high
summary: "ギルド設定を変更できるかの判定を共通関数 canManageGuildSettings（ManageGuild または admin_role_id のロール）にまとめ、既存のすべての書き込みの入口に掛ける"
---

# ギルド設定変更の共通認可

## Why

ギルド設定を誰が変更できるかが、設定ごとにばらばらである。
`/config web-search`・`reasoning-display`・`twitter-expand`・`history` の 4 つは、handler がそれぞれ `ManageGuild` を直接確認している（`src/bot/commands/handlers.ts:247,273,300,328`）。
`/status` の切り替えボタンは同じ 4 設定についてだけ、別の箇所で同じ確認をしている（`src/bot/events/interactionCreate.ts:258`）。
一方で `/config free-only`・`llm-details`・`auto-reply add|remove` と、`/status` の `free_only`・`llm_details` ボタンは誰でも実行できる。
無料モデル限定を切ると有料モデルを選べるようになり、自動応答チャンネルを足すとそのチャンネルの全発言に Bot が応答する。
どちらも Bot の運営者の OpenRouter クレジットを消費する操作だが、現状は一般メンバーが実行できる。

本 change は、ギルド設定を変更できるかの判定を共通関数 1 つにまとめ、既存のすべての書き込みの入口がそれを呼ぶようにする。
設定パネル、スケジュール実行、使用統計、コード実行、画像生成、Discord 操作ツール、リリース通知、設定階層化、OAuth BYOK の design がこの共通関数を前提にしているため、それらより先に実装する。

## 依存 / 関連 change

- 後続: [設定パネル（/config の再構成）](../config-panel/design.md) — 本 change の後に実装する。パネルのすべての書き込みを本 change の共通認可関数で判定し、`admin_role_id` を設定する入口（「管理」ページ）とチャンネル制限（許可チャンネル）を同 change が持つ
- 後続: [スケジュール実行（cron）](../cron/design.md) / [使用統計](../usage-stats/design.md) / [コード実行](../code-execution/design.md) / [画像生成](../image-generation/design.md) / [Discord 操作ツール](../discord-tool/design.md) / [リリース通知](../release-announcement/design.md) / [OAuth BYOK](../oauth-byok/design.md) — 本 change の共通認可関数を使う
- 関連: [Discord 操作ツール](../discord-tool/design.md) — Discord 操作ツールの有効化の切り替えは本 change の共通認可関数で判定する。一方、ツール実行時に「依頼者本人がそのチャンネルでその操作をできるか」を確かめる認可は同 change が持ち、本 change の `admin_role_id` には置き換えない
- 関連: [設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) — guild と channel のスコープへの書き込みに本 change の認可を使う

## Goals / Non-Goals

**Goals:**

- ギルド設定を変更できるかの判定を共通関数 1 つで表現し、スラッシュコマンドと `/status` のボタンの両方の入口から呼ぶ
- 現在の `/config` のすべての書き込み（無料モデル限定と自動応答チャンネルを含む）を認可の対象にする
- ギルド設定の変更を委譲するロールを保存する列 `admin_role_id` を用意し、未設定時の既定動作を確定する

**Non-Goals:**

- チャンネル制限（許可チャンネル）。[設定パネル](../config-panel/design.md) が扱う
- `admin_role_id` を設定する UI。[設定パネル](../config-panel/design.md) の「管理」ページが扱う
- `/config` の再構成と、`/status` から設定の変更を外すこと。[設定パネル](../config-panel/design.md) が扱う
- 使用統計（[使用統計](../usage-stats/design.md)）
- ユーザーごとの使用量制限（レートリミット）
- ロール単位の機能設定（[設定階層化 + LLMパラメータ](../settings-hierarchy/design.md) の scope とは別軸）
- `/model set` の認可（理由と残る懸念は Decisions と Open Questions に書く）
- メッセージ単位の操作（再生成やツールによる Discord 操作など）の認可。対象メッセージの発言者や依頼者の権限で判定するもので、各 change が持つ

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 認可の対象 | `/config` のすべての書き込みと、`/status` の設定を変えるすべてのボタン（旧形式の `status_toggle_*` を含む） | 課金への影響で設定を選り分けると、設定を足すたびに分類が要り、分類漏れが無料モデル限定のような無防備な設定を生む。規則を「ギルド設定を変えるには認可が要る」の一文にすれば漏れようがない |
| `llm-details` を対象に含めるか | 含める | 課金には影響しないが、全メンバーの表示を変えるギルド全体の設定である。この 1 件だけ例外にすると上の一文の規則が崩れる |
| `/model set` | 認可の対象にしない | 有料モデルを選べるかは無料モデル限定が決め、その切り替えを本 change で保護する。管理者は無料モデル限定を保つことで一般メンバーのモデル選択を無料モデルに限定できる |
| 認可される条件 | `ManageGuild` を持つメンバー、または `admin_role_id` のロールを持つメンバー | `admin_role_id` は権限を委譲する追加の経路にとどめる。ロールだけに絞ると、ロールの削除や設定ミスでサーバー管理者が設定を変えられなくなる。`ManageGuild` の持ち主はサーバー設定そのものを変えられるので、Bot の設定だけ拒んでも守れるものがない |
| `admin_role_id` を加える時期 | 列と判定は本 change で加え、値を設定する入口は [設定パネル](../config-panel/design.md) が加える | 共通関数の引数と判定を最初から確定させておけば、後続の change が関数の形を変えずに済む。入口が加わるまでは列が NULL のままなので、`ManageGuild` の持ち主だけが通る |
| 認可の表現 | 共通関数 1 つに集約し、各入口はそれを呼ぶ | 同じ確認を入口ごとに書くと、入口を足したときに確認を書き漏らす（`/status` の `free_only` ボタンが現にそうなっている） |
| `setDefaultMemberPermissions` | 使わない | コマンドの既定権限で隠すと、`ManageGuild` を持たない管理ロールの持ち主の一覧からもコマンドが消える。管理ロールは Bot の DB にあり、Discord のコマンド権限とは連動しない。[設定パネル](../config-panel/design.md) も同じ理由で `default_member_permissions` を付けない。認可は handler 内で判定する |

## Design

### 変更対象ファイル

- 修正: `src/db/schema.ts` — `guild_settings` に `admin_role_id` 列を追加
- 修正: `src/db/repositories/guildSettings.ts` / `src/types/index.ts`（`GuildSettings`）— `adminRoleId` の読み込み
- 新規: `src/services/settingsAuthorization.ts` — 共通認可関数と拒否文言。メッセージを読めるかを判定する `src/services/messageAuthorization.ts` とは判定の軸が違うので別ファイルにする
- 修正: `src/bot/commands/handlers.ts` — `/config` の書き込み系 handler すべてで共通関数を呼び、`ManageGuild` の直接確認を削る
- 修正: `src/bot/events/interactionCreate.ts` — `status_set:<key>` のボタン 6 種と、旧形式の `status_toggle_free_only` / `status_toggle_llm_details` ボタンで共通関数を呼ぶ。`ManageGuild` の直接確認と、4 設定だけを対象にした拒否文言の分岐を削る

### DB スキーマ変更

```sql
ALTER TABLE guild_settings ADD COLUMN admin_role_id TEXT;  -- NULL = ManageGuild の持ち主だけが変更できる
```

本 change は列を加えるだけで、値を書き込む経路を持たない。
値は [設定パネル](../config-panel/design.md) の「管理」ページから設定する。

### 共通認可関数

```ts
function canManageGuildSettings(
  member: { permissions: Readonly<PermissionsBitField> | null; roleIds: readonly string[] },
  settings: Pick<GuildSettings, "adminRoleId">,
): boolean;
```

- `ManageGuild` を持つか、`adminRoleId` が非 NULL でそのロールを持てば true を返す。`permissions` が取れない場合は false とする。
- 引数を discord.js のインタラクションやメッセージではなく権限とロール ID の組にするのは、スラッシュコマンド、ボタン、選択メニュー、modal の送信、メッセージ（`message.member`）のどこからでも同じ関数を呼べるようにするためである。
- 拒否したときの文言も 1 つにまとめ、`admin_role_id` の有無に応じて必要な権限またはロールを示す。
- 本 change での呼び出し元は次の 2 種類である。
  - `/config` の書き込み系サブコマンド（`free-only`、`llm-details`、`web-search`、`reasoning-display`、`twitter-expand`、`history`、`auto-reply add|remove`。`interaction.memberPermissions` と、`interaction.member` のロール ID）
  - `/status` の設定ボタン（`status_set:<key>` の 6 種と旧形式の `status_toggle_*`。同上）
- 会話中の tool に依頼者の判定結果を渡す経路（`IToolContext.canManageGuildSettings`）は、それを最初に使う [スケジュール実行（cron）](../cron/design.md) が加える。
- [設定パネル](../config-panel/design.md) は `/config` のサブコマンドと `/status` の設定ボタンを置き換え、パネルのボタン、選択メニュー、modal の送信、確認の押下のすべてでこの関数を呼ぶ。`admin_role_id` そのものの変更だけは、この関数ではなく `ManageGuild` で判定する（委譲されたロールの持ち主が委譲先を付け替えられないようにするため）。

**参照**:

- [discord.js PermissionsBitField](https://discord.js.org/docs/packages/discord.js/14.27.0/PermissionsBitField:Class) - `has()` で権限を確認する
- [discord.js GuildMember](https://discord.js.org/docs/packages/discord.js/14.27.0/GuildMember:Class) - `roles.cache.has(roleId)` でロール所属を確認する

## Tasks

- [x] `guild_settings` に `admin_role_id` 列を追加（schema / types / repository）
- [x] `settingsAuthorization.ts` に共通認可関数と拒否文言を実装
- [x] `/config` の書き込み系 handler すべてを共通関数に切り替える（`free-only`・`llm-details`・`auto-reply add|remove` を新たに対象へ含める）
- [x] `/status` のボタン（`status_set:<key>` と旧形式の `status_toggle_*`）を共通関数に切り替える
- [x] テスト追加（`admin_role_id` の設定時と未設定時、ロールを持たない `ManageGuild` 保持者、`permissions` が取れない場合、ボタン入口での拒否）
- [ ] `docs/changes/permissions/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **無料モデル限定を切った後の `/model set`**: 無料モデル限定を切ると、一般メンバーも `/model set` で高価なモデルを選べる。管理者が有料モデルを使いたいが選択は自分で行いたい、という運用には本 change では応えられない。需要が出たら `/model set` を認可の対象にするか、無料モデル限定とは別の設定にするかを決める。
- **既存ギルドへの影響**: `free-only`・`llm-details`・`auto-reply` を一般メンバーが操作していたギルドでは、リリース後に拒否されるようになる。[設定パネル](../config-panel/design.md) がリリースされるまでは管理ロールを設定できないので、その間は `ManageGuild` の持ち主だけが変更できる。リリースノートで告知する。
