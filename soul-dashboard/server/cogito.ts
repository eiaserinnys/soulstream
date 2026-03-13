/**
 * Cogito Protocol /reflect Router
 *
 * soul-dashboard의 자기 기술(self-description) 엔드포인트.
 * cogito.schema.json 프로토콜에 따라 Level 0~3 + full을 제공한다.
 *
 * Level 0: /reflect          → identity + capabilities
 * Level 1: /reflect/config   → config entries (전체 / capability별)
 * Level 2: /reflect/source   → source entries (전체 / capability별)
 * Level 3: /reflect/runtime  → runtime status (pid, uptime, memory, health)
 * Full:    /reflect/full     → Level 0~3 통합
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { execSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

// ── 타입 정의 (cogito.schema.json 기반) ──

interface Identity {
  name: string;
  version: string;
  description: string;
  language: string;
  port: number;
}

interface Capability {
  name: string;
  description: string;
}

interface ConfigEntry {
  key: string;
  capability: string | null;
  source: "env" | "file" | "arg";
  sensitive: boolean;
  required: boolean;
  status: "valid" | "missing" | "empty";
  current_value?: string | null;
}

interface SourceEntry {
  capability: string;
  module: string;
  path: string;
  entry_point: string;
  start_line: number;
  end_line: number;
  git_head: string;
}

interface RuntimeStatus {
  status: "healthy" | "degraded" | "unhealthy";
  pid: number;
  uptime_seconds: number;
  metrics: Record<string, number>;
}

// ── 헬퍼 ──

function resolveConfigStatus(key: string): "valid" | "missing" | "empty" {
  const val = process.env[key];
  if (val === undefined) return "missing";
  if (val === "") return "empty";
  return "valid";
}

function getGitHead(cwd: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd, timeout: 3000 })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// ── 정적 선언 ──

const CAPABILITIES: Capability[] = [
  {
    name: "session_proxy",
    description:
      "Soul Server의 세션 API를 프록시하여 프론트엔드에 제공 (생성, 조회, SSE 스트리밍)",
  },
  {
    name: "event_cache",
    description:
      "SSE 이벤트를 인메모리 캐시하여 늦게 연결한 클라이언트에 히스토리 제공",
  },
  {
    name: "llm_proxy",
    description:
      "OpenAI/Anthropic LLM API 호출을 프록시하여 CORS 및 인증을 처리",
  },
  {
    name: "static_serving",
    description:
      "Vite 빌드 결과물(프론트엔드 SPA)을 정적 파일로 서빙",
  },
];

interface ConfigDef {
  key: string;
  capability: string | null;
  source: "env" | "file" | "arg";
  sensitive: boolean;
  required: boolean;
}

const CONFIG_DEFS: ConfigDef[] = [
  { key: "DASHBOARD_PORT", capability: null, source: "env", sensitive: false, required: false },
  { key: "SOUL_BASE_URL", capability: "session_proxy", source: "env", sensitive: false, required: false },
  { key: "CLAUDE_SERVICE_TOKEN", capability: "session_proxy", source: "env", sensitive: true, required: true },
  { key: "DASHBOARD_AUTH_TOKEN", capability: null, source: "env", sensitive: true, required: false },
  { key: "SERENDIPITY_URL", capability: null, source: "env", sensitive: false, required: false },
  { key: "DASHBOARD_ALLOWED_ORIGINS", capability: null, source: "env", sensitive: false, required: false },
  { key: "DASHBOARD_CACHE_DIR", capability: "event_cache", source: "env", sensitive: false, required: false },
  { key: "DASHBOARD_BYPASS_CACHE", capability: "event_cache", source: "env", sensitive: false, required: false },
];

const SOURCE_MAP: Array<{
  capability: string;
  module: string;
  path: string;
  entry_point: string;
  start_line: number;
  end_line: number;
}> = [
  {
    capability: "session_proxy",
    module: "server/routes/sessions-proxy.ts",
    path: "soul-dashboard/server/routes/sessions-proxy.ts",
    entry_point: "createSessionsProxyRouter",
    start_line: 24,
    end_line: 200,
  },
  {
    capability: "event_cache",
    module: "server/routes/events-cached.ts",
    path: "soul-dashboard/server/routes/events-cached.ts",
    entry_point: "createEventsCachedRouter",
    start_line: 30,
    end_line: 318,
  },
  {
    capability: "llm_proxy",
    module: "server/routes/llm-proxy.ts",
    path: "soul-dashboard/server/routes/llm-proxy.ts",
    entry_point: "createLlmProxyRouter",
    start_line: 41,
    end_line: 181,
  },
  {
    capability: "static_serving",
    module: "server/index.ts",
    path: "soul-dashboard/server/index.ts",
    entry_point: "express.static",
    start_line: 206,
    end_line: 217,
  },
];

// ── Router 생성 ──

export function createCogitoRouter(): Router {
  const router = Router();
  const startTime = Date.now();
  const gitRoot = path.resolve(__dirname, "../..");
  const gitHead = getGitHead(gitRoot);

  const identity: Identity = {
    name: "soul-dashboard",
    description:
      "Soul Server의 웹 대시보드 BFF. 세션 프록시, 이벤트 캐시, LLM 프록시, 프론트엔드 정적 파일 서빙을 제공한다.",
    version: _pkg.version,
    language: "node",
    port: parseInt(process.env.DASHBOARD_PORT ?? "3109", 10),
  };

  function buildConfigs(capFilter?: string): ConfigEntry[] {
    const defs = capFilter
      ? CONFIG_DEFS.filter((c) => c.capability === capFilter)
      : CONFIG_DEFS;

    return defs.map((c) => {
      const entry: ConfigEntry = {
        key: c.key,
        capability: c.capability,
        source: c.source,
        sensitive: c.sensitive,
        required: c.required,
        status: resolveConfigStatus(c.key),
      };
      if (!c.sensitive) {
        entry.current_value = process.env[c.key] ?? null;
      }
      return entry;
    });
  }

  function buildSources(capFilter?: string): SourceEntry[] {
    const defs = capFilter
      ? SOURCE_MAP.filter((s) => s.capability === capFilter)
      : SOURCE_MAP;

    return defs.map((s) => ({
      capability: s.capability,
      module: s.module,
      path: s.path,
      entry_point: s.entry_point,
      start_line: s.start_line,
      end_line: s.end_line,
      git_head: gitHead,
    }));
  }

  function buildRuntime(): RuntimeStatus {
    return {
      status: "healthy",
      pid: process.pid,
      uptime_seconds: Math.round((Date.now() - startTime) / 1000),
      metrics: {
        memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };
  }

  // Level 0: identity + capabilities
  router.get("/reflect", (_req: Request, res: Response) => {
    res.json({ identity, capabilities: CAPABILITIES });
  });

  // Level 1: config (전체)
  router.get("/reflect/config", (_req: Request, res: Response) => {
    res.json({ configs: buildConfigs() });
  });

  // Level 1: config by capability
  router.get("/reflect/config/:capability", (req: Request, res: Response) => {
    const cap = CAPABILITIES.find((c) => c.name === req.params.capability);
    if (!cap) {
      res
        .status(404)
        .json({ error: `capability '${req.params.capability}' not found` });
      return;
    }
    res.json({ configs: buildConfigs(cap.name) });
  });

  // Level 2: source (전체)
  router.get("/reflect/source", (_req: Request, res: Response) => {
    res.json({ sources: buildSources() });
  });

  // Level 2: source by capability
  router.get("/reflect/source/:capability", (req: Request, res: Response) => {
    const cap = CAPABILITIES.find((c) => c.name === req.params.capability);
    if (!cap) {
      res
        .status(404)
        .json({ error: `capability '${req.params.capability}' not found` });
      return;
    }
    res.json({ sources: buildSources(cap.name) });
  });

  // Level 3: runtime
  router.get("/reflect/runtime", (_req: Request, res: Response) => {
    res.json(buildRuntime());
  });

  // Full: Level 0~3 통합
  router.get("/reflect/full", (_req: Request, res: Response) => {
    res.json({
      identity,
      capabilities: CAPABILITIES,
      configs: buildConfigs(),
      sources: buildSources(),
      runtime: buildRuntime(),
    });
  });

  return router;
}
