/**
 * Cogito /reflect 엔드포인트 테스트
 *
 * cogito.schema.json의 각 레벨별 응답을 검증한다.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { createRequire } from "module";
import { createCogitoRouter } from "./cogito.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

describe("Cogito /reflect endpoints", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(createCogitoRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("Level 0: GET /reflect", () => {
    it("identity와 capabilities를 반환", async () => {
      const res = await fetch(`${baseUrl}/reflect`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        identity: { name: string; version: string; description: string; language: string; port: number };
        capabilities: Array<{ name: string; description: string }>;
      };

      // identity 필수 필드
      expect(data.identity.name).toBe("soul-dashboard");
      expect(data.identity.version).toBe(_pkg.version);
      expect(data.identity.description).toBeTruthy();
      expect(data.identity.language).toBe("node");
      expect(data.identity.port).toBeTypeOf("number");

      // capabilities
      expect(data.capabilities).toHaveLength(4);
      const capNames = data.capabilities.map((c) => c.name);
      expect(capNames).toEqual([
        "session_proxy",
        "event_cache",
        "llm_proxy",
        "static_serving",
      ]);
      // 각 capability에 description 존재
      for (const cap of data.capabilities) {
        expect(cap.description).toBeTruthy();
      }
    });
  });

  describe("Level 1: GET /reflect/config", () => {
    it("전체 config 목록을 반환하며 필수 필드가 있음", async () => {
      const res = await fetch(`${baseUrl}/reflect/config`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        configs: Array<{
          key: string;
          source: string;
          sensitive: boolean;
          required: boolean;
          status: string;
          current_value?: string | null;
        }>;
      };

      expect(data.configs.length).toBeGreaterThanOrEqual(1);

      // 각 항목에 schema 필수 필드 존재
      for (const c of data.configs) {
        expect(c.key).toBeTruthy();
        expect(["env", "file", "arg"]).toContain(c.source);
        expect(typeof c.sensitive).toBe("boolean");
        expect(typeof c.required).toBe("boolean");
        expect(["valid", "missing", "empty"]).toContain(c.status);
      }
    });

    it("sensitive 항목은 current_value를 노출하지 않음", async () => {
      const res = await fetch(`${baseUrl}/reflect/config`);
      const data = (await res.json()) as {
        configs: Array<{ key: string; sensitive: boolean; current_value?: string | null }>;
      };

      const sensitiveConfigs = data.configs.filter((c) => c.sensitive);
      for (const c of sensitiveConfigs) {
        expect(c.current_value).toBeUndefined();
      }
    });

    it("capability별 config 필터링", async () => {
      const res = await fetch(`${baseUrl}/reflect/config/event_cache`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        configs: Array<{ key: string; capability: string | null }>;
      };

      // event_cache에 속한 config만 반환
      for (const c of data.configs) {
        expect(c.capability).toBe("event_cache");
      }
    });

    it("존재하지 않는 capability는 404", async () => {
      const res = await fetch(`${baseUrl}/reflect/config/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("Level 2: GET /reflect/source", () => {
    it("전체 source 목록을 반환하며 필수 필드가 있음", async () => {
      const res = await fetch(`${baseUrl}/reflect/source`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        sources: Array<{
          capability: string;
          module: string;
          path: string;
          entry_point: string;
          start_line: number;
          end_line: number;
          git_head: string;
        }>;
      };

      expect(data.sources).toHaveLength(4);

      for (const s of data.sources) {
        expect(s.capability).toBeTruthy();
        expect(s.module).toBeTruthy();
        expect(s.path).toBeTruthy();
        expect(s.entry_point).toBeTruthy();
        expect(typeof s.start_line).toBe("number");
        expect(typeof s.end_line).toBe("number");
        expect(s.git_head).toBeTruthy();
      }
    });

    it("capability별 source 필터링", async () => {
      const res = await fetch(`${baseUrl}/reflect/source/session_proxy`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        sources: Array<{ capability: string }>;
      };

      expect(data.sources).toHaveLength(1);
      expect(data.sources[0].capability).toBe("session_proxy");
    });

    it("존재하지 않는 capability는 404", async () => {
      const res = await fetch(`${baseUrl}/reflect/source/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("Level 3: GET /reflect/runtime", () => {
    it("runtime status 필수 필드를 직접 반환 (schema: runtime_status)", async () => {
      const res = await fetch(`${baseUrl}/reflect/runtime`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        status: string;
        pid: number;
        uptime_seconds: number;
        metrics: Record<string, number>;
      };

      // schema 필수: status, pid, uptime_seconds
      expect(["healthy", "degraded", "unhealthy"]).toContain(data.status);
      expect(data.pid).toBeTypeOf("number");
      expect(data.pid).toBeGreaterThan(0);
      expect(data.uptime_seconds).toBeTypeOf("number");
      expect(data.uptime_seconds).toBeGreaterThanOrEqual(0);

      // metrics
      expect(data.metrics.memory_mb).toBeTypeOf("number");
    });
  });

  describe("Full: GET /reflect/full", () => {
    it("모든 레벨의 데이터를 통합하여 반환", async () => {
      const res = await fetch(`${baseUrl}/reflect/full`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as {
        identity: { name: string };
        capabilities: unknown[];
        configs: unknown[];
        sources: unknown[];
        runtime: { status: string; pid: number; uptime_seconds: number };
      };

      // Level 0
      expect(data.identity.name).toBe("soul-dashboard");
      expect(data.capabilities).toHaveLength(4);

      // Level 1
      expect(data.configs.length).toBeGreaterThanOrEqual(1);

      // Level 2
      expect(data.sources).toHaveLength(4);

      // Level 3
      expect(data.runtime.status).toBe("healthy");
      expect(data.runtime.pid).toBeGreaterThan(0);
      expect(data.runtime.uptime_seconds).toBeGreaterThanOrEqual(0);
    });
  });
});
