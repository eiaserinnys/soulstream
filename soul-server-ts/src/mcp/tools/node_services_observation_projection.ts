/** Haniel의 상세 응답을 요청한 서비스 또는 작은 상태 요약으로 투영한다. */
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : {};
}

function pick(value: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
}

export function selectService(value: unknown, service: string): JsonObject {
  const entries = object(value);
  return Object.hasOwn(entries, service) ? { [service]: entries[service] } : {};
}

const serviceFields = [
  "name", "process_status", "health_status", "ready", "pid", "port", "role", "enabled", "uptime_ms",
] as const;
const nodeFields = [
  "node_id", "hostname", "os", "arch", "haniel_version", "connected", "last_seen", "created_at", "deploy_protocol",
] as const;
const statusFields = ["running", "start_time", "last_poll", "poll_count", "poll_interval"] as const;

export function projectStatus(value: unknown, service?: string): JsonObject {
  const status = object(value);
  const services = object(status.services);
  const repos = object(status.repos);
  if (service !== undefined) {
    const serviceConfig = object(object(services[service]).config);
    const repo = typeof serviceConfig.repo === "string" ? serviceConfig.repo : undefined;
    return {
      ...pick(status, statusFields),
      services: selectService(services, service),
      dependency_graph: selectService(status.dependency_graph, service),
      repos: repo === undefined ? {} : selectService(repos, repo),
    };
  }
  return {
    ...pick(status, statusFields),
    services: Object.fromEntries(Object.entries(services).map(([name, value]) => {
      const item = object(value);
      const config = object(item.config);
      return [name, {
        name,
        ...(item.state === undefined ? {} : { health_status: item.state }),
        ...(typeof item.uptime === "number" ? { uptime_ms: Math.floor(item.uptime * 1000) } : {}),
        ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
      }];
    })),
    repos: Object.fromEntries(Object.entries(repos).map(([name, value]) => {
      const commits = object(object(value).pending_changes).commits;
      return [name, { pending_changes_count: Array.isArray(commits) ? commits.length : 0 }];
    })),
  };
}

export function projectNodeServices(value: unknown, service?: string): JsonObject {
  const nodes = object(value).nodes;
  return {
    nodes: Array.isArray(nodes) ? nodes.map(value => {
      const node = object(value);
      const result = pick(node, nodeFields);
      if (Array.isArray(node.services)) {
        const services = node.services.map(object);
        result.services = service === undefined
          ? services.map(item => pick(item, serviceFields))
          : services.filter(item => item.name === service);
      }
      return result;
    }) : [],
  };
}
