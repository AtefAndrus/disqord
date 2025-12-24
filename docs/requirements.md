# DisQord 要件定義書

## 概要

DisQordは、Discord上でLLMと会話できるBotである。メンションで呼び出して対話する。

- **Bot名**: DisQord
- **LLMプロバイダ**: [OpenRouter](https://openrouter.ai/)

---

## 機能要件

### v1.0

#### 呼び出し方法

| 方式 | 対応状況 | 備考 |
| ---- | -------- | ---- |
| メンション | 対応 | `@DisQord 質問` で呼び出し |
| スラッシュコマンド | 対応 | 設定・ヘルプ用途のみ |
| DM | 非対応 | Guild内のみで動作 |
| リプライ継続 | 非対応 | v2以降で検討 |

#### 会話コンテキスト

- **方式**: 単発応答（毎回リセット）
- 過去の会話履歴は保持しない

#### モデル選択

- Guild単位でデフォルトモデルを設定可能
- スラッシュコマンドで変更

#### 権限・アクセス制御

| 対象 | 権限 |
| ---- | ---- |
| Bot利用 | 全員可能 |
| 設定変更 | 全員可能 |

#### レート制限

- Bot側での独自制限は設けない
- OpenRouter側のレート制限に従う
- 429エラー受信時は `X-RateLimit-Reset` ヘッダーを参照し、リセット時刻までリクエストを抑制

#### 応答形式

| 項目 | 仕様 |
| ---- | ---- |
| 送信方式 | 一括送信 |
| 長文対応 | 2000文字を超える場合は複数メッセージに分割 |

#### エラーハンドリング

- 詳細エラーメッセージを表示
- エラー種別を区別して通知（レート制限、モデルエラー、接続エラー等）

#### スラッシュコマンド一覧

| コマンド | 説明 |
| -------- | ---- |
| `/disqord help` | 使い方を表示 |
| `/disqord status` | Botのステータス（OpenRouter残高等）を表示 |
| `/disqord model current` | 現在設定されているモデルを表示 |
| `/disqord model set <model>` | Guildのデフォルトモデルを変更 |
| `/disqord model list` | OpenRouterのモデル一覧ページへ誘導 |

---

### v1.0.1

#### 運用改善

| 機能 | 説明 |
| ---- | ---- |
| Health Check | HTTPヘルスエンドポイント（`/health`）を公開。Discordクライアント接続状態を確認可能 |

#### UX改善

| 機能 | 説明 |
| ---- | ---- |
| Typing Indicator継続 | LLM応答待機中、8秒間隔で`sendTyping()`を呼び出し、「入力中...」表示を維持 |
| URL埋め込み抑制 | `/disqord model list`でOpenRouter URLのプレビューを非表示（`<URL>`形式） |

---

### v1.1.0（計画）

#### 無料モデル限定機能

| 機能 | 説明 |
| ---- | ---- |
| 無料モデル判定 | OpenRouter APIの`pricing`フィールドで判定 |
| Guild単位設定 | `freeModelsOnly`フラグでGuild内を無料モデルのみに制限 |
| モデル一覧キャッシュ | 無料モデル一覧をキャッシュ（TTL: 5-10分） |

#### ユーザ向けエラー表示

エラー種別に応じた分かりやすいメッセージをユーザーに表示する。

| エラー種別 | HTTPステータス | ユーザー向けメッセージ |
| ---------- | -------------- | ---------------------- |
| レート制限 | 429 | リクエスト制限に達しました。{N}秒後に再度お試しください。 |
| クレジット不足 | 402 | API残高が不足しています。管理者にお問い合わせください。 |
| コンテンツモデレーション | 403 | 入力内容が制限されました。表現を変えてお試しください。 |
| 無効なモデル | 400* | 指定されたモデルは存在しません。`/disqord model set`で有効なモデルを設定してください。 |
| モデル利用不可 | 500/502/503 | モデルが一時的に利用できません。しばらくしてから再度お試しください。 |
| 認証エラー | 401 | Botの設定に問題があります。管理者にお問い合わせください。 |
| タイムアウト | 408 | 応答に時間がかかりすぎています。短いメッセージでお試しください。 |
| 不正リクエスト | 400 | リクエストに問題があります。入力内容を確認してください。 |
| 不明エラー | その他 | 予期しないエラーが発生しました。問題が続く場合は管理者にお問い合わせください。 |

\* 400エラーでメッセージに `is not a valid model ID` を含む場合

#### リリースノート配信

GitHub Releaseの公開をトリガーに、登録済みの全Guildへリリースノートを配信する。

| 機能 | 説明 |
| ---- | ---- |
| 通知方式 | GitHub Webhook → Bot HTTPエンドポイント（Cloudflare Tunnel経由） |
| 配信対象 | `release_channel_id`が設定されている全Guild |
| 配信形式 | Embed形式（タイトル、バージョン、リリースノート本文、GitHubリンク） |
| イベント | `release`イベントの`published`アクションのみ |
| 署名検証 | `X-Hub-Signature-256`ヘッダーでHMAC-SHA256検証 |

#### 追加コマンド

| コマンド | 説明 |
| -------- | ---- |
| `/disqord config free-only <on\|off>` | Guildの無料モデル限定設定を切り替え |
| `/disqord config release-channel <channel>` | リリースノート配信先チャンネルを設定 |
| `/disqord config release-channel off` | リリースノート配信を無効化 |

---

### v2以降（将来計画）

#### 会話・コンテキスト関連

- リプライ継続: Botへのリプライで会話を継続
- コンテキスト保持: スレッド内全メッセージ / チャンネル内直近n件
- OpenProvence連携: リランカーで関連メッセージのみをコンテキストに含める

#### 設定関連

- 階層別モデル設定: Guild / Channel / User 単位
- カスタムプロンプト: Guild / Channel / User 単位で設定可能
- チャンネル制限: 特定チャンネルのみでBotを有効化
- 管理権限ロール指定: 設定変更権限を特定ロールに限定
- エラー出力詳細度設定: 簡易/詳細モードの切り替え（metadata表示等）

#### LLM機能拡張

- Web Search: OpenRouter `:online` サフィックス（追加費用あり）
- 複数モデル並列回答: Body Builder連携

#### UI改善

- Select Menu/Modalでモデル選択
- Embed化（ステータス、エラー表示）

---

## 非機能要件

### 技術スタック

| 項目 | 選定 | 備考 |
| ---- | ---- | ---- |
| 言語 | TypeScript | 型安全性を重視 |
| ランタイム | Bun | 高速なTypeScriptランタイム |
| Discordライブラリ | discord.js v14 | Node.js向け公式推奨ライブラリ |
| データ永続化 | SQLite | 軽量、ファイルベース |
| Lint/Format | Biome | 高速、設定シンプル |

### ホスティング

| 項目 | 内容 |
| ---- | ---- |
| プラットフォーム | Coolify（自宅サーバー） |
| ビルド方式 | Dockerfile |
| 自動デプロイ | GitHub Release → GitHub Actions → Coolify Webhook |

### 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
| ------ | ---- | ---------- | ---- |
| DISCORD_TOKEN | Yes | - | Discord Bot Token |
| DISCORD_APPLICATION_ID | Yes | - | Discord Application ID |
| OPENROUTER_API_KEY | Yes | - | OpenRouter API Key |
| DATABASE_PATH | No | data/disqord.db | SQLiteファイルパス |
| NODE_ENV | No | development | 実行環境 |
| DEFAULT_MODEL | No | deepseek/deepseek-r1-0528:free | デフォルトLLMモデル |
| HEALTH_PORT | No | 3000 | ヘルスチェック用HTTPポート |

#### v1.1.0 追加予定

| 変数名 | 必須 | 説明 |
| ------ | ---- | ---- |
| GITHUB_WEBHOOK_SECRET | Yes* | GitHub Webhook署名検証用（*リリースノート配信使用時） |

### セキュリティ

- API Key/TokenはCoolifyの環境変数で管理
- Dockerコンテナはnon-rootユーザー（`bun`）で実行
- `.env`ファイルは`.gitignore`に追加

### 監視

| 項目 | 内容 |
| ---- | ---- |
| 死活監視 | Coolifyのヘルスチェック |
| ヘルスエンドポイント | `GET /health` (200 OK / 503 Service Unavailable) |
| ログ出力 | コンソール（stdout）、Coolifyダッシュボードで確認 |

### 外部公開（v1.1.0）

リリースノート配信機能でGitHub Webhookを受信するため、Cloudflare TunnelでBotのHTTPエンドポイントを外部公開する。

| 項目 | 内容 |
| ---- | ---- |
| 方式 | Cloudflare Tunnel |
| 公開エンドポイント | `/webhook/github`（POST） |
| 認証 | GitHub Webhook署名検証 |

---

## 参考情報

### OpenProvence

コンテキスト保持の将来実装で使用予定のリランカー。

- リポジトリ: <https://github.com/hotchpotch/open_provence>
- モデル: <https://huggingface.co/hotchpotch/open-provence-reranker-v1>

### Discord APIレート制限

メッセージ編集のレート制限（ストリーミング風表示を将来検討する場合の参考）:

- グローバル: 50リクエスト/10秒
- サーバーごと: 5リクエスト/5秒

---

## 更新履歴

| 日付 | 内容 |
| ---- | ---- |
| 2025-12-23 | functional-requirements.md と non-functional-requirements.md を統合 |
