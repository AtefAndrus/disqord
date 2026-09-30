# DisQord 実装進捗

---

## バックログ（優先度順）

各機能の詳細設計は [docs/changes/](changes/) を参照。

<!-- AUTO:PROGRESS:START -->
| 機能 | 優先度 | ステータス | 概要 |
| ---- | ------ | ---------- | ---- |
| [OAuth BYOK（ユーザー別 OpenRouter キー）](changes/oauth-byok/design.md) | 高 | investigating | OAuth PKCE によるユーザー別 OpenRouter API キー（BYOK） |
| [コード実行（OpenRouter shell server tool）](changes/code-execution/design.md) | 中 | investigating | OpenRouter の shell server tool による hosted サンドボックスでのコード実行と、その結果の Discord 表示 |
| [会話の区切り](changes/conversation-boundary/design.md) | 中 | planned | チャンネルに区切りを置き、以後の応答にそれより前の会話を自動では渡さず、モデルには区切りの存在を助言として示して必要なときだけ遡らせる |
| [回答の再生成と取り消し](changes/conversation-regeneration/design.md) | 中 | investigating | 返答のページを書き換えて同じ発言に答え直す再生成と、返答のページを消して会話から外す取り消し |
| [定期実行での Web 検索](changes/cron-web-search/design.md) | 中 | in-progress | 定期実行のジョブごとに Web 検索を使うかを選べるようにし、使うジョブは通常の返答と同じ回数の上限で検索して答える |
| [カスタム絵文字・スタンプ・GIF への対応](changes/discord-expressions/design.md) | 中 | planned | カスタム絵文字、スタンプ、GIF の埋め込みをモデルが読めるようにし、返信でサーバーのカスタム絵文字を使えるようにする |
| [Discord の情報を読む tool とイベントの作成](changes/discord-info-tools/design.md) | 中 | planned | ピン留め一覧、チャンネル情報、サーバーのイベント一覧をモデルが読める tool と、イベントを作る tool |
| [終了時の進行中返信の後始末](changes/graceful-shutdown/design.md) | 中 | investigating | bot の終了時に、生成途中の返信を停止表示へ書き換えてから落とす |
| [画像生成](changes/image-generation/design.md) | 中 | investigating | OpenRouter で画像を生成し、生成画像と生成ファイルを Discord の MediaGallery / File で表示する |
| [数式を画像で表示する](changes/math-rendering/design.md) | 中 | investigating | 返答の別行立ての数式を PNG にして本文の該当位置に差し込み、文中の数式はコードの表記にする |
| [メッセージの解説（コンテキストメニュー）](changes/message-explain/design.md) | 中 | planned | メッセージの右クリックメニュー「アプリ → 解説する」で、そのメッセージの専門用語や背景を本人にだけ見える返信で解説する |
| [投票の内容と結果をモデルに渡す](changes/poll-results/design.md) | 中 | in-progress | 会話の窓に入った投票を、質問、選択肢、票数、確定したかどうかのテキストにしてモデルへ渡し、締め切りの通知も窓に入れる |
| [自動応答で返答するかを判断する](changes/reply-gate/design.md) | 中 | planned | 自動応答チャンネルの発言ごとに、判定専用のモデルで返答すべきかを先に判定し、口を挟む場面でなければ何も送らない |
| [設定階層化 + LLMパラメータ + カスタムプロンプト](changes/settings-hierarchy/design.md) | 中 | investigating | guild/channel/user 設定階層 + LLM パラメータ + カスタムプロンプト |
| [会話の分岐 (fork)](changes/fork/design.md) | 低 | investigating | 指定した発言からスレッドを作り、そのスレッドの会話が親チャンネルの発言以前まで遡って読めるようにする |
| [ストリーミング中の分割表示の改善](changes/streaming-split-ux/design.md) | 低 | investigating | 複数メッセージに分かれる返信で、数文字だけのメッセージが現れたり文章が移動して見えたりする表示を直す |
| [使用統計](changes/usage-stats/design.md) | 低 | planned | サーバー/ユーザー/モデル別の使用量とコストを記録し /stats で表示する |
<!-- AUTO:PROGRESS:END -->

---

## 完了済み

変更履歴の詳細は [CHANGELOG.md](../CHANGELOG.md) を参照。
