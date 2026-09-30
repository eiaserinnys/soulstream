import type { SqlClient } from "../control_plane/control_plane_types.js";
import { readR2Settings, type R2Purpose } from "../system/r2_settings.js";
import { createR2BoardAssetStorage, checkR2Bucket } from "./live_board_asset_storage.js";

export type R2CheckResult = { status: "ok" | "not_configured" | "access_failed"; message: string };
export function createR2StorageResolver(resolveSql: () => Promise<SqlClient>) {
  async function resolve(purpose: R2Purpose) {
    const settings = await readR2Settings(await resolveSql(), purpose);
    return settings.endpoint && settings.bucket && settings.accessKeyId && settings.secretAccessKey
      ? createR2BoardAssetStorage(settings) : null;
  }
  async function check(purpose: R2Purpose): Promise<R2CheckResult> {
    const settings = await readR2Settings(await resolveSql(), purpose);
    if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
      return { status: "not_configured", message: "접속 정보가 모두 설정되지 않았습니다." };
    }
    try {
      await checkR2Bucket(settings);
      return { status: "ok", message: "버킷에 접근할 수 있습니다." };
    } catch {
      return { status: "access_failed", message: "버킷 접근에 실패했습니다. 권한과 접속 정보를 확인해 주세요." };
    }
  }
  return { resolve, check };
}
