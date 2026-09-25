import { join } from "node:path";
import type { InteractionReplyOptions } from "discord.js";
import {
  buildSuccessNoticeContainer,
  measureTextBudget,
  splitTextIntoMessages,
  THEMATIC_BREAK_MARK,
  toNoticePayload,
  ZERO_TEXT_BUDGET,
} from "../utils/chatContainerBuilder";
import { logger } from "../utils/logger";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

export type ReleaseSection =
  | { version: Version; date: string; body: string; status: "ok" }
  | { version: Version; status: "duplicate" };

export interface ReleaseNotes {
  /** Newest first, each version once. */
  versions(): Version[];
  section(version: Version): ReleaseSection | undefined;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const SECTION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;
const ANY_SECTION_HEADING = /^## \[/;
const COMPARE_LINK = /^\[[^\]]+\]: https?:\/\//;
/**
 * cliff.toml's footer opens with HTML comments (one closes the last list,
 * one marks the file as generated) before the compare links; section bodies
 * never start a line with one.
 */
const FOOTER_COMMENT = /^<!--/;
const FENCE = /^\s*(```|~~~)/;

export const EMPTY_SECTION_TEXT = "変更点の記載はありません";

/**
 * Only plain `x.y.z` is a release here; a prerelease or build suffix is
 * rejected rather than ordered, so a later announcement never has to decide
 * where `1.2.3-rc.1` sits.
 */
export function parseVersion(input: string): Version | undefined {
  const match = VERSION_PATTERN.exec(input.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

interface RawSection {
  version: Version;
  date: string;
  lines: string[];
}

/**
 * A heading repeated for one version marks that version as duplicate instead
 * of keeping either copy, so a caller that must not skip a release (the
 * startup announcement) can refuse to act on it.
 */
export function parseChangelog(text: string): ReleaseNotes {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: RawSection[] = [];
  let current: RawSection | undefined;
  let inFence = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      current?.lines.push(line);
      continue;
    }
    if (inFence) {
      current?.lines.push(line);
      continue;
    }
    if (FOOTER_COMMENT.test(line) || COMPARE_LINK.test(line)) {
      current = undefined;
      continue;
    }
    if (ANY_SECTION_HEADING.test(line)) {
      const heading = SECTION_HEADING.exec(line);
      const version = heading ? parseVersion(heading[1] ?? "") : undefined;
      current = version && heading ? { version, date: heading[2] ?? "", lines: [] } : undefined;
      if (current) sections.push(current);
      continue;
    }
    current?.lines.push(line);
  }

  const byVersion = new Map<string, ReleaseSection>();
  for (const raw of sections) {
    const key = formatVersion(raw.version);
    byVersion.set(
      key,
      byVersion.has(key)
        ? { version: raw.version, status: "duplicate" }
        : { version: raw.version, date: raw.date, body: trimBlankLines(raw.lines), status: "ok" },
    );
  }
  const ordered = [...byVersion.values()]
    .map((section) => section.version)
    .sort((a, b) => compareVersions(b, a));

  return {
    versions: () => [...ordered],
    section: (version) => byVersion.get(formatVersion(version)),
  };
}

function trimBlankLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start++;
  while (end > start && lines[end - 1]?.trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

export function releaseNoteTitle(version: Version): string {
  return `DisQord v${formatVersion(version)} の変更点`;
}

/**
 * The first page carries the title; later pages are follow-ups. Every page
 * goes through `toNoticePayload`, which fixes `allowedMentions` to none,
 * because CHANGELOG lines are PR titles that may contain `@everyone`.
 */
export function buildReleaseNotePages(version: Version, body: string): InteractionReplyOptions[] {
  const title = releaseNoteTitle(version);
  const text = body === "" ? EMPTY_SECTION_TEXT : body;
  const chunks = splitTextIntoMessages(
    text,
    measureTextBudget(`## ${title}\n\n`),
    ZERO_TEXT_BUDGET,
  );
  return chunks.map((chunk, index) =>
    toNoticePayload(
      buildSuccessNoticeContainer(
        // The splitter marks `---` lines for the chat renderer's Separators;
        // a notice has none, so the line goes back to Markdown.
        chunk.replaceAll(THEMATIC_BREAK_MARK, "---"),
        index === 0 ? title : undefined,
      ),
    ),
  );
}

/** The repository root, where the Docker image also places CHANGELOG.md. */
const CHANGELOG_PATH = join(import.meta.dir, "..", "..", "CHANGELOG.md");

/**
 * A missing or unreadable CHANGELOG leaves `/release-note` answering that it
 * could not read the notes; it never stops the bot from starting.
 */
export async function loadReleaseNotes(path = CHANGELOG_PATH): Promise<ReleaseNotes | undefined> {
  try {
    return parseChangelog(await Bun.file(path).text());
  } catch (error) {
    logger.warn("CHANGELOG.md could not be read; /release-note will report it", { path, error });
    return undefined;
  }
}
