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
| 最大モデル数 | 4 | **モデルごとに別 message**（1 message = 1 モデルの Container）で送る。TextDisplay は 1 message 合計 4000 字制約があるため複数モデルを 1 message に集約しない。各 message は Container 内 10 / メッセージ全体 40 components の枠に余裕 |
| 結果表示形式 | モデルごとに 1 Container（Components V2） | [chat-response-v2](../chat-response-v2/design.md) と一貫させる。各 Container の accent color と Model badge TextDisplay でモデルを区別。`chatContainerBuilder` を再利用 |

## Design

**変更対象ファイル**:

- `src/services/chatService.ts` - 並列リクエスト、エラーハンドリング
- `src/bot/commands/model.ts` - `compare`サブコマンド追加
- `src/bot/events/messageCreate.ts` - 複数 Container 送信ロジック（`chatContainerBuilder` 再利用、`flags: MessageFlags.IsComponentsV2`、`allowedMentions: { parse: [] }`）

**コマンド設計**:

```text
/model compare <model1> <model2> [model3] [model4]
  - 2〜4モデルを指定
  - 各モデルで同じプロンプトを実行
  - 結果をモデルごとの Container (Components V2) で表示
```

**実装内容**:

1. **並列リクエスト**:
   - `Promise.allSettled()`で複数モデルに並列リクエスト
   - 各モデルの応答を個別に処理（一部失敗しても他は継続）

2. **結果表示**:
   - 各モデルの応答を別々の Container（Components V2）で表示
   - Container の accent color はモデルごとに決定論的に決定（既存の `getColorForModel` ロジック）
   - 各 Container 先頭の TextDisplay に Model badge（`**Model:** xxx`）を表示
   - 失敗したモデルは accent=red の Container（`buildErrorContainer` 相当）で表示

3. **比較メッセージヘッダー**:
   - 先頭に「比較結果」見出しの TextDisplay（または独立 Container）を 1 つ置く
   - 各モデル Container の Model badge でモデル名を識別

**設計メモ**:

- レート制限考慮: 並列リクエストで制限に達する可能性あり → エラーハンドリング強化
- 費用注意: 複数モデル実行で費用増加 → 警告メッセージ表示
- **モデルごとに別 message**（1 message = 1 モデルの Container）にする。TextDisplay は 1 message の全 TextDisplay 合計 4000 字制約があるため、複数モデルの回答を 1 message に集約しない。先頭に「比較結果」見出し message を 1 つ置く。各モデルの長文応答はさらに chat-response-v2 の `splitTextIntoMessages` で分割する。components 数（Container 内 10 / メッセージ全体 40）は各 message 単位で余裕
- Non-Goals どおり比較表示はストリーミングしない（各モデル完了後にまとめて Container 送信）

**参照**:

- [Promise.allSettled()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)
- [chat-response-v2](../chat-response-v2/design.md) - `chatContainerBuilder` / Components V2 の組み方・mention safety・分割ロジック

## Tasks

- [ ] `compare`サブコマンドをmodel.tsに追加
- [ ] chatServiceに並列リクエストロジック実装
- [ ] 複数 Container 送信ロジック実装（`chatContainerBuilder` 再利用、V2 flag + allowedMentions）
- [ ] 費用警告メッセージ実装
- [ ] `docs/changes/model-compare/` 削除（リリース完了時、git 履歴がアーカイブ）
