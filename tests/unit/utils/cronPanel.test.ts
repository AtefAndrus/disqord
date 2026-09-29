import { describe, expect, test } from "bun:test";
import { ComponentType } from "discord.js";
import type { CronJob } from "../../../src/db/repositories/cronRepository";
import {
  buildCronDetail,
  buildCronList,
  buildCronModal,
  type CronAction,
  cronCustomId,
  parseCronCustomId,
  scheduleInputOf,
} from "../../../src/utils/cronPanel";

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 7,
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    name: "朝の英単語",
    prompt: "英単語を 1 つ例文付きで紹介して。",
    kind: "cron",
    expr: "0 9 * * 1-5",
    silent: false,
    status: "active",
    nextRunAt: Date.parse("2026-09-30T00:00:00Z"),
    lastRunAt: null,
    failCount: 0,
    lastError: null,
    version: 3,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function customIds(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(customIds);
  if (typeof node !== "object" || node === null) return [];
  const record = node as Record<string, unknown>;
  return [
    ...(typeof record.custom_id === "string" ? [record.custom_id] : []),
    ...customIds(record.components),
    ...customIds(record.component),
    ...customIds(record.accessory),
  ];
}

function buttonLabels(payload: ReturnType<typeof buildCronDetail>): string[] {
  const json = payload.components[0]?.toJSON();
  const labels: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === ComponentType.Button && typeof record.label === "string")
      labels.push(record.label);
    walk(record.components);
  };
  walk(json);
  return labels;
}

describe("cron panel custom ids", () => {
  test.each<CronAction>([
    { action: "list", page: 2 },
    { action: "select", page: 0 },
    { action: "new" },
    { action: "view", jobId: 7, version: 3 },
    { action: "edit", jobId: 7, version: 3 },
    { action: "run", jobId: 7, version: 3 },
    { action: "pause", jobId: 7, version: 3 },
    { action: "resume", jobId: 7, version: 3 },
    { action: "delete", jobId: 7, version: 3 },
    { action: "confirm-delete", jobId: 7, version: 3 },
    { action: "modal-new" },
    { action: "modal-edit", jobId: 7, version: 3 },
    { action: "proposal", decision: "approve", proposalId: 9 },
    { action: "proposal", decision: "reject", proposalId: 9 },
  ])("round trips %j", (action) => {
    expect(parseCronCustomId(cronCustomId(action))).toEqual(action);
  });

  test("uses the documented shapes for modals and proposal buttons", () => {
    expect(cronCustomId({ action: "modal-new" })).toBe("cron:modal:new");
    expect(cronCustomId({ action: "modal-edit", jobId: 7, version: 3 })).toBe(
      "cron:modal:edit:7:3",
    );
    expect(cronCustomId({ action: "proposal", decision: "approve", proposalId: 9 })).toBe(
      "cron:proposal:approve:9",
    );
  });

  test.each([
    "cfg:open",
    "cron",
    "cron:unknown:1:1",
    "cron:pause:7",
    "cron:pause:7:3:1",
    "cron:pause:x:3",
    "cron:pause:07:3",
    "cron:pause:-1:3",
    "cron:list",
    "cron:list:a",
    "cron:new:1",
    "cron:modal:edit:7",
    "cron:modal:other",
    "cron:proposal:accept:9",
    "cron:proposal:approve:",
    `cron:pause:${"9".repeat(20)}:1`,
    `cron:list:${"1".repeat(100)}`,
  ])("rejects %s", (value) => {
    expect(parseCronCustomId(value)).toBeUndefined();
  });
});

describe("cron panel layout", () => {
  test("a done job offers only run now, delete, and back", () => {
    expect(buttonLabels(buildCronDetail(job({ status: "done", nextRunAt: null })))).toEqual([
      "今すぐ実行",
      "削除",
      "一覧へ戻る",
    ]);
  });

  test("active and paused jobs offer pause or resume, and delete asks to confirm", () => {
    expect(buttonLabels(buildCronDetail(job()))).toEqual([
      "編集",
      "今すぐ実行",
      "停止",
      "削除",
      "一覧へ戻る",
    ]);
    expect(buttonLabels(buildCronDetail(job({ status: "paused", nextRunAt: null })))).toEqual([
      "編集",
      "今すぐ実行",
      "再開",
      "削除",
      "一覧へ戻る",
    ]);
    const confirm = buildCronDetail(job(), { confirmDelete: true });
    expect(buttonLabels(confirm)).toContain("削除を確定");
    expect(customIds(confirm.components[0]?.toJSON())).toContain("cron:confirm-delete:7:3");
  });

  test("the list pages at 25 jobs and keeps its button ids distinct", () => {
    const jobs = Array.from({ length: 30 }, (_, index) => job({ id: index + 1 }));
    const first = customIds(buildCronList(jobs, 0).components[0]?.toJSON());
    expect(first).toEqual(["cron:select:0", "cron:new", "cron:list:0", "cron:list:1"]);
    const second = buildCronList(jobs, 5).components[0]?.toJSON();
    expect(customIds(second)).toContain("cron:select:1");
    expect(JSON.stringify(second)).toContain('"value":"30"');
    expect(JSON.stringify(second)).not.toContain('"value":"25"');
  });

  test("the modal holds five labelled fields and prefills an edit", () => {
    const modal = buildCronModal(job({ kind: "interval", expr: String(2 * 3_600_000) })).toJSON();
    expect(modal.custom_id).toBe("cron:modal:edit:7:3");
    expect(modal.components).toHaveLength(5);
    expect(modal.components.every((component) => component.type === ComponentType.Label)).toBe(
      true,
    );
    expect(customIds(modal.components)).toEqual([
      "name",
      "schedule",
      "prompt",
      "channel",
      "silent",
    ]);
    expect(JSON.stringify(modal)).toContain('"value":"2h"');
    const fresh = buildCronModal(undefined, "here").toJSON();
    expect(fresh.custom_id).toBe("cron:modal:new");
    expect(JSON.stringify(fresh)).toContain('"default_values":[{"id":"here","type":"channel"}]');
  });

  test("schedule inputs reproduce the stored interval", () => {
    expect(scheduleInputOf({ kind: "interval", expr: "1800000" })).toBe("30m");
    expect(scheduleInputOf({ kind: "interval", expr: "86400000" })).toBe("1d");
    expect(scheduleInputOf({ kind: "cron", expr: "0 9 * * *" })).toBe("0 9 * * *");
  });
});
