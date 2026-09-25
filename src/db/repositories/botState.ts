import type { Database } from "bun:sqlite";

const RELEASE_VERSION_KEY = "last_processed_release_version";

export class BotStateRepository {
  constructor(private readonly db: Database) {}

  claimRelease<T>(
    version: string,
    select: (stored: string | null) => T | undefined,
  ): T | undefined {
    return this.db
      .transaction((): T | undefined => {
        const stored = this.db
          .query<{ value: string }, [string]>("SELECT value FROM bot_state WHERE key = ?")
          .get(RELEASE_VERSION_KEY);
        const selected = select(stored?.value ?? null);
        if (selected !== undefined) {
          this.db
            .query(
              "INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(RELEASE_VERSION_KEY, version);
        }
        return selected;
      })
      .immediate();
  }
}
