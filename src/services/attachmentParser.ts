import type { Attachment, Collection } from "discord.js";
import type { ChatMessageContent, ChatPlugin } from "../types";

export type AttachmentRejectReason = "UNSUPPORTED_MIME" | "MISSING_MIME";

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

export function parseAttachments(
  attachments: Collection<string, Attachment>,
): AttachmentParseResult {
  const parts: ChatMessageContent[] = [];
  const rejected: AttachmentParseResult["rejected"] = [];
  let hasImage = false;
  let hasPdf = false;

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
      parts.push({
        type: "file",
        file: { filename: attachment.name, file_data: attachment.url },
      });
      hasPdf = true;
      continue;
    }

    rejected.push({ filename: attachment.name, reason: "UNSUPPORTED_MIME" });
  }

  return { parts, hasImage, hasPdf, rejected };
}
