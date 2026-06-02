# DisQord 実装進捗

本ドキュメントはコーディングエージェントが進捗を把握するためのもの。

---

## バックログ（優先度順）

上から優先度が高い順に並べる。バージョン番号はリリース時に決定する。
各機能の詳細設計は [docs/changes/](changes/) を参照。

### CI パイプライン整備 + Actions サプライチェーン対策 + mise SSOT

優先度: 高 / 設計: [ci-pipeline](changes/ci-pipeline/design.md)

### Bot 管理 API（admin endpoints）

優先度: 高 / 設計: [admin-endpoints](changes/admin-endpoints/design.md)

### OAuth BYOK（ユーザー別 OpenRouter キー）

優先度: 高 / 設計: [oauth-byok](changes/oauth-byok/design.md)

### 対話UX改善

優先度: 高 / 設計: [conversation-context](changes/conversation-context/design.md)

### マルチモーダル対応

優先度: 高 / 設計: [multimodal](changes/multimodal/design.md)

### LLM チャット返信の Components V2 化

優先度: 高 / 設計: [chat-response-v2](changes/chat-response-v2/design.md)（multimodal 完了後に着手）

### コード実行（microsandbox）

優先度: 中 / 設計: [code-execution](changes/code-execution/design.md)

### デフォルトモデル定数の SSOT 化

優先度: 中 / 設計: [default-model-ssot](changes/default-model-ssot/design.md)

### Web Search

優先度: 中 / 設計: [web-search](changes/web-search/design.md)

### 複数モデル並列

優先度: 中 / 設計: [model-compare](changes/model-compare/design.md)

### 設定階層化 + パラメータ + プロンプト

優先度: 中 / 設計: [settings-hierarchy](changes/settings-hierarchy/design.md)

### 権限管理 + 使用統計

優先度: 低 / 設計: [permissions-stats](changes/permissions-stats/design.md)

### ログ集約サービスのセルフホスト

優先度: 中 / 設計: Phase 2 着手時に作成（候補は VictoriaLogs / Grafana Loki monolithic / OpenObserve）

### Bot UI プレビュー（visual refine）

優先度: 低 / 設計: [ui-preview](changes/ui-preview/design.md)（プロトタイプ実装済み。残タスクは任意項目のみ）

---

## 完了済み

変更履歴の詳細は [CHANGELOG.md](../CHANGELOG.md) を参照。
