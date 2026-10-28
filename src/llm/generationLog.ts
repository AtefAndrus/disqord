import { OPENROUTER_BASE_URL } from "./openrouter";

export type GenerationLookup =
  | { ok: true; data: unknown }
  | { ok: false; status?: number; reason: string };

export interface IGenerationLogClient {
  getGeneration(id: string, signal?: AbortSignal): Promise<GenerationLookup>;
  getGenerationContent(id: string, signal?: AbortSignal): Promise<GenerationLookup>;
}

export class OpenRouterGenerationLogClient implements IGenerationLogClient {
  constructor(private readonly apiKey: string) {}

  getGeneration(id: string, signal?: AbortSignal): Promise<GenerationLookup> {
    return this.lookup("/generation", id, signal);
  }

  getGenerationContent(id: string, signal?: AbortSignal): Promise<GenerationLookup> {
    return this.lookup("/generation/content", id, signal);
  }

  private async lookup(
    endpoint: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<GenerationLookup> {
    let status: number | undefined;
    try {
      const response = await fetch(
        `${OPENROUTER_BASE_URL}${endpoint}?id=${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal,
        },
      );
      status = response.status;
      if (!response.ok) {
        const reason = await response.text();
        return { ok: false, status, reason: reason || response.statusText || `HTTP ${status}` };
      }
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("data" in body)) {
        return { ok: false, status, reason: "応答に data がありません" };
      }
      return { ok: true, data: body.data };
    } catch (error) {
      return {
        ok: false,
        status,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
