# 複数モデル並列

## Why

ユーザがモデルを選択する際、各モデルの応答品質を比較する手段がない。同じ質問を複数モデルに投げて回答を並べることで、用途に最適なモデルの選択を支援する。

## Goals / Non-Goals

**Goals:**

- 同じプロンプトを2-4モデルに並列送信し、応答を比較表示
- 一部モデルが失敗しても他の結果は表示

**Non-Goals:**

- 自動的な「最良モデル」の判定
- 比較結果の保存・統計化
- ストリーミング表示での比較

## Decisions

| 判断事項 | 選択 | 理由 |
| -------- | ---- | ---- |
| 並列実行方式 | `Promise.allSettled()` | 一部失敗でも他は継続 |
| 最大モデル数 | 4 | Discord Embed制限（10個）に余裕を持たせる |
| 結果表示形式 | 個別Embed | モデルごとの応答を明確に区別 |

## Design

**変更対象**:

- `src/services/chatService.ts` - 並列リクエスト、エラーハンドリング
- `src/bot/commands/model.ts` - `compare`サブコマンド追加
- `src/bot/events/messageCreate.ts` - 複数Embed送信ロジック

**コマンド設計**:

```text
/model compare <model1> <model2> [model3] [model4]
  - 2〜4モデルを指定
  - 各モデルで同じプロンプトを実行
  - 結果を別々のEmbedで表示
```

**実装内容**:

1. **並列リクエスト**:
   - `Promise.allSettled()`で複数モデルに並列リクエスト
   - 各モデルの応答を個別に処理（一部失敗しても他は継続）

2. **結果表示**:
   - 各モデルの応答を別々のEmbedで表示
   - Embedカラーはモデルごとに決定論的に決定（既存ロジック）
   - 失敗したモデルはエラーEmbedで表示

3. **比較メッセージヘッダー**:
   - 「比較結果: モデルA vs モデルB」
   - 各Embedのタイトルにモデル名を表示

**設計メモ**:

- レート制限考慮: 並列リクエストで制限に達する可能性あり → エラーハンドリング強化
- 費用注意: 複数モデル実行で費用増加 → 警告メッセージ表示

**参照**:

- [Promise.allSettled()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)

## Tasks

- [ ] `compare`サブコマンドをmodel.tsに追加
- [ ] chatServiceに並列リクエストロジック実装
- [ ] 複数Embed送信ロジック実装
- [ ] 費用警告メッセージ実装
