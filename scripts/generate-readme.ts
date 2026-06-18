import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  APIApplicationCommandOption,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { ApplicationCommandOptionType } from "discord.js";
import type { EnvVarDefinition } from "../src/config/envVars";

// --- Pure functions (testable) ---

interface CommandRow {
  command: string;
  description: string;
}

function flattenCommand(cmd: RESTPostAPIChatInputApplicationCommandsJSONBody): CommandRow[] {
  const rows: CommandRow[] = [];
  const options = (cmd.options ?? []) as APIApplicationCommandOption[];

  const hasSubcommands = options.some(
    (opt) =>
      opt.type === ApplicationCommandOptionType.Subcommand ||
      opt.type === ApplicationCommandOptionType.SubcommandGroup,
  );

  if (!hasSubcommands) {
    rows.push({ command: `/${cmd.name}`, description: cmd.description });
    return rows;
  }

  for (const opt of options) {
    if (opt.type === ApplicationCommandOptionType.Subcommand) {
      const optionHints = formatOptionHints(opt.options);
      rows.push({
        command: `/${cmd.name} ${opt.name}${optionHints}`,
        description: opt.description,
      });
    } else if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
      const groupOptions = (opt.options ?? []) as APIApplicationCommandOption[];
      for (const sub of groupOptions) {
        if (sub.type === ApplicationCommandOptionType.Subcommand) {
          const optionHints = formatOptionHints(sub.options);
          rows.push({
            command: `/${cmd.name} ${opt.name} ${sub.name}${optionHints}`,
            description: sub.description,
          });
        }
      }
    }
  }

  return rows;
}

function formatOptionHints(options?: APIApplicationCommandOption[]): string {
  if (!options) return "";
  const params = options.filter(
    (o) =>
      o.type !== ApplicationCommandOptionType.Subcommand &&
      o.type !== ApplicationCommandOptionType.SubcommandGroup,
  );
  if (params.length === 0) return "";
  return ` ${params.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ")}`;
}

export function generateCommandTable(
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
): string {
  const rows = commands.flatMap(flattenCommand);
  const lines = [
    "| コマンド | 説明 |",
    "| -------- | ---- |",
    ...rows.map((r) => `| \`${r.command}\` | ${r.description} |`),
  ];
  return lines.join("\n");
}

export function generateEnvVarsTable(vars: EnvVarDefinition[]): string {
  const lines = [
    "| 変数名 | 必須 | 説明 |",
    "| ------ | ---- | ---- |",
    ...vars.map((v) => {
      const required = v.required ? "Yes" : "No";
      const desc = v.default ? `${v.description}（デフォルト: \`${v.default}\`）` : v.description;
      return `| ${v.name} | ${required} | ${desc} |`;
    }),
  ];
  return lines.join("\n");
}

export function generateEnvExample(vars: EnvVarDefinition[]): string {
  return `${vars.map((v) => `${v.name}=${v.default ?? ""}`).join("\n")}\n`;
}

export function generateDefaultModelLine(vars: EnvVarDefinition[]): string {
  const def = vars.find((v) => v.name === "DEFAULT_MODEL")?.default;
  if (!def) {
    throw new Error("DEFAULT_MODEL definition with default value missing in envVarDefinitions");
  }
  return `- Default model: \`${def}\``;
}

// --- Frontmatter / Progress types and functions ---

export type DesignStatus = "planned" | "in-progress" | "implemented";
export type DesignPriority = "high" | "medium" | "low";

export interface DesignFrontmatter {
  title: string;
  status: DesignStatus;
  priority: DesignPriority;
  summary?: string;
}

export interface ProgressEntry {
  folder: string;
  frontmatter: DesignFrontmatter;
}

const VALID_STATUSES: ReadonlySet<string> = new Set(["planned", "in-progress", "implemented"]);
const VALID_PRIORITIES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const KNOWN_KEYS: ReadonlySet<string> = new Set(["title", "status", "priority", "summary"]);

const PRIORITY_WEIGHT: Record<DesignPriority, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL: Record<DesignPriority, string> = { high: "高", medium: "中", low: "低" };

function stripInlineComment(value: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "#") {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(content: string): DesignFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("Frontmatter not found (missing or unclosed --- delimiters)");
  }

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`Unknown frontmatter key: "${key}"`);
    }
    if (key in fields) {
      throw new Error(`Duplicate frontmatter key: "${key}"`);
    }

    let value = trimmed.slice(colonIdx + 1).trim();
    value = stripInlineComment(value);
    value = stripQuotes(value);
    fields[key] = value;
  }

  const missing = ["title", "status", "priority"].filter((k) => !(k in fields) || !fields[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required frontmatter field(s): ${missing.join(", ")}`);
  }

  if (!VALID_STATUSES.has(fields.status)) {
    throw new Error(
      `Invalid status: "${fields.status}" (expected: ${[...VALID_STATUSES].join(", ")})`,
    );
  }
  if (!VALID_PRIORITIES.has(fields.priority)) {
    throw new Error(
      `Invalid priority: "${fields.priority}" (expected: ${[...VALID_PRIORITIES].join(", ")})`,
    );
  }

  return {
    title: fields.title,
    status: fields.status as DesignStatus,
    priority: fields.priority as DesignPriority,
    summary: fields.summary || undefined,
  };
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/]/g, "\\]");
}

export function generateProgressTable(entries: ProgressEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const pw = PRIORITY_WEIGHT[a.frontmatter.priority] - PRIORITY_WEIGHT[b.frontmatter.priority];
    if (pw !== 0) return pw;
    return a.folder.localeCompare(b.folder);
  });

  const lines = [
    "| 機能 | 優先度 | ステータス | 概要 |",
    "| ---- | ------ | ---------- | ---- |",
    ...sorted.map((e) => {
      const title = escapeMarkdown(e.frontmatter.title);
      const link = `[${title}](changes/${e.folder}/design.md)`;
      const priority = PRIORITY_LABEL[e.frontmatter.priority];
      const summary = e.frontmatter.summary ? escapeMarkdown(e.frontmatter.summary) : "";
      return `| ${link} | ${priority} | ${e.frontmatter.status} | ${summary} |`;
    }),
  ];
  return lines.join("\n");
}

export function scanDesignDocs(changesDir: string): ProgressEntry[] {
  const entries: ProgressEntry[] = [];

  for (const name of readdirSync(changesDir).sort()) {
    const dirPath = resolve(changesDir, name);
    if (!statSync(dirPath).isDirectory()) continue;
    if (name === "TEMPLATE.md") continue;

    const designPath = resolve(dirPath, "design.md");
    if (!existsSync(designPath)) {
      throw new Error(`Missing design.md in change folder: ${name}`);
    }

    const content = readFileSync(designPath, "utf-8");
    try {
      const frontmatter = parseFrontmatter(content);
      entries.push({ folder: name, frontmatter });
    } catch (e) {
      throw new Error(`${name}/design.md: ${(e as Error).message}`);
    }
  }

  return entries;
}

// --- Marker replacement ---

export function replaceMarkerSection(
  content: string,
  section: string,
  replacement: string,
): string {
  const startMarker = `<!-- AUTO:${section}:START -->`;
  const endMarker = `<!-- AUTO:${section}:END -->`;
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Marker not found: ${section}`);
  }

  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);

  return `${before}\n${replacement}\n${after}`;
}

// --- Main ---

function main(): void {
  const rootDir = resolve(import.meta.dir, "..");

  // --- Phase 1: Read and validate all sources ---

  const { commandDefinitions } = require(resolve(rootDir, "src/bot/commands/index.ts"));
  const commands = commandDefinitions.map(
    (cmd: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }) => cmd.toJSON(),
  );
  const { envVarDefinitions } = require(resolve(rootDir, "src/config/envVars.ts"));

  const readmePath = resolve(rootDir, "README.md");
  let readme = readFileSync(readmePath, "utf-8");
  readme = replaceMarkerSection(readme, "COMMANDS", generateCommandTable(commands));
  readme = replaceMarkerSection(readme, "ENV_VARS", generateEnvVarsTable(envVarDefinitions));

  const claudeMdPath = resolve(rootDir, "CLAUDE.md");
  let claudeMd = readFileSync(claudeMdPath, "utf-8");
  claudeMd = replaceMarkerSection(
    claudeMd,
    "DEFAULT_MODEL",
    generateDefaultModelLine(envVarDefinitions),
  );

  const envExampleContent = generateEnvExample(envVarDefinitions);

  const changesDir = resolve(rootDir, "docs/changes");
  const progressEntries = scanDesignDocs(changesDir);
  const progressPath = resolve(rootDir, "docs/progress.md");
  let progress = readFileSync(progressPath, "utf-8");
  progress = replaceMarkerSection(progress, "PROGRESS", generateProgressTable(progressEntries));

  // --- Phase 2: Write all files (only after all validation passed) ---

  writeFileSync(readmePath, readme);
  writeFileSync(claudeMdPath, claudeMd);
  writeFileSync(resolve(rootDir, ".env.example"), envExampleContent);
  writeFileSync(progressPath, progress);

  console.log("README.md, CLAUDE.md, .env.example, docs/progress.md updated.");
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = import.meta.path === Bun.main;
if (isDirectExecution) {
  main();
}
