import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let isChecking = false;

/**
 * Check for available updates.
 * Returns the Update object if an update is available, null otherwise.
 * Silently returns null on any error — the app continues with the current version.
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (isChecking) return null;
  isChecking = true;
  try {
    const update = await check();
    return update;
  } catch (e) {
    console.error("Update check failed:", e);
    return null;
  } finally {
    isChecking = false;
  }
}

/**
 * Download and install an update, reporting progress via callback.
 */
export async function startInstall(
  update: Update,
  onProgress?: (chunkLength: number, contentLength: number) => void,
): Promise<void> {
  let contentLength = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength ?? 0;
    } else if (event.event === "Progress" && onProgress) {
      onProgress(event.data.chunkLength, contentLength);
    }
  });
}

/**
 * Relaunch the app after an update has been installed.
 */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}
