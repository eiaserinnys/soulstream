(() => {
  const ACTIVATED_MESSAGE = "SOULSTREAM_SW_ACTIVATED";
  const DEFER_RELOAD_MESSAGE = "SOULSTREAM_SW_DEFER_RELOAD";
  const APPROVE_RELOAD_MESSAGE = "SOULSTREAM_SW_APPROVE_RELOAD";
  const CAPABLE_MESSAGE = "SOULSTREAM_SW_CAPABLE";
  const CAPABILITY_CACHE = "soulstream-sw-capabilities-v1";
  const MIGRATION_GRACE_MS = 750;
  const clientDecisions = new Map();
  const capableClientIds = new Set();
  let activeToken = null;

  self.addEventListener("message", (event) => {
    const data = event.data;
    if (
      data?.type === CAPABLE_MESSAGE
      && typeof event.source?.id === "string"
    ) {
      capableClientIds.add(event.source.id);
      event.waitUntil(persistCapability(event.source.id));
      return;
    }
    if (
      !activeToken
      || !data
      || (data.type !== DEFER_RELOAD_MESSAGE && data.type !== APPROVE_RELOAD_MESSAGE)
      || data.token !== activeToken
      || typeof event.source?.id !== "string"
    ) return;
    const clientId = event.source.id;
    if (data.type === DEFER_RELOAD_MESSAGE) {
      clientDecisions.set(clientId, "defer");
      return;
    }
    clientDecisions.set(clientId, "approve");
    event.waitUntil(navigateClient(event.source));
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
      const token = self.crypto.randomUUID();
      activeToken = token;
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        client.postMessage({ type: ACTIVATED_MESSAGE, token });
      }
      await new Promise((resolve) => self.setTimeout(resolve, MIGRATION_GRACE_MS));
      const currentClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      await Promise.all(currentClients.map(async (client) => {
        const decision = clientDecisions.get(client.id);
        if (decision === "defer") return;
        if (
          decision === "approve"
          || (client.visibilityState === "hidden" && !await isCapable(client.id))
        ) {
          await navigateClient(client);
        }
      }));
      for (const client of currentClients) {
        if (clientDecisions.get(client.id) !== "defer") {
          clientDecisions.delete(client.id);
        }
      }
    })());
  });

  async function navigateClient(client) {
    try {
      await client.navigate(client.url);
      clientDecisions.delete(client.id);
    } catch (error) {
      console.warn("Service worker client migration failed", error);
    }
  }

  async function persistCapability(clientId) {
    const cache = await self.caches.open(CAPABILITY_CACHE);
    await cache.put(capabilityKey(clientId), new Response("capable"));
  }

  async function isCapable(clientId) {
    if (capableClientIds.has(clientId)) return true;
    const cache = await self.caches.open(CAPABILITY_CACHE);
    return await cache.match(capabilityKey(clientId)) !== undefined;
  }

  function capabilityKey(clientId) {
    return `/__soulstream_sw_capable__/${encodeURIComponent(clientId)}`;
  }
})();
