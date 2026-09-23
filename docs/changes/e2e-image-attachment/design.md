---
title: "過去の画像を開く e2e"
status: planned
priority: medium
summary: "view_attachment が画像を開く経路を e2e で確かめる"
---

# 過去の画像を開く e2e

## Why

`view_attachment` は画像と PDF の両方を開ける。
e2e が確かめているのは PDF だけで、画像の経路（`function_call_output` に `input_image` の part を入れて返す）は単体テストと、実クライアントでの手動確認 1 回にしか支えられていない。

画像の経路は、モデルとプロバイダの側で壊れても単体テストでは分からない。
実際、`openai/gpt-6-luna` は OpenRouter 経由で画像が入力に載らず、同じ PNG を `openai/gpt-6-sol` と `google/gemini-3.8-flash` は読み取れる（2026-09-23 実測）。
モデルを切り替えたときに、この経路だけが静かに動かなくなる。

## Goals / Non-Goals

**Goals:**

- 過去の画像を `view_attachment` で開けることを、名前を指定して走る e2e シナリオで確かめる
- 判定が推測で通らないようにする

**Non-Goals:**

- 既定のシナリオに加えること（画像を開く往復は費用と時間が掛かるので、名前を指定したときだけ走らせる）
- 画像の内容理解の品質を測ること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 判定の材料 | 画像に埋め込んだ実行ごとの値を読ませる | 色だけの判定は、モデルが推測しても通る。`view-attachment` の PDF シナリオが実行ごとの乱数トークンを使うのと同じ理由である |
| 実行の条件 | 名前を指定したときだけ走る（`manual: true`）。開発ギルドの `/config history on` が要る | 既定の実行に入れると、履歴が OFF のギルドで必ず落ち、毎回の費用も増える |
| tool の確認 | 回答の一致に加えて、bot のログに `client tool invoked name=view_attachment` が出ることを確かめる | 窓には添付の表記しか渡らないので、tool を呼ばずに答えた場合と区別する |

## Design

### 変更対象ファイル

- 修正: `scripts/e2e/fixtures.ts` — 指定した文字列を描いた PNG を作る関数を足す（`buildPdfData` と同じ形）
- 修正: `scripts/e2e/scenarios.ts` — 画像版のシナリオを足す
- 修正: `AGENTS.md` — End-to-end の節に、このシナリオの実行条件と、画像を触る変更のときに走らせることを書く

### 実装内容

- 実行ごとに乱数のトークンを決め、それを描いた PNG を setup でメンションなしに投稿する。
- 続けて、その画像を開いてトークンを答えるよう、メンション付きで尋ねる。プロンプトにトークンを含めない。
- PNG の生成には依存を足さない。`zlib` と CRC32 は Bun の標準機能で足りる。

## Tasks

- [ ] `scripts/e2e/fixtures.ts` にトークン入りの PNG を作る関数を足す
- [ ] 画像版のシナリオを足し、tool の呼び出しログも確かめる
- [ ] AGENTS.md の End-to-end の節に実行条件を書く
- [ ] `bun run e2e` で名前を指定して実行し、結果を PR 本文に書く
- [ ] `docs/changes/e2e-image-attachment/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

- **モデルによる差**: 画像を読めないモデルを開発ギルドに設定していると落ちる。落ちたときにモデル側の問題だと分かるよう、失敗のメッセージにモデル名を入れる。
- **文字の読み取り**: 画像に描いた文字が小さいと読み違える。トークンは短くし、大きく描く。
