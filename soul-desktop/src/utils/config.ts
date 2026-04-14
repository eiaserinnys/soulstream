import { Store } from "@tauri-apps/plugin-store";

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await Store.load("config.json");
  }
  return store;
}

export async function getServerUrl(): Promise<string | null> {
  const s = await getStore();
  return await s.get<string>("server_url");
}

export async function setServerUrl(url: string): Promise<void> {
  const s = await getStore();
  await s.set("server_url", url);
  await s.save();
}
