import { isFinished, type Reply, snapshotKey } from "./scenarios";

export class DeadlineError extends Error {}

/**
 * Consecutive unchanged polls required once a reply shows a terminal state
 * (see `isFinished`), so that the last edits of a final render have landed
 * before the reply is read.
 */
export const SETTLED_POLLS = 2;

export interface WaitDeps {
  /** Reads the current reply. May throw `DeadlineError`, or anything else for a failed read. */
  read: () => Promise<Reply>;
  /** Sleeps one poll interval. Throws `DeadlineError` once the scenario deadline has passed. */
  pause: () => Promise<void>;
  log?: (line: string) => void;
}

export async function waitForReply(deps: WaitDeps): Promise<Reply> {
  let last: Reply = { messages: [], body: "", footers: [], isError: false };
  let lastKey = "";
  let unchanged = 0;
  try {
    while (true) {
      await deps.pause();
      try {
        last = await deps.read();
      } catch (error) {
        // A failed read says nothing about the reply: keep polling until the
        // deadline rather than moving on while the bot is still generating.
        if (error instanceof DeadlineError) throw error;
        deps.log?.(`  read failed, retrying: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      const key = snapshotKey(last);
      unchanged = key === lastKey ? unchanged + 1 : 0;
      lastKey = key;
      if (isFinished(last) && unchanged >= SETTLED_POLLS) return last;
    }
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error;
    throw new DeadlineError(
      last.messages.length === 0
        ? "the bot never replied"
        : "the reply never reached a final, stopped, or error state in time (is llm-details on for this guild?)",
    );
  }
}

export interface StoppableChild {
  kill: (signal?: NodeJS.Signals) => void;
  exited: Promise<unknown>;
}

/**
 * Returns a `stop` that every caller can await. It hands out one shared
 * promise rather than returning early on a second call: the interrupt
 * handler calls it while `finally` may already be stopping the child, and an
 * early return there let the process exit before the SIGKILL fallback ran.
 */
export function createStopper(
  child: StoppableChild,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async (): Promise<void> => {
      child.kill();
      const exited = await Promise.race([
        child.exited.then(() => true),
        sleep(graceMs).then(() => false),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await child.exited;
      }
    })();
    return stopping;
  };
}
