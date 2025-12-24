# リリースノート配信 インフラ設定

リリースノート配信機能を有効化するためのインフラ設定手順。

---

## 概要

```text
GitHub Repository
    │
    │ release event (released)
    ▼
GitHub Webhook ──────────────────┐
    │                            │
    │ POST /webhook/github       │
    ▼                            │
Cloudflare Tunnel                │ X-Hub-Signature-256
    │                            │
    │ localhost:3000             │
    ▼                            │
DisQord Bot ◄────────────────────┘
    │
    │ send message
    ▼
Discord Channels (release_channel_id)
```

---

## 1. 環境変数設定

`.env` に以下を追加:

```bash
GITHUB_WEBHOOK_SECRET=<ランダムな文字列>
```

シークレット生成例:

```bash
openssl rand -hex 32
```

---

## 2. DisQord のポートマッピング設定

Coolify上でDisQordのポートマッピングを設定する:

1. Coolifyダッシュボードで DisQord プロジェクトを開く
2. **Port Mappings** に `3000:3000` を設定（左: ホストポート、右: コンテナポート）
3. **Deploy** をクリック

---

## 3. Cloudflare Tunnel 作成

### 3.1 Cloudflare Zero Trust ダッシュボード

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) にアクセス
2. サイドバーの **Networks** → **Tunnels**
3. **Add a tunnel** をクリック
4. **Select Cloudflared** を選択
5. トンネル名を設定（例: `disqord-webhook`）

### 3.2 トークンの取得

インストールコマンドが表示される。トークン部分（`eyJ` で始まる文字列）のみをコピーして保存する。

```text
例: eyJhIjoiMTIzNDU2Nzg5MGFiY2RlZiIsInQiOiIuLi4iLCJzIjoiLi4uIn0=
```

**Next** をクリック。

### 3.3 Public Hostname 設定

| 項目 | 値 |
|------|-----|
| Subdomain | `webhook`（任意） |
| Domain | Cloudflareで管理しているドメイン |
| Path | 空欄 |
| Type | **HTTP**（重要） |
| URL | `localhost:3000` |

**Save Tunnel** をクリック。

結果: `https://webhook.example.com` → DisQord Bot の `/webhook/github`

---

## 4. Coolify で Cloudflared をデプロイ

1. Coolifyダッシュボードで DisQord と同じプロジェクトを開く
2. **+ New** をクリック
3. 検索ボックスで `Cloudflared` を検索し、選択
4. **Environment Variables** ページで `TUNNEL_TOKEN` にトークンを設定
5. **Deploy** をクリック

Cloudflaredコンテナが起動し、Cloudflare Tunnelに接続される。

---

## 5. GitHub Webhook 設定

### 5.1 リポジトリ設定

1. [AtefAndrus/disqord](https://github.com/AtefAndrus/disqord) → **Settings** → **Webhooks**
2. **Add webhook**

### 5.2 Webhook 設定値

| 項目 | 値 |
|------|-----|
| Payload URL | `https://webhook.example.com/webhook/github` |
| Content type | `application/json` |
| Secret | 環境変数 `GITHUB_WEBHOOK_SECRET` と同じ値 |
| SSL verification | Enable SSL verification |
| Events | **Let me select individual events** → **Releases** のみ |
| Active | チェック |

3. **Add webhook**

---

## 6. 動作確認

### 6.1 ローカルテスト（開発時）

インフラ設定前にWebhookハンドラをローカルでテストする:

```bash
# シークレット取得
SECRET=$(grep "^GITHUB_WEBHOOK_SECRET=" .env | cut -d= -f2)

# テストペイロード
PAYLOAD='{"action":"released","release":{"id":1,"tag_name":"v1.0.0-test","name":"Test","body":"Test release","html_url":"https://github.com/AtefAndrus/disqord/releases/tag/v1.0.0-test","prerelease":false,"draft":false,"created_at":"2025-01-01T00:00:00Z","published_at":"2025-01-01T00:00:00Z","author":{"login":"test","avatar_url":"https://example.com/a.png"}},"repository":{"id":1,"name":"disqord","full_name":"AtefAndrus/disqord","html_url":"https://github.com/AtefAndrus/disqord"},"sender":{"login":"test","avatar_url":"https://example.com/a.png"}}'

# 署名生成
SIGNATURE="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

# リクエスト送信
curl -X POST http://localhost:3000/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -H "X-GitHub-Event: release" \
  -d "$PAYLOAD"
```

成功時のレスポンス:

```json
{"success":1,"failed":0,"skipped":0,"errors":[]}
```

### 6.2 GitHub Webhook テスト送信

1. GitHub Webhook 設定画面 → **Recent Deliveries**
2. **Redeliver** で再送信可能

### 6.3 ログ確認

```bash
# Coolifyのログを確認
docker logs <container_id> | grep webhook
```

期待されるログ:

```log
[INFO] Processing GitHub release webhook {"action":"released","tag":"v1.0.0","repository":"AtefAndrus/disqord"}
[INFO] Release notification sent {"guildId":"...","channelId":"...","tag":"v1.0.0"}
```

### 6.4 Discord 通知確認

設定済みチャンネルにリリース通知が送信されることを確認。

---

## 7. トラブルシューティング

### Webhook が届かない

1. Cloudflare Tunnel のステータス確認
2. GitHub Webhook の Recent Deliveries でエラー確認
3. DisQord のログ確認

### 署名検証エラー

1. `GITHUB_WEBHOOK_SECRET` が GitHub と `.env` で一致しているか確認
2. 環境変数が正しく読み込まれているか確認

### 通知が送信されない

1. `/disqord config release-channel` でチャンネルが設定されているか確認
2. Bot にそのチャンネルへの送信権限があるか確認
3. `action` が `released` であることを確認（`published` は処理されない）

---

## 参考リンク

- [Coolify - Access Single Resource via Cloudflare Tunnels](https://coolify.io/docs/knowledge-base/cloudflare/tunnels/single-resource)
- [Cloudflare Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [GitHub Webhook Events - Release](https://docs.github.com/en/webhooks/webhook-events-and-payloads#release)
- [Validating Webhook Deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
