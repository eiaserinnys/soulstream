import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { getServerUrl, setServerUrl } from "./utils/config";
import { checkReachability } from "./utils/url";
import { checkForUpdate } from "./utils/updater";
import Setup from "./pages/Setup";
import Settings from "./pages/Settings";
import ErrorPage from "./pages/Error";
import UpdateBanner from "./components/UpdateBanner";

type AppState = "loading" | "setup" | "connecting" | "settings" | "error";

function App() {
  const [state, setState] = useState<AppState>("loading");
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    checkForUpdate().then(setUpdate);
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const url = await getServerUrl();
      if (url) {
        setSavedUrl(url);
        navigateToServer(url);
      } else {
        setState("setup");
      }
    } catch {
      setState("setup");
    }
  }

  async function navigateToServer(url: string) {
    setState("connecting");
    try {
      await checkReachability(url, 10000);
      // Navigate the entire WebView to the server URL.
      // This unloads the React app — there's no programmatic way back.
      // TODO(phase-1): Add native menu item (Cmd+, / Settings) to return to bundled UI.
      window.location.href = url;
    } catch {
      setErrorMessage(`${url} 에 연결할 수 없습니다.`);
      setState("error");
    }
  }

  async function handleConnect(url: string) {
    try {
      await setServerUrl(url);
    } catch {
      setErrorMessage("설정 저장에 실패했습니다.");
      setState("error");
      return;
    }
    setSavedUrl(url);
    navigateToServer(url);
  }

  function handleRetry() {
    if (savedUrl) {
      navigateToServer(savedUrl);
    }
  }

  function handleChangeUrl() {
    setState("setup");
  }

  function handleOpenSettings() {
    setState("settings");
  }

  function handleBackFromSettings() {
    if (savedUrl) {
      navigateToServer(savedUrl);
    } else {
      setState("setup");
    }
  }

  const showBanner = update && !updateDismissed;

  return (
    <>
      {showBanner && (
        <UpdateBanner
          update={update}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      <div className={showBanner ? "pt-12" : ""}>
        {(state === "loading" || state === "connecting") && (
          <div className="flex items-center justify-center min-h-screen">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-[var(--color-text-muted)]">
                {state === "loading"
                  ? "설정을 불러오는 중..."
                  : "서버에 연결하는 중..."}
              </p>
            </div>
          </div>
        )}

        {state === "error" && (
          <ErrorPage
            message={errorMessage}
            onRetry={handleRetry}
            onChangeUrl={handleChangeUrl}
          />
        )}

        {state === "settings" && (
          <Settings
            currentUrl={savedUrl ?? ""}
            onSave={handleConnect}
            onBack={handleBackFromSettings}
          />
        )}

        {state === "setup" && (
          <Setup
            onConnect={handleConnect}
            onSettings={savedUrl ? handleOpenSettings : undefined}
          />
        )}
      </div>
    </>
  );
}

export default App;
