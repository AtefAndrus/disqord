# DisQord 実装進捗

---

## バックログ（優先度順）

各機能の詳細設計は [docs/changes/](changes/) を参照。

<!-- AUTO:PROGRESS:START -->
| 機能 | 優先度 | ステータス | 概要 |
| ---- | ------ | ---------- | ---- |
| [対話UX改善（会話履歴）](changes/conversation-context/design.md) | 高 | implemented | 直近の会話を Discord から読んで渡し、それより前と過去の添付はモデルが tool で取りに行く |
| [スケジュール実行（cron）](changes/cron/design.md) | 高 | planned | ユーザ/LLM が登録した定期タスクを承認後にスケジュールし、指定チャンネルへ配信 |
| [OAuth BYOK（ユーザー別 OpenRouter キー）](changes/oauth-byok/design.md) | 高 | planned | OAuth PKCE によるユーザー別 OpenRouter API キー（BYOK） |
| [バックグラウンドタスク基盤](changes/background-task/design.md) | 中 | investigating | 重い処理を Discord イベントハンドラ外で走らせ、完了後に follow-up / 編集で結果を返す in-memory ジョブ基盤 |
| [コード実行（OpenRouter shell server tool）](changes/code-execution/design.md) | 中 | investigating | OpenRouter の shell server tool による hosted サンドボックスでのコード実行と、その結果の Discord 表示 |
| [回答の再生成・編集/undo・compaction](changes/conversation-regeneration/design.md) | 中 | planned | 会話履歴ストアの上に載る再生成（generation_number）・undo（active）・履歴 compaction（要約圧縮） |
| [カスタム絵文字・スタンプ・GIF への対応](changes/discord-expressions/design.md) | 中 | planned | カスタム絵文字、スタンプ、GIF の埋め込みをモデルが読めるようにし、返信でサーバーのカスタム絵文字を使えるようにする |
| [Discord 操作ツール](changes/discord-tool/design.md) | 中 | planned | リアクション、投票、スレッド作成、ピン留めを、会話の流れでモデルが行える client tool 群 |
| [過去の画像を開く e2e](changes/e2e-image-attachment/design.md) | 中 | implemented | view_attachment が画像を開く経路を e2e で確かめる |
| [終了時の進行中返信の後始末](changes/graceful-shutdown/design.md) | 中 | investigating | bot の終了時に、生成途中の返信を停止表示へ書き換えてから落とす |
| [ログ集約サービスのセルフホスト](changes/log-aggregation/design.md) | 中 | planned | VictoriaLogs / Loki / OpenObserve 等によるログ集約基盤 |
| [メッセージの解説（コンテキストメニュー）](changes/message-explain/design.md) | 中 | planned | メッセージの右クリックメニュー「アプリ → 解説する」で、そのメッセージの専門用語や背景を本人にだけ見える返信で解説する |
| [出力マルチモーダル対応](changes/multimodal-output/design.md) | 中 | investigating | 検証済みの生成画像と生成ファイルを Discord の MediaGallery / File で表示 |
| [権限管理](changes/permissions/design.md) | 中 | planned | チャンネル制限と、設定変更の共通認可契約（admin_role_id） |
| [推論内容の取得・表示](changes/reasoning-output/design.md) | 中 | planned | Responses API の reasoning item を受け取り、tool を挟む生成では送り返し、設定に応じて回答に推論のファイルを添える |
| [Renovate 移行](changes/renovate-migration/design.md) | 中 | implemented | Dependabot を Renovate (Mend App) に置き換え、手動ピン更新を自動化 |
| [OpenRouter サーバツール群](changes/server-tools/design.md) | 中 | investigating | image_generation / fusion / advisor / subagent の OpenRouter server tool 群（web_search/web_fetch は web-search 側） |
| [ギルド設定の同時変更で変更が消えないようにする](changes/settings-concurrent-writes/design.md) | 中 | in-progress | 同時に走った設定変更が互いを消さないよう、書き込みを 1 つのトランザクションにまとめる（実装済み、実クライアントでの確認待ち） |
| [設定階層化 + LLMパラメータ + カスタムプロンプト](changes/settings-hierarchy/design.md) | 中 | planned | guild/channel/user 設定階層 + LLM パラメータ + カスタムプロンプト |
| [Web 検索 + ツイート展開](changes/web-search/design.md) | 中 | in-progress | OpenRouter server tools による Web 検索と fxtwitter ツイート展開 |
| [セッション分岐 (/fork)](changes/fork/design.md) | 低 | investigating | 会話履歴の途中から新しいセッションへ分岐する /fork（参照コピー・session_id 安定性前提） |
| [ストリーミング中の分割表示の改善](changes/streaming-split-ux/design.md) | 低 | investigating | 複数メッセージに分かれる返信で、数文字だけのメッセージが現れたり文章が移動して見えたりする表示を直す |
| [使用統計](changes/usage-stats/design.md) | 低 | planned | サーバー/ユーザー/モデル別の使用統計（/stats） |
<!-- AUTO:PROGRESS:END -->

---

## 完了済み

変更履歴の詳細は [CHANGELOG.md](../CHANGELOG.md) を参照。
