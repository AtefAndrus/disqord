import type { Database } from "bun:sqlite";
import type { ApiKeyScope } from "../../types";

export interface ApiKeyRecord {
  ownerId: string;
  scope: ApiKeyScope;
  encryptedKey: string;
  iv: string;
  authTag: string;
  connectedAt?: string;
  updatedAt?: string;
}
export interface IApiKeyRepository {
  find(ownerId: string, scope: ApiKeyScope): ApiKeyRecord | null;
  upsert(record: ApiKeyRecord): void;
  delete(ownerId: string, scope: ApiKeyScope): boolean;
  deleteGuildsNotIn(guildIds: readonly string[]): number;
}
export class ApiKeyRepository implements IApiKeyRepository {
  constructor(private readonly db: Database) {}
  find(ownerId: string, scope: ApiKeyScope): ApiKeyRecord | null {
    return this.db
      .query<ApiKeyRecord, [string, ApiKeyScope]>(
        `SELECT owner_id AS ownerId, scope, encrypted_key AS encryptedKey, iv, auth_tag AS authTag, connected_at AS connectedAt, updated_at AS updatedAt FROM api_keys WHERE owner_id = ? AND scope = ?`,
      )
      .get(ownerId, scope);
  }
  upsert(record: ApiKeyRecord): void {
    this.db
      .query(
        `INSERT INTO api_keys (owner_id, scope, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, scope) DO UPDATE SET encrypted_key = excluded.encrypted_key, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = datetime('now')`,
      )
      .run(record.ownerId, record.scope, record.encryptedKey, record.iv, record.authTag);
  }
  delete(ownerId: string, scope: ApiKeyScope): boolean {
    return (
      this.db.query("DELETE FROM api_keys WHERE owner_id = ? AND scope = ?").run(ownerId, scope)
        .changes > 0
    );
  }
  deleteGuildsNotIn(guildIds: readonly string[]): number {
    return this.db
      .query(
        `DELETE FROM api_keys WHERE scope = 'guild'${guildIds.length ? ` AND owner_id NOT IN (${guildIds.map(() => "?").join(",")})` : ""}`,
      )
      .run(...guildIds).changes;
  }
}
