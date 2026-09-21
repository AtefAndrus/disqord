# DisQord 実装進捗

---

## バックログ（優先度順）

各機能の詳細設計は [docs/changes/](changes/) を参照。

<!-- AUTO:PROGRESS:START -->
| 機能 | 優先度 | ステータス | 概要 |
| ---- | ------ | ---------- | ---- |
| [Bot 管理 API（admin endpoints）](changes/admin-endpoints/design.md) | 高 | implemented | HMAC 認証付き管理エンドポイント（ログ取得・メトリクス） |
| [LLM チャット返信の Components V2 化](changes/chat-response-v2/design.md) | 高 | implemented | LLM チャット返信を Components V2 化し、Markdown の fenced code block を保ったまま分割 |
| [CI パイプライン整備 + Actions サプライチェーン対策 + mise SSOT](changes/ci-pipeline/design.md) | 高 | implemented | CI 新設・workflow hardening・mise SSOT 化 |
| [対話UX改善（会話履歴ストア）](changes/conversation-context/design.md) | 高 | planned | DB 永続の会話履歴、OpenRouter session routing、prompt cache 計測、境界・構造化メディア・保持 |
| [スケジュール実行（cron）](changes/cron/design.md) | 高 | planned | ユーザ/LLM が登録した定期タスクを承認後にスケジュールし、指定チャンネルへ配信 |
| [マルチモーダル対応](changes/multimodal/design.md) | 高 | implemented | 画像・PDF 添付の LLM 入力対応 |
| [OAuth BYOK（ユーザー別 OpenRouter キー）](changes/oauth-byok/design.md) | 高 | planned | OAuth PKCE によるユーザー別 OpenRouter API キー（BYOK） |
| [Responses API への移行](changes/responses-api-migration/design.md) | 高 | implemented | LLM 呼び出しを Chat Completions から Responses API へ振る舞いを変えずに載せ替える |
| [ツール呼び出し基盤](changes/tool-calling-foundation/design.md) | 高 | implemented | OpenRouter client tool calling のマルチターン実行基盤（tool registry + streaming ループ） |
| [バックグラウンドタスク基盤](changes/background-task/design.md) | 中 | investigating | 重い処理を Discord イベントハンドラ外で走らせ、完了後に follow-up / 編集で結果を返す in-memory ジョブ基盤 |
| [コード実行（OpenRouter shell server tool）](changes/code-execution/design.md) | 中 | investigating | OpenRouter の shell server tool による hosted サンドボックスでのコード実行と、その結果の Discord 表示 |
| [回答の再生成・編集/undo・compaction](changes/conversation-regeneration/design.md) | 中 | planned | 会話履歴ストアの上に載る再生成（generation_number）・undo（active）・履歴 compaction（要約圧縮） |
| [デフォルトモデル定数の SSOT 化](changes/default-model-ssot/design.md) | 中 | implemented | envVars.ts を DEFAULT_MODEL の単一ソース化 |
| [Discord 操作ツール](changes/discord-tool/design.md) | 中 | planned | LLM に境界付きの Discord 操作（履歴取得/メンバー検索/スレッド作成/ピン/追加文脈取得）を与える client tool 群 |
| [終了時の進行中返信の後始末](changes/graceful-shutdown/design.md) | 中 | investigating | bot の終了時に、生成途中の返信を停止表示へ書き換えてから落とす |
| [ログ集約サービスのセルフホスト](changes/log-aggregation/design.md) | 中 | planned | VictoriaLogs / Loki / OpenObserve 等によるログ集約基盤 |
| [メッセージの解説（コンテキストメニュー）](changes/message-explain/design.md) | 中 | planned | メッセージの右クリックメニュー「アプリ → 解説する」で、そのメッセージの専門用語や背景を本人にだけ見える返信で解説する |
| [モデルコマンドの詳細表示](changes/model-command-ux/design.md) | 中 | implemented | /model current と set の詳細表示を共通化し、OpenRouter のモデルページへリンク |
| [複数モデル並列](changes/model-compare/design.md) | 中 | planned | /compare で複数モデルへ並列リクエストし回答を比較 |
| [出力マルチモーダル対応](changes/multimodal-output/design.md) | 中 | investigating | 検証済みの生成画像と生成ファイルを Discord の MediaGallery / File で表示 |
| [権限管理](changes/permissions/design.md) | 中 | planned | チャンネル制限と、設定変更の共通認可契約（admin_role_id） |
| [推論内容の取得・表示](changes/reasoning-output/design.md) | 中 | planned | OpenRouter の reasoning / reasoning_details を安全に受け取り、設定に応じて Discord へ表示 |
| [GitHub Release 通知機能の削除](changes/release-notification-removal/design.md) | 中 | implemented | Discord への GitHub Release 通知とそのための Webhook、設定、永続化項目をアプリケーションから削除 |
| [リリース手順の簡素化](changes/release-workflow-simplification/design.md) | 中 | implemented | GitHub 自動生成ノートと対象バージョン付き CHANGELOG によるリリース |
| [Renovate 移行](changes/renovate-migration/design.md) | 中 | in-progress | Dependabot を Renovate (Mend App) に置き換え、手動ピン更新を自動化 |
| [OpenRouter サーバツール群](changes/server-tools/design.md) | 中 | investigating | image_generation / fusion / advisor / subagent の OpenRouter server tool 群（web_search/web_fetch は web-search 側） |
| [設定階層化 + LLMパラメータ + カスタムプロンプト](changes/settings-hierarchy/design.md) | 中 | planned | guild/channel/user 設定階層 + LLM パラメータ + カスタムプロンプト |
| [画像の遅延再注入](changes/view-image-rehydration/design.md) | 中 | planned | 剥がした過去画像をモデル要求時にベストエフォート再取得して当該ターンへ再注入する view_image client tool |
| [Web 検索 + ツイート展開](changes/web-search/design.md) | 中 | planned | OpenRouter server tools による Web 検索と fxtwitter ツイート展開 |
| [セッション分岐 (/fork)](changes/fork/design.md) | 低 | investigating | 会話履歴の途中から新しいセッションへ分岐する /fork（参照コピー・session_id 安定性前提） |
| [ストリーミング中の分割表示の改善](changes/streaming-split-ux/design.md) | 低 | investigating | 複数メッセージに分かれる返信で、数文字だけのメッセージが現れたり文章が移動して見えたりする表示を直す |
| [Bot UI プレビュー（visual refine）](changes/ui-preview/design.md) | 低 | implemented | プレビュー描画基盤（残タスクは任意項目のみ） |
| [使用統計](changes/usage-stats/design.md) | 低 | planned | サーバー/ユーザー/モデル別の使用統計（/stats） |
<!-- AUTO:PROGRESS:END -->

---

## 完了済み

変更履歴の詳細は [CHANGELOG.md](../CHANGELOG.md) を参照。
