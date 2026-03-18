import { readFileSync, writeFileSync } from "node:fs";
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
  const readmePath = resolve(rootDir, "README.md");

  // Load command definitions
  const { commandDefinitions } = require(resolve(rootDir, "src/bot/commands/index.ts"));
  const commands = commandDefinitions.map(
    (cmd: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }) => cmd.toJSON(),
  );

  // Load env var definitions
  const { envVarDefinitions } = require(resolve(rootDir, "src/config/envVars.ts"));

  let readme = readFileSync(readmePath, "utf-8");

  // Replace COMMANDS section
  const commandTable = generateCommandTable(commands);
  readme = replaceMarkerSection(readme, "COMMANDS", commandTable);

  // Replace ENV_VARS section
  const envVarsTable = generateEnvVarsTable(envVarDefinitions);
  readme = replaceMarkerSection(readme, "ENV_VARS", envVarsTable);

  writeFileSync(readmePath, readme);
  console.log("README.md updated.");
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = import.meta.path === Bun.main;
if (isDirectExecution) {
  main();
}
