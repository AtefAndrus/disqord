import type { Attachment, Collection } from "discord.js";
import type { ChatMessageContent, ChatPlugin } from "../types";
import { logger } from "../utils/logger";

export type AttachmentRejectReason =
  | "UNSUPPORTED_MIME"
  | "MISSING_MIME"
  | "FETCH_FAILED"
  | "FILE_TOO_LARGE";

export interface AttachmentParseResult {
  parts: ChatMessageContent[];
  hasImage: boolean;
  hasPdf: boolean;
  rejected: Array<{ filename: string; reason: AttachmentRejectReason }>;
}

export const SUPPORTED_IMAGE_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const SUPPORTED_FILE_MIME: ReadonlySet<string> = new Set(["application/pdf"]);

export const PDF_PARSER_PLUGIN: ChatPlugin = {
  id: "file-parser",
  pdf: { engine: "cloudflare-ai" },
};

// PDF 1 ファイルあたりの上限。Discord の通常添付は最大 25MB だが、
// 安全側に 20MB で頭打ちにし、メモリ/payload を抑える。
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

// 1 メッセージあたりの PDF 合計サイズ上限。Discord は 1 メッセージに最大 10 attachments を
// 許可するため、最悪 10 × MAX_PDF_BYTES = 200MB を base64 化 (約 267MB) で抱える DoS リスクがある。
// PDF 用途は通常 1〜2 個で十分なので 40MB に制限する。超過した PDF は FILE_TOO_LARGE で reject。
export const MAX_TOTAL_PDF_BYTES = 40 * 1024 * 1024;

// fetch のタイムアウト。Discord CDN がハングしてもユーザを長く待たせない。
const PDF_FETCH_TIMEOUT_MS = 30_000;

async function buildPdfDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:application/pdf;base64,${base64}`;
}

export async function parseAttachments(
  attachments: Collection<string, Attachment>,
): Promise<AttachmentParseResult> {
  const parts: ChatMessageContent[] = [];
  const rejected: AttachmentParseResult["rejected"] = [];
  let hasImage = false;
  let hasPdf = false;
  let totalPdfBytes = 0;

  for (const attachment of attachments.values()) {
    const contentType = attachment.contentType;

    if (contentType === null) {
      rejected.push({ filename: attachment.name, reason: "MISSING_MIME" });
      continue;
    }

    if (SUPPORTED_IMAGE_MIME.has(contentType)) {
      parts.push({ type: "image_url", image_url: { url: attachment.url } });
      hasImage = true;
      continue;
    }

    if (SUPPORTED_FILE_MIME.has(contentType)) {
      if (attachment.size > MAX_PDF_BYTES) {
        rejected.push({ filename: attachment.name, reason: "FILE_TOO_LARGE" });
        continue;
      }
      if (totalPdfBytes + attachment.size > MAX_TOTAL_PDF_BYTES) {
        rejected.push({ filename: attachment.name, reason: "FILE_TOO_LARGE" });
        continue;
      }
      try {
        const dataUrl = await buildPdfDataUrl(attachment.url);
        parts.push({
          type: "file",
          file: { filename: attachment.name, file_data: dataUrl },
        });
        hasPdf = true;
        totalPdfBytes += attachment.size;
      } catch (err) {
        logger.error("Failed to fetch PDF attachment for base64 encoding", {
          filename: attachment.name,
          size: attachment.size,
          error: err instanceof Error ? err.message : String(err),
        });
        rejected.push({ filename: attachment.name, reason: "FETCH_FAILED" });
      }
      continue;
    }

    rejected.push({ filename: attachment.name, reason: "UNSUPPORTED_MIME" });
  }

  return { parts, hasImage, hasPdf, rejected };
}
