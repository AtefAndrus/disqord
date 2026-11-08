import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyRecord, IApiKeyRepository } from "../db/repositories/apiKey";
import { ApiKeyUnreadableError } from "../errors";
import { OpenRouterClient } from "../llm/openrouter";
import { buildAuthorizationUrl, exchangeCode, getKeyInfo, OAuthError } from "../llm/openrouterAuth";
import type { ResolvedApiKey } from "../types";
import { logger } from "../utils/logger";
import type { ICryptoService } from "./cryptoService";

export type ConnectionTarget =
  | { scope: "user"; userId: string }
  | { scope: "guild"; guildId: string };
export interface ConnectionHooks {
  authorize(): Promise<boolean>;
  report(result: "connected" | "failed"): Promise<void>;
}
export type CallbackOutcome = "connected" | "invalid" | "already_used" | "failed";
export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "unreadable" }
  | { status: "connected"; keyHash: string };
export interface IApiKeyService {
  readonly enabled: boolean;
  readonly connectionMode: "paste" | "callback";
  resolveForMention(userId: string, guildId: string): ResolvedApiKey | null;
  resolveForGuild(guildId: string): ResolvedApiKey | null;
  clientFor(resolved: ResolvedApiKey): OpenRouterClient;
  startConnection(actorId: string, target: ConnectionTarget, hooks: ConnectionHooks): string;
  hasPendingConnection(actorId: string, target: ConnectionTarget): boolean;
  completeConnection(actorId: string, target: ConnectionTarget, code: string): Promise<void>;
  completeCallback(state: string | null, code: string | null): Promise<CallbackOutcome>;
  disconnect(target: ConnectionTarget): { removed: boolean; keyHash: string | null };
  getConnection(target: ConnectionTarget): ConnectionStatus;
  removeGuild(guildId: string): void;
  removeGuildsNotIn(guildIds: readonly string[]): void;
}
interface PendingConnection {
  actorId: string;
  target: ConnectionTarget;
  verifier: string;
  state?: string;
  expiresAt: number;
  processing: boolean;
  hooks: ConnectionHooks;
}
function owner(target: ConnectionTarget): string {
  return target.scope === "user" ? target.userId : target.guildId;
}
function targetId(target: ConnectionTarget): string {
  return `${target.scope}:${owner(target)}`;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ApiKeyService implements IApiKeyService {
  readonly enabled: boolean;
  readonly connectionMode: "paste" | "callback";
  private readonly pending = new Map<string, PendingConnection>();
  private readonly usedStates = new Map<string, number>();
  constructor(
    private readonly repository: IApiKeyRepository,
    private readonly crypto: ICryptoService | null,
    private readonly defaultClient: OpenRouterClient,
    private readonly defaultKey: string,
    private readonly allowUnauthenticated: boolean,
    private readonly callbackUrl?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.enabled = crypto !== null;
    this.connectionMode = callbackUrl ? "callback" : "paste";
  }
  private decrypt(record: ApiKeyRecord): ResolvedApiKey {
    try {
      if (!this.crypto) throw new Error("Encryption disabled");
      return {
        key: this.crypto.decrypt(
          record.encryptedKey,
          record.iv,
          record.authTag,
          `${record.scope}:${record.ownerId}`,
        ),
        source: record.scope,
      };
    } catch {
      throw new ApiKeyUnreadableError(record.scope);
    }
  }
  resolveForMention(userId: string, guildId: string): ResolvedApiKey | null {
    const record = this.enabled ? this.repository.find(userId, "user") : null;
    return record ? this.decrypt(record) : this.resolveForGuild(guildId);
  }
  resolveForGuild(guildId: string): ResolvedApiKey | null {
    const record = this.enabled ? this.repository.find(guildId, "guild") : null;
    if (record) return this.decrypt(record);
    return !this.enabled || this.allowUnauthenticated
      ? { key: this.defaultKey, source: "default" }
      : null;
  }
  clientFor(resolved: ResolvedApiKey): OpenRouterClient {
    return resolved.source === "default"
      ? this.defaultClient
      : new OpenRouterClient(resolved.key, resolved.source);
  }
  private prune(): void {
    for (const [id, pending] of this.pending)
      if (pending.expiresAt <= this.now()) this.pending.delete(id);
    for (const [state, expiresAt] of this.usedStates)
      if (expiresAt <= this.now()) this.usedStates.delete(state);
  }
  startConnection(actorId: string, target: ConnectionTarget, hooks: ConnectionHooks): string {
    if (!this.enabled) throw new OAuthError();
    this.prune();
    const verifier = randomBytes(32).toString("base64url");
    const state = this.callbackUrl ? randomBytes(32).toString("base64url") : undefined;
    this.pending.set(targetId(target), {
      actorId,
      target,
      verifier,
      state,
      expiresAt: this.now() + 15 * 60_000,
      processing: false,
      hooks,
    });
    return buildAuthorizationUrl(
      createHash("sha256").update(verifier).digest("base64url"),
      this.callbackUrl,
      state,
    );
  }
  hasPendingConnection(actorId: string, target: ConnectionTarget): boolean {
    this.prune();
    const pending = this.pending.get(targetId(target));
    return pending?.actorId === actorId && !pending.processing;
  }
  async completeConnection(actorId: string, target: ConnectionTarget, code: string): Promise<void> {
    this.prune();
    const pending = this.pending.get(targetId(target));
    if (
      !pending ||
      pending.actorId !== actorId ||
      pending.processing ||
      this.connectionMode !== "paste" ||
      !code.trim()
    )
      throw new OAuthError();
    pending.processing = true;
    await this.complete(pending, code);
  }
  private async complete(pending: PendingConnection, code: string): Promise<void> {
    const id = targetId(pending.target);
    try {
      const key = await exchangeCode(code, pending.verifier);
      await getKeyInfo(key);
      if (this.pending.get(id) !== pending || pending.expiresAt <= this.now() || !this.crypto)
        throw new OAuthError();
      const encrypted = this.crypto.encrypt(key, id);
      this.repository.upsert({
        ownerId: owner(pending.target),
        scope: pending.target.scope,
        encryptedKey: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      });
    } catch {
      throw new OAuthError();
    } finally {
      if (this.pending.get(id) === pending) this.pending.delete(id);
    }
  }
  async completeCallback(state: string | null, code: string | null): Promise<CallbackOutcome> {
    this.prune();
    if (!state || !code || this.connectionMode !== "callback") return "invalid";
    if (this.usedStates.has(state)) return "already_used";
    const pending = [...this.pending.values()].find((item) => item.state === state);
    if (!pending) return "invalid";
    if (pending.processing) return "already_used";
    pending.processing = true;
    this.usedStates.set(state, pending.expiresAt);
    let outcome: "connected" | "failed" = "failed";
    try {
      if (pending.target.scope === "guild") {
        const authorized = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(() => reject(new OAuthError()), 5_000);
          Promise.resolve()
            .then(() => pending.hooks.authorize())
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        });
        if (!authorized) throw new OAuthError();
      }
      if (this.pending.get(targetId(pending.target)) !== pending) throw new OAuthError();
      await this.complete(pending, code);
      outcome = "connected";
    } catch {
      if (this.pending.get(targetId(pending.target)) === pending)
        this.pending.delete(targetId(pending.target));
    }
    void Promise.resolve()
      .then(() => pending.hooks.report(outcome))
      .catch(() => logger.warn("OAuth connection report failed"));
    return outcome;
  }
  disconnect(target: ConnectionTarget): { removed: boolean; keyHash: string | null } {
    this.pending.delete(targetId(target));
    const status = this.getConnection(target);
    return {
      removed: this.repository.delete(owner(target), target.scope),
      keyHash: status.status === "connected" ? status.keyHash : null,
    };
  }
  getConnection(target: ConnectionTarget): ConnectionStatus {
    const record = this.repository.find(owner(target), target.scope);
    if (!record) return { status: "disconnected" };
    try {
      return { status: "connected", keyHash: hash(this.decrypt(record).key) };
    } catch {
      return { status: "unreadable" };
    }
  }
  removeGuild(guildId: string): void {
    this.disconnect({ scope: "guild", guildId });
  }
  removeGuildsNotIn(guildIds: readonly string[]): void {
    for (const [id, pending] of this.pending)
      if (pending.target.scope === "guild" && !guildIds.includes(pending.target.guildId))
        this.pending.delete(id);
    this.repository.deleteGuildsNotIn(guildIds);
  }
}
