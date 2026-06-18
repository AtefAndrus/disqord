# DisQord 実装進捗

本ドキュメントはコーディングエージェントが進捗を把握するためのもの。

---

## バックログ（優先度順）

各機能の詳細設計は [docs/changes/](changes/) を参照。

<!-- AUTO:PROGRESS:START -->
| 機能 | 優先度 | ステータス | 概要 |
| ---- | ------ | ---------- | ---- |
| [Bot 管理 API（admin endpoints）](changes/admin-endpoints/design.md) | 高 | implemented | HMAC 認証付き管理エンドポイント（ログ取得・メトリクス） |
| [LLM チャット返信の Components V2 化](changes/chat-response-v2/design.md) | 高 | planned |  |
| [CI パイプライン整備 + Actions サプライチェーン対策 + mise SSOT](changes/ci-pipeline/design.md) | 高 | implemented | CI 新設・workflow hardening・mise SSOT 化 |
| [対話UX改善](changes/conversation-context/design.md) | 高 | planned |  |
| [マルチモーダル対応](changes/multimodal/design.md) | 高 | implemented | 画像・PDF 添付の LLM 入力対応 |
| [OAuth BYOK（ユーザー別 OpenRouter キー）](changes/oauth-byok/design.md) | 高 | planned |  |
| [コード実行（microsandbox 統合）](changes/code-execution/design.md) | 中 | planned |  |
| [デフォルトモデル定数の SSOT 化](changes/default-model-ssot/design.md) | 中 | in-progress | envVars.ts を DEFAULT_MODEL の単一ソース化 |
| [ログ集約サービスのセルフホスト](changes/log-aggregation/design.md) | 中 | planned | VictoriaLogs / Loki / OpenObserve 等によるログ集約基盤 |
| [複数モデル並列](changes/model-compare/design.md) | 中 | planned |  |
| [リリース更新通知のポーリング化](changes/release-polling/design.md) | 中 | planned |  |
| [設定階層化 + LLMパラメータ + カスタムプロンプト](changes/settings-hierarchy/design.md) | 中 | planned |  |
| [Web 検索 + ツイート展開](changes/web-search/design.md) | 中 | planned |  |
| [権限管理 + 使用統計](changes/permissions-stats/design.md) | 低 | planned |  |
| [Bot UI プレビュー（visual refine）](changes/ui-preview/design.md) | 低 | implemented | プレビュー描画基盤（残タスクは任意項目のみ） |
<!-- AUTO:PROGRESS:END -->

---

## 完了済み

変更履歴の詳細は [CHANGELOG.md](../CHANGELOG.md) を参照。
