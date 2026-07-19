# DisQord 実装進捗

---

## バックログ（優先度順）

各機能の詳細設計は [docs/changes/](changes/) を参照。

<!-- AUTO:PROGRESS:START -->
| 機能 | 優先度 | ステータス | 概要 |
| ---- | ------ | ---------- | ---- |
| [Bot 管理 API（admin endpoints）](changes/admin-endpoints/design.md) | 高 | implemented | HMAC 認証付き管理エンドポイント（ログ取得・メトリクス） |
| [LLM チャット返信の Components V2 化](changes/chat-response-v2/design.md) | 高 | implemented | LLM チャット返信を Components V2（Container/Section）化 |
| [CI パイプライン整備 + Actions サプライチェーン対策 + mise SSOT](changes/ci-pipeline/design.md) | 高 | implemented | CI 新設・workflow hardening・mise SSOT 化 |
| [対話UX改善（会話履歴ストア）](changes/conversation-context/design.md) | 高 | planned | DB 永続の論理ターン/セッション履歴・境界検出・構造化メディア・保持。再生成系は別 change |
| [スケジュール実行（cron）](changes/cron/design.md) | 高 | planned | ユーザ/LLM が登録した定期タスクを承認後にスケジュールし、指定チャンネルへ配信 |
| [マルチモーダル対応](changes/multimodal/design.md) | 高 | implemented | 画像・PDF 添付の LLM 入力対応 |
| [OAuth BYOK（ユーザー別 OpenRouter キー）](changes/oauth-byok/design.md) | 高 | planned | OAuth PKCE によるユーザー別 OpenRouter API キー（BYOK） |
| [ツール呼び出し基盤](changes/tool-calling-foundation/design.md) | 高 | in-progress | OpenRouter client tool calling のマルチターン実行基盤（tool registry + streaming ループ） |
| [バックグラウンドタスク基盤](changes/background-task/design.md) | 中 | investigating | 重い処理を Discord イベントハンドラ外で走らせ、完了後に follow-up / 編集で結果を返す in-memory ジョブ基盤 |
| [コード実行（microsandbox 統合）](changes/code-execution/design.md) | 中 | planned | microsandbox による安全なコード実行（/run・LLM tool 統合） |
| [回答の再生成・編集/undo・compaction](changes/conversation-regeneration/design.md) | 中 | planned | 会話履歴ストアの上に載る再生成（generation_number）・undo（active）・履歴 compaction（要約圧縮） |
| [デフォルトモデル定数の SSOT 化](changes/default-model-ssot/design.md) | 中 | implemented | envVars.ts を DEFAULT_MODEL の単一ソース化 |
| [Discord 操作ツール](changes/discord-tool/design.md) | 中 | planned | LLM に境界付きの Discord 操作（履歴取得/メンバー検索/スレッド作成/ピン/追加文脈取得）を与える client tool 群 |
| [ログ集約サービスのセルフホスト](changes/log-aggregation/design.md) | 中 | planned | VictoriaLogs / Loki / OpenObserve 等によるログ集約基盤 |
| [複数モデル並列](changes/model-compare/design.md) | 中 | planned | /compare で複数モデルへ並列リクエストし回答を比較 |
| [OpenRouter API 整合監査](changes/openrouter-api-audit/design.md) | 中 | planned | 実装済み OpenRouter 連携を現行 API へ整合（deprecated な usage:{include} 撤去ほか） |
| [リリース更新通知のポーリング化](changes/release-polling/design.md) | 中 | planned | リリース通知を GitHub Webhook からポーリング方式へ移行 |
| [Renovate 移行](changes/renovate-migration/design.md) | 中 | planned | Dependabot を Renovate (Mend App) に置き換え、手動ピン更新を自動化 |
| [OpenRouter サーバツール群](changes/server-tools/design.md) | 中 | investigating | image_generation / fusion / advisor / subagent の OpenRouter server tool 群（web_search/web_fetch は web-search 側） |
| [設定階層化 + LLMパラメータ + カスタムプロンプト](changes/settings-hierarchy/design.md) | 中 | planned | guild/channel/user 設定階層 + LLM パラメータ + カスタムプロンプト |
| [画像の遅延再注入](changes/view-image-rehydration/design.md) | 中 | planned | 剥がした過去画像をモデル要求時にベストエフォート再取得して当該ターンへ再注入する view_image client tool |
| [Web 検索 + ツイート展開](changes/web-search/design.md) | 中 | planned | OpenRouter server tools による Web 検索と fxtwitter ツイート展開 |
| [セッション分岐 (/fork)](changes/fork/design.md) | 低 | investigating | 会話履歴の途中から新しいセッションへ分岐する /fork（参照コピー・session_id 安定性前提） |
| [権限管理 + 使用統計](changes/permissions-stats/design.md) | 低 | planned | チャンネル/ロール権限管理と使用統計（/stats） |
| [Bot UI プレビュー（visual refine）](changes/ui-preview/design.md) | 低 | implemented | プレビュー描画基盤（残タスクは任意項目のみ） |
<!-- AUTO:PROGRESS:END -->

---

## 完了済み

変更履歴の詳細は [CHANGELOG.md](../CHANGELOG.md) を参照。
