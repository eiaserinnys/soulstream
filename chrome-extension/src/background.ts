import { buildSoulstreamPrompt } from "./shared/prompt.js";
import {
  DEFAULT_CONFIG,
  MENU_ACTIONS,
  buildSessionEndpoint,
  isPageAction,
  isRestrictedUrl,
  mergeConfig,
  type ExtensionConfig,
  type PageAction,
  type PageActionPayload,
} from "./shared/schema.js";
import { sendSessionRequest } from "./shared/soulstream.js";

const EXTRACT_MESSAGE = "SOULSTREAM_EXTRACT_PAGE";

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenuClick(info, tab).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Soulstream page action failed";
    showStatus("ERR", "#b42318", message);
    notify("Soulstream action failed", message);
  });
});

function createContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    for (const action of MENU_ACTIONS) {
      chrome.contextMenus.create({
        id: action.id,
        title: action.title,
        contexts: ["page", "selection", "link"],
      });
    }
  });
}

async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): Promise<void> {
  if (!isPageAction(info.menuItemId)) {
    throw new Error("Unknown Soulstream page action");
  }

  const config = await readConfig();
  if (!config.baseUrl) {
    chrome.runtime.openOptionsPage();
    throw new Error("Soulstream URL is not configured");
  }

  buildSessionEndpoint(config.baseUrl);
  showStatus("...", "#475467", "Sending page to Soulstream");

  const payload = await extractPayload(info.menuItemId, info, tab, config);
  const prompt = buildSoulstreamPrompt(payload);
  const result = await sendSessionRequest(config, prompt, fetch);

  showStatus("OK", "#027a48", `Sent to Soulstream: ${result.agentSessionId}`);
  notify("Sent to Soulstream", `Session ${result.agentSessionId} created.`);
}

async function extractPayload(
  action: PageAction,
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
  config: ExtensionConfig,
): Promise<PageActionPayload> {
  const fallbackUrl = info.linkUrl || info.pageUrl || tab?.url || "";
  const fallbackTitle = tab?.title || fallbackUrl;
  const selectedText = info.selectionText ?? "";

  if (!tab?.id || !fallbackUrl || isRestrictedUrl(fallbackUrl)) {
    return fallbackPayload(action, fallbackUrl, fallbackTitle, selectedText, "Content script cannot access this page");
  }

  try {
    const response = await sendTabExtractMessage(tab.id, {
      type: EXTRACT_MESSAGE,
      selectionText: selectedText,
      includeBody: config.includeBody,
      bodyCharLimit: config.bodyCharLimit,
    });
    if (!isExtractSuccess(response)) {
      return fallbackPayload(action, fallbackUrl, fallbackTitle, selectedText, extractFailureMessage(response));
    }
    return {
      action,
      url: response.page.url || fallbackUrl,
      title: response.page.title || fallbackTitle,
      selectionText: response.page.selectionText || selectedText,
      metaDescription: response.page.metaDescription,
      bodyText: response.page.bodyText,
      bodyTruncated: response.page.bodyTruncated,
      bodyCharLimit: response.page.bodyCharLimit,
      extractionStatus: response.page.extractionStatus,
      source: "content-script",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Page extraction failed";
    return fallbackPayload(action, fallbackUrl, fallbackTitle, selectedText, message);
  }
}

function fallbackPayload(
  action: PageAction,
  url: string,
  title: string,
  selectionText: string,
  reason: string,
): PageActionPayload {
  return {
    action,
    url,
    title,
    selectionText,
    metaDescription: "",
    bodyText: "",
    bodyTruncated: false,
    bodyCharLimit: 0,
    extractionStatus: "fallback",
    extractionError: reason,
    source: "tab-fallback",
  };
}

function sendTabExtractMessage(tabId: number, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error?.message) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

async function readConfig(): Promise<ExtensionConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get(Object.keys(DEFAULT_CONFIG), (items) => {
      resolve(mergeConfig(items as Partial<Record<keyof ExtensionConfig, unknown>>));
    });
  });
}

function showStatus(text: string, color: string, title: string): void {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

function notify(title: string, message: string): void {
  chrome.notifications.create(`soulstream-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
  });
}

interface ExtractSuccess {
  ok: true;
  page: {
    url: string;
    title: string;
    selectionText: string;
    metaDescription: string;
    bodyText: string;
    bodyTruncated: boolean;
    bodyCharLimit: number;
    extractionStatus: "complete" | "partial";
  };
}

function isExtractSuccess(value: unknown): value is ExtractSuccess {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; page?: unknown };
  return candidate.ok === true && typeof candidate.page === "object" && candidate.page !== null;
}

function extractFailureMessage(value: unknown): string {
  if (typeof value !== "object" || value === null) return "Page extraction failed";
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : "Page extraction failed";
}
