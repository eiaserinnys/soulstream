import { readFileSync } from "node:fs";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { getImageAttachmentMediaType } from "../attachments/image_media.js";

export function makeUserMessage(content: string, imageAttachmentPaths?: string[]): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: buildUserMessageContent(content, imageAttachmentPaths),
    },
    parent_tool_use_id: null,
    priority: "now",
  };
}

type ClaudeUserContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];

function buildUserMessageContent(
  prompt: string,
  imageAttachmentPaths?: string[],
): SDKUserMessage["message"]["content"] {
  if (!imageAttachmentPaths || imageAttachmentPaths.length === 0) {
    return prompt;
  }

  const content: ClaudeUserContentBlock[] = [{ type: "text", text: prompt }];
  for (const path of imageAttachmentPaths) {
    content.push(makeImageContentBlock(path));
  }
  return content;
}

function makeImageContentBlock(path: string): ClaudeUserContentBlock {
  const mediaType = getImageAttachmentMediaType(path);
  if (!mediaType) {
    throw new Error(`Unsupported image attachment type: ${path}`);
  }

  let data: string;
  try {
    data = readFileSync(path).toString("base64");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read image attachment ${path}: ${message}`);
  }

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  };
}
