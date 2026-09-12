---
title: "リリース手順の簡素化"
status: in-progress
priority: medium
summary: "GitHub 自動生成ノートと対象バージョン付き CHANGELOG によるリリース"
---

# リリース手順の簡素化

## Why

従来のリリース手順では、作業者が前回タグ以降の差分と過去の Release を読み、日本語の Release notes を毎回組み立てていた。
この手作業は作業時間を増やし、記載範囲と表現を作業者の判断に依存させる。
さらに、対象タグを作成する前の `git-cliff` にバージョンを渡していなかったため、リリースコミットへ含める CHANGELOG の最新見出しが `Unreleased` のままになっていた。

## Goals / Non-Goals

**Goals:**

- タグ作成前に対象バージョンを明示して CHANGELOG を生成する
- push 済みタグから GitHub の自動生成 Release notes を作る
- `git-cliff` を検証済みの完全なバージョンへ固定する
- リリース作業者が差分と過去の Release を読んで日本語ノートを書く工程をなくす

**Non-Goals:**

- GitHub Actions、Release Please、semantic-release、release PR workflow を導入すること
- デプロイ workflow、CI workflow、アプリケーション、リリース通知機能を変更すること
- GitHub が生成する Release notes の分類や文面をこの change で調整すること

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| CHANGELOG の対象バージョン | タグ作成前に `git-cliff --tag v<version> --output CHANGELOG.md` を実行 | `--tag` はリポジトリへタグを作らず、未リリースのコミットを指定バージョンへ割り当てるため、リリースコミットへ対象バージョンの見出しを含められる |
| Release notes | `gh release create` の `--generate-notes` を使用 | GitHub が前回 Release との差分からノートを生成するため、作業者による差分調査と文面作成が不要になる |
| タグの前提 | `--verify-tag` を使用 | remote に対象タグがない場合に Release 作成を中止し、GitHub CLI が別の revision からタグを自動作成することを防ぐ |
| `git-cliff` のバージョン | `2.12.0` に固定 | 現在の mise 環境で `--tag` と `--output` を使った生成を検証できた完全なバージョンであり、`latest` による実行環境の変化を避けられる |
| 実行基盤 | 既存のローカル `/release` skill を維持 | リリース自動化基盤を追加せず、現在の main 上のリリースコミット、タグ、push の流れを保てる |

## Design

### 変更対象ファイル

- 修正: `.agents/skills/release/SKILL.md` — CHANGELOG 生成へ対象バージョンを渡し、GitHub Release を自動生成ノートで作成する
- 修正: `mise.toml` — `git-cliff` を `2.12.0` に固定する
- 新規: `docs/changes/release-workflow-simplification/design.md` — 変更の目的、判断、実装内容を記録する
- 生成: `docs/progress.md` — この change をバックログへ反映する

`.claude/skills/release/SKILL.md` は共有元を参照する薄い adapter であるため変更しない。

### CHANGELOG の生成

リリース作業者は `package.json` のバージョン更新後、タグを作成する前に次のコマンドを実行する。

```bash
git-cliff --tag v<version> --output CHANGELOG.md
```

生成後は、CHANGELOG の最初のリリース見出しが `## [<version>]` であり、`## [Unreleased]` ではないことを確認する。
生成コマンドと `git-cliff` のバージョンを固定するため、作業者は対象バージョン付き CHANGELOG の生成手順を同じ条件で再実行できる。

### GitHub Release の作成

リリースコミットへタグを付けて commit と tag を push した後、次のコマンドを実行する。

```bash
gh release create v<version> --title "v<version>" --generate-notes --verify-tag
```

`--generate-notes` は GitHub Release Notes API に Release notes の生成を任せる。
`--verify-tag` は push 済みタグを作成元として要求し、対象タグが remote にない状態での Release 作成を拒否する。

## Tasks

- [x] `git-cliff` と `gh release create` の対象 option を実機 help と公式資料で確認する
- [x] `git-cliff` を検証済みの完全なバージョンへ固定する
- [x] CHANGELOG 生成時に対象バージョンを明示する
- [x] GitHub Release を自動生成ノートと push 済みタグから作成する
- [x] 手書き日本語 Release notes の調査と作成手順を削除する
- [x] `/release` skill の invocation policy を維持する
- [x] 生成文書、テスト、lint を検証する
- [ ] `docs/changes/release-workflow-simplification/` 削除（リリース完了時、git 履歴がアーカイブ）

## Open Questions / Risks

GitHub が生成する Release notes の内容は Pull Request のタイトル、ラベル、GitHub 側の設定に依存する。
分類や文面に不足が見つかった場合は、手書き手順へ戻さず、GitHub の自動生成設定を扱う別 change で対応する。

## 参照

- [git-cliff のコマンド例](https://github.com/orhun/git-cliff/blob/main/website/docs/usage/examples.md)
- [GitHub CLI の `gh release create` マニュアル](https://cli.github.com/manual/gh_release_create)
