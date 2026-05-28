declare namespace chrome {
  namespace runtime {
    const lastError: { message?: string } | undefined;
    function openOptionsPage(callback?: () => void): void;
    function getURL(path: string): string;
    const onInstalled: ChromeEvent<() => void>;
    const onStartup: ChromeEvent<() => void>;
    const onMessage: ChromeEvent<(
      message: unknown,
      sender: MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void>;
  }

  namespace contextMenus {
    type ContextType = "page" | "selection" | "link";
    interface OnClickData {
      menuItemId: string | number;
      pageUrl?: string;
      linkUrl?: string;
      selectionText?: string;
    }
    function removeAll(callback?: () => void): void;
    function create(properties: {
      id: string;
      title: string;
      contexts?: ContextType[];
    }): void;
    const onClicked: ChromeEvent<(info: OnClickData, tab?: tabs.Tab) => void>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
    }
    function sendMessage(
      tabId: number,
      message: unknown,
      callback: (response?: unknown) => void,
    ): void;
  }

  namespace storage {
    const local: {
      get(keys: string[], callback: (items: Record<string, unknown>) => void): void;
      set(items: Record<string, unknown>, callback?: () => void): void;
    };
  }

  namespace notifications {
    function create(
      notificationId: string,
      options: {
        type: "basic";
        iconUrl: string;
        title: string;
        message: string;
      },
      callback?: (notificationId: string) => void,
    ): void;
  }

  namespace action {
    function setBadgeText(details: { text: string }): void;
    function setBadgeBackgroundColor(details: { color: string }): void;
    function setTitle(details: { title: string }): void;
  }

  interface MessageSender {
    tab?: tabs.Tab;
  }

  interface ChromeEvent<T extends (...args: never[]) => unknown> {
    addListener(callback: T): void;
  }
}
