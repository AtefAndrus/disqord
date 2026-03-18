import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  APIApplicationCommandOption,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { ApplicationCommandOptionType } from "discord.js";

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

export function generateRequirements(engines: Record<string, string>): string {
  const items: string[] = [];
  if (engines.bun) {
    items.push(`- [Bun](https://bun.sh/) ${engines.bun}`);
  }
  if (engines.node) {
    items.push(`- [Node.js](https://nodejs.org/) ${engines.node}`);
  }
  items.push("- Discord Bot Token");
  items.push("- OpenRouter API Key");
  return items.join("\n");
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

  // Load package.json
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf-8"));

  // Load command definitions (dynamic import would require async, use require-like approach)
  // Instead, we import statically and call toJSON()
  const { commandDefinitions } = require(resolve(rootDir, "src/bot/commands/index.ts"));
  const commands = commandDefinitions.map(
    (cmd: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }) => cmd.toJSON(),
  );

  let readme = readFileSync(readmePath, "utf-8");

  // Replace COMMANDS section
  const commandTable = generateCommandTable(commands);
  readme = replaceMarkerSection(readme, "COMMANDS", commandTable);

  // Replace REQUIREMENTS section
  const requirements = generateRequirements(pkg.engines ?? {});
  readme = replaceMarkerSection(readme, "REQUIREMENTS", requirements);

  writeFileSync(readmePath, readme);
  console.log("README.md updated.");
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = import.meta.path === Bun.main;
if (isDirectExecution) {
  main();
}
