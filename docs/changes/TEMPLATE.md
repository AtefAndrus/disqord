---
title: "[機能名]"
status: investigating  # investigating | planned | in-progress | implemented
priority: medium       # high | medium | low
summary: ""            # 一行の概要（任意）
---

# [機能名]

## Why

1-3文で動機を説明。どのユーザ課題を解決するか。

## 依存 / 関連 change

（任意。先行が必要・連携する change を列挙。無ければ節ごと削除）

- 先行: [xxx](../xxx/design.md) — 〜が前提
- 連携: [yyy](../yyy/design.md) — 〜を共有

## Goals / Non-Goals

**Goals:**

- 具体的な成果 1
- 具体的な成果 2

**Non-Goals:**

- スコープ外の明示

**将来別 change 候補:**（任意。将来別 change で扱う項目を印付きで）

- 例: ◯◯ → 別change `xxx` として独立

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 例: 履歴の保存先 | Discord API fetch | DB肥大化を回避、Discordが情報源 |

## Design

（変更対象ファイル・DBスキーマ変更・実装内容・設計メモを記載。推奨小見出しは下記。使うものだけ残す）

### 変更対象ファイル

- 新規: `path` — 役割
- 修正: `path` — 変更内容

### DBスキーマ変更

### 実装内容

### 設計メモ

（複数サブ機能を束ねる場合は `---` で機能別小節に分割。大規模かつ共有コアありなら `design.<subfeature>.md` へ分割しこの design.md をインデックス化する。粒度方針は AGENTS.md「docs/changes」を参照）

## Tasks

（Phase やグループに分けてよい）

- [ ] ステップ 1
- [ ] ステップ 2
- [ ] `docs/changes/<feature-name>/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

（任意。未確定事項・実装時に検証が必要な点・残存リスク。無ければ節ごと削除）

## 参照

（任意。末尾にまとめる。複数機能なら各 Design 小節内に置いてもよい）
