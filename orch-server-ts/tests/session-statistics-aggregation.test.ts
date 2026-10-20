import { describe, expect, it, vi } from "vitest";
import {
  aggregateSessionStatisticsMetrics,
  selectOwnedSessionStatisticsRows,
  sessionStatisticsSourceKey,
} from "../src/usage/session_statistics_aggregate.js";
import { buildSessionStatisticsOptions } from "../src/usage/session_statistics_options.js";
import { buildSessionStatisticsMaterial } from "../src/usage/session_statistics_material.js";
import {
  buildDay,
  buildOverview,
  SessionStatisticsService,
} from "../src/usage/session_statistics_service.js";
import {
  createSessionStatisticsCoverageIndex,
  sessionStatisticsCoverage,
} from "../src/usage/session_statistics_coverage.js";
import {
  boundaryRow,
  coverage,
  fact,
  materialRow,
  missingRow,
  periodBoundaryRead,
  read,
  timestamp,
  toolCallRow,
  usageRow,
} from "./fixtures/session_statistics_aggregation.fixtures.js";

describe("session statistics coverage aggregation", () => {
  it("applies the final period after canonical owner and coverage date selection", () => {
    const source = periodBoundaryRead();
    const result = buildOverview(source);
    const day = buildDay(source, "2026-10-26");
    expect(result.totals.metrics.total_tokens).toBe(120);
    expect(result.totals.coverage).toMatchObject({
      usage_complete_events: 1, missing_usage_turns: 0, terminal_missing_usage: 0,
      ended_input_without_usage: 0, pending_inputs: 0, unattributed_missing_usage: false,
    });
    expect(result.by_model.map((row) => row.provider)).toEqual(["claude"]);
    expect(result.by_project.map((row) => row.project_id)).toEqual(["inside"]);
    expect(result.by_model.reduce((sum, row) => sum + (row.metrics.total_tokens ?? 0), 0)).toBe(120);
    expect(result.by_project.reduce((sum, row) => sum + (row.metrics.total_tokens ?? 0), 0)).toBe(120);
    expect(result.options.models).toEqual([
      { provider: "claude", model: "sonnet", backend: "claude", label: "sonnet" },
    ]);
    expect(result.options.projects.map((project) => project.project_id)).toEqual(["inside"]);
    expect(result.options.project_roster).toEqual(["inside"]);
    expect(result.options.model_rosters.find((roster) => roster.provider === "codex")?.models).toEqual([]);
    for (const axis of [result.series.filter((point) => point.provider !== undefined),
      result.series.filter((point) => point.project_id !== undefined)]) {
      expect(axis.reduce((sum, point) => sum + (point.metrics.total_tokens ?? 0), 0)).toBe(120);
    }
    expect(day.totals.metrics.total_tokens).toBe(null);
    expect(day.totals.coverage.missing_usage_turns).toBe(0);
    expect(day.by_model).toEqual([]);
    expect(day.by_project).toEqual([]);
    const filtered = buildOverview({ ...source, query: { ...source.query, provider: "codex" } });
    expect(filtered.options).toEqual(result.options);
    expect(filtered.totals.metrics.total_tokens).toBe(null);
    const outsideOnly = buildOverview({ ...source, rows: source.rows.filter((row) => row.session_id !== "inside") });
    expect(outsideOnly.totals.metrics.total_tokens).toBe(null);
    expect(outsideOnly.series).toEqual([]);
    expect(outsideOnly.options.models).toEqual([]);
    expect(outsideOnly.options.projects).toEqual([]);
    expect(source.rows[1]?.owner_recorded_at).toBe("2026-10-25T18:00:00.000Z");
  });

  it("counts model parts as one complete and priced owner event", () => {
    const first = usageRow();
    const second = usageRow({
      selection_event_id: 20,
      fact: fact({ part_key: "usage:model/sonnet", representation: "model_breakdown" }),
    });
    const result = coverage([first, second]);

    expect(result.usage_complete_events).toBe(1);
    expect(result.priced_events).toBe(1);
  });

  it("keeps terminal and ended reasons while counting their shared input once", () => {
    const result = read([
      boundaryRow(10, "input"),
      missingRow(),
      boundaryRow(22, "session_ended"),
    ]);
    const index = createSessionStatisticsCoverageIndex(result);
    const coverageResult = sessionStatisticsCoverage(result, index, {}, []);

    expect(coverageResult.terminal_missing_usage).toBe(1);
    expect(coverageResult.ended_input_without_usage).toBe(1);
    expect(coverageResult.missing_usage_turns).toBe(1);
  });

  it("assigns a terminal and its closure to one representative day", () => {
    const closureDate = "2026-10-20T12:00:00.000Z";
    const result = read([
      boundaryRow(10, "input"),
      missingRow(),
      boundaryRow(22, "session_ended", { recorded_at: closureDate }),
    ]);
    const terminalDay = buildDay(result, "2026-10-19").totals.coverage;
    const closureDay = buildDay(result, "2026-10-20").totals.coverage;

    expect(terminalDay).toMatchObject({
      terminal_missing_usage: 1,
      ended_input_without_usage: 1,
      missing_usage_turns: 1,
    });
    expect(closureDay).toMatchObject({
      terminal_missing_usage: 0,
      ended_input_without_usage: 0,
      missing_usage_turns: 0,
    });
  });

  it("uses the latest diagnostic fact date for ambiguous legacy coverage", () => {
    const ambiguous = (eventId: number, recordedAt: string) => missingRow({
      selection_event_id: 10,
      candidate_event_id: null,
      missing_identity: "legacy-input-1",
      state: "ambiguous_legacy",
      owner_recorded_at: null,
      fact: fact({
        event_id: eventId,
        recorded_at: recordedAt,
        part_key: "usage:diagnostic",
        source_event_type: "failed_result",
        candidate_type: "failed_result",
        representation: "diagnostic",
        accounting_key: null,
        input_total: null,
        output_total: null,
        total_tokens: null,
        known_cost_usd: null,
        priced_tokens: null,
        unpriced_tokens: null,
        pricing_complete: null,
      }),
    });
    const result = read([
      ambiguous(21, timestamp),
      ambiguous(22, "2026-10-20T12:00:00.000Z"),
    ]);

    expect(buildDay(result, "2026-10-19").totals.coverage.missing_usage_turns).toBe(0);
    expect(buildDay(result, "2026-10-20").totals.coverage.missing_usage_turns).toBe(1);
  });

  it("reports an unattributed missing identity in the unfiltered scope", () => {
    const result = coverage([missingRow({ input_id: null })]);

    expect(result.missing_usage_turns).toBe(1);
    expect(result.unattributed_missing_usage).toBe(true);
  });

  it("keeps unattributed missing visible as a boolean under provider filtering", () => {
    const scoped = read([missingRow({ input_id: null })], { provider: "claude" });
    const index = createSessionStatisticsCoverageIndex(scoped);
    const result = sessionStatisticsCoverage(scoped, index, {}, []);

    expect(result.missing_usage_turns).toBe(0);
    expect(result.unattributed_missing_usage).toBe(true);
  });

  it("removes duplicate canonical source rows before selecting owned facts", () => {
    const duplicate = usageRow();
    const selected = selectOwnedSessionStatisticsRows(read([duplicate, duplicate]));

    expect(selected).toHaveLength(1);
  });

  it("sums known component fields without rebuilding total tokens and preserves decimal cost", () => {
    const complete = usageRow({
      fact: fact({
        cache_read: 8,
        reasoning_output: 5,
        priced_tokens: 60,
        unpriced_tokens: 60,
        pricing_complete: false,
      }),
    });
    const partial = usageRow({
      selection_event_id: 21,
      owner_event_id: 21,
      candidate_event_id: null,
      input_id: "input-2",
      accounting_key: "command-2",
      owner_recorded_at: "2026-10-20T00:00:00.000Z",
      fact: fact({
        event_id: 21,
        accounting_key: "command-2",
        input_id: "input-2",
        input_total: 30,
        output_total: null,
        total_tokens: null,
        known_cost_usd: 0.2,
        priced_tokens: 30,
        unpriced_tokens: 10,
        pricing_complete: false,
      }),
    });
    const decimals = new Map([
      [sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "0.1"],
      [sessionStatisticsSourceKey("session-1", 21, "usage:aggregate"), "0.2"],
    ]);
    const result = read([complete, partial], {}, decimals);
    const metrics = aggregateSessionStatisticsMetrics(result, selectOwnedSessionStatisticsRows(result));

    expect(metrics.input_total).toBe(130);
    expect(metrics.output_total).toBe(20);
    expect(metrics.cache_read).toBe(8);
    expect(metrics.reasoning_output).toBe(5);
    expect(metrics.total_tokens).toBe(120);
    expect(metrics.reference_cost_usd).toBe(0.3);
    const index = createSessionStatisticsCoverageIndex(result);
    const coverageResult = sessionStatisticsCoverage(result, index, {}, [complete, partial] as never);
    expect(coverageResult.priced_events).toBe(2);
    expect(coverageResult.unpriced_events).toBe(2);
    expect(coverageResult.priced_total_tokens).toBe(90);
    expect(coverageResult.unpriced_total_tokens).toBe(70);
  });

  it("keeps options based on the unfiltered period and sorts tied project totals by id", () => {
    const rows = Array.from({ length: 6 }, (_, index) => {
      const sessionId = `session-${index + 1}`;
      const projectId = `project-${index + 1}`;
      const eventId = index + 20;
      return usageRow({
        session_id: sessionId,
        selection_event_id: eventId,
        input_id: `input-${index + 1}`,
        accounting_key: `command-${index + 1}`,
        owner_event_id: eventId,
        fact: fact({
          session_id: sessionId,
          event_id: eventId,
          accounting_key: `command-${index + 1}`,
          input_id: `input-${index + 1}`,
          provider: index === 0 ? "claude" : "codex",
          model: index === 0 ? "sonnet" : "gpt",
        }),
      });
    });
    const sessions = rows.map((row, index) => ({
      sessionId: `session-${index + 1}`,
      folderId: `folder-${index + 1}`,
      cardFolderId: null,
      projectId: `project-${index + 1}`,
      projectLabel: `Project ${index + 1}`,
    }));
    const unfiltered = buildSessionStatisticsOptions(read(rows, {}, new Map(), sessions));
    const filtered = buildSessionStatisticsOptions(read(rows, {
      provider: "claude",
      model: "sonnet",
      project_ids: ["project-6"],
    }, new Map(), sessions));

    expect(filtered).toEqual(unfiltered);
    expect(unfiltered.projects.map((project) => project.project_id)).toEqual([
      "project-1", "project-2", "project-3", "project-4", "project-5", "project-6",
    ]);
    expect(unfiltered.project_roster).toEqual([
      "project-1", "project-2", "project-3", "project-4", "project-5",
    ]);
    expect(unfiltered.models).toHaveLength(2);
  });

  it("keeps a selected outside-roster project separate and preserves unclassified", () => {
    const namedRows = Array.from({ length: 6 }, (_, index) => {
      const sessionId = `session-${index + 1}`;
      const eventId = index + 20;
      return usageRow({
        session_id: sessionId,
        selection_event_id: eventId,
        input_id: `input-${index + 1}`,
        accounting_key: `command-${index + 1}`,
        owner_event_id: eventId,
        fact: fact({
          session_id: sessionId,
          event_id: eventId,
          accounting_key: `command-${index + 1}`,
          input_id: `input-${index + 1}`,
        }),
      });
    });
    const namedSessions = namedRows.map((_, index) => ({
      sessionId: `session-${index + 1}`,
      folderId: `folder-${index + 1}`,
      cardFolderId: null,
      projectId: `project-${index + 1}`,
      projectLabel: `Project ${index + 1}`,
    }));
    const outsideDecimals = new Map(namedRows.map((_, index) => [
      sessionStatisticsSourceKey(`session-${index + 1}`, index + 20, "usage:aggregate"),
      "0.1",
    ]));
    const outside = buildOverview(read(
      namedRows,
      { project_ids: ["project-6"] },
      outsideDecimals,
      namedSessions,
    ));
    expect(outside.by_project.map((project) => project.project_id)).toEqual(["project-6"]);

    const unclassifiedRow = usageRow({
      session_id: "session-null",
      fact: fact({ session_id: "session-null" }),
    });
    const unclassified = buildOverview(read(
      [unclassifiedRow],
      { project_ids: ["__unclassified__"] },
      new Map([[sessionStatisticsSourceKey("session-null", 20, "usage:aggregate"), "0.1"]]),
      [{ sessionId: "session-null", folderId: null, cardFolderId: null, projectId: null, projectLabel: "" }],
    ));
    expect(unclassified.by_project.map((project) => project.project_id)).toEqual([null]);
  });

  it("retains unknown provider/model options for unattributed missing usage", () => {
    const options = buildSessionStatisticsOptions(read([missingRow({ input_id: null })]));

    expect(options.providers.map((provider) => provider.provider)).toEqual([
      "claude", "codex", "antigravity", "deepseek", "kimi", "unknown",
    ]);
    expect(options.models).toContainEqual({
      provider: "unknown",
      model: null,
      backend: "unknown",
      label: "모델 미확인",
    });
  });

  it("retains positive usage with unknown provider and null model", () => {
    const row = usageRow({
      fact: fact({
        provider: "unknown",
        backend: null,
        model: null,
        input_total: 50,
        output_total: 10,
        total_tokens: 60,
        known_cost_usd: null,
        priced_tokens: 0,
        unpriced_tokens: 60,
        pricing_complete: false,
      }),
    });
    const result = buildOverview(read([row]));

    expect(result.totals.metrics.total_tokens).toBe(60);
    expect(result.totals.metrics.reference_cost_usd).toBe(null);
    expect(result.by_model).toContainEqual(expect.objectContaining({
      provider: "unknown",
      backend: "unknown",
      model: null,
      attribution: "provider",
    }));
  });

  it("keeps material occurrences, known zero, null, harness, and tool calls separate", () => {
    const first = materialRow(30, "input/user", 0);
    const duplicate = materialRow(30, "input/user", 0);
    const secondOccurrence = materialRow(31, "input/user", 2);
    const unobserved = materialRow(32, "input/hidden", null);
    const observedZero = materialRow(33, "input/observed-zero", 0);
    const usage = usageRow({
      fact: fact({ input_total: 5000, total_tokens: 5020 }),
    });
    const result = buildSessionStatisticsMaterial(
      read([first, duplicate, secondOccurrence, unobserved, observedZero, usage, toolCallRow(40)]),
      "2026-10-19",
    );

    expect(result.input_material.observed_approximate_tokens).toBe(2);
    expect(result.input_material.parts).toContainEqual({
      category: "user_prompt",
      source_key: "input/user",
      approximate_tokens: 2,
      share: 1,
      measurement: "estimate",
    });
    expect(result.input_material.parts).toContainEqual({
      category: "user_prompt",
      source_key: "input/hidden",
      approximate_tokens: null,
      share: null,
      measurement: "unobserved",
    });
    expect(result.input_material.parts).toContainEqual({
      category: "user_prompt",
      source_key: "input/observed-zero",
      approximate_tokens: 0,
      share: 0,
      measurement: "estimate",
    });
    expect(result.input_material.parts.filter((part) => part.category === "harness_internal")).toHaveLength(1);
    expect(result.input_material.calibration).toEqual({
      status: "not_comparable",
      sample_count: 0,
      factor: null,
      reasons: ["missing_source_token_breakdown"],
    });
    expect(result.input_material.coverage).toEqual({
      complete_samples: 0,
      partial_samples: 1,
      manifest_only_samples: 0,
      missing_samples: 0,
    });
    expect(result.tool_calls).toBe(1);
  });

  it("filters day materials, tools, reasons, and samples by the current scope", () => {
    const otherStartBase = boundaryRow(11, "command_started", {
      usage_snapshot: { provider: "codex", requested_model: "gpt", backend: "codex" },
    });
    const otherStart = {
      ...otherStartBase,
      accounting_key: "command-2",
      fact: { ...otherStartBase.fact, accounting_key: "command-2" },
    };
    const otherMaterialBase = materialRow(31, "input/other", 7, {
      session_id: "session-1",
      accounting_key: "command-2",
      input_id: "input-2",
      quality: ["hidden_system_or_schema"],
    });
    const otherMaterial = {
      ...otherMaterialBase,
      accounting_key: "command-2",
      input_id: "input-2",
    };
    const otherUsage = usageRow({
      session_id: "session-2",
      selection_event_id: 32,
      owner_event_id: 32,
      input_id: "input-3",
      accounting_key: "command-3",
      fact: fact({
        session_id: "session-2",
        event_id: 32,
        input_id: "input-3",
        accounting_key: "command-3",
        provider: "claude",
        model: "sonnet",
      }),
    });
    const otherTool = {
      ...toolCallRow(40),
      accounting_key: "command-2",
      fact: fact({
        event_id: 40,
        part_key: "tool_call",
        fact_kind: "tool_call",
        accounting_key: "command-2",
        source_event_type: "tool_start",
        boundary_type: null,
      }),
    };
    const result = buildSessionStatisticsMaterial(read(
      [
        boundaryRow(10, "command_started", {
          usage_snapshot: { provider: "claude", requested_model: "sonnet", backend: "claude" },
        }),
        otherStart,
        materialRow(30, "input/selected", 5),
        otherMaterial,
        usageRow(),
        otherUsage,
        toolCallRow(39),
        otherTool,
      ],
      { provider: "claude", model: "sonnet", project_ids: ["project-1"] },
      new Map(),
      [
        { sessionId: "session-1", folderId: "folder-1", cardFolderId: null, projectId: "project-1", projectLabel: "Project 1" },
        { sessionId: "session-2", folderId: "folder-2", cardFolderId: null, projectId: "project-2", projectLabel: "Project 2" },
      ],
    ), "2026-10-19");

    expect(result.input_material.observed_approximate_tokens).toBe(5);
    expect(result.input_material.calibration.reasons).not.toContain("hidden_system_or_schema");
    expect(result.input_material.coverage.missing_samples).toBe(0);
    expect(result.tool_calls).toBe(1);
  });

  it("filters command materials and tools by the terminal owner's actual model", () => {
    const rows = [
      boundaryRow(10, "command_started", {
        usage_snapshot: { provider: "claude", requested_model: "sonnet", backend: "claude" },
      }),
      usageRow({ fact: fact({ model: "opus" }) }),
      materialRow(30, "input/actual-model", 5, { quality: ["replayed_history"] }),
      toolCallRow(40),
    ];
    const actual = buildDay(read(rows, { provider: "claude", model: "opus" }), "2026-10-19");
    const requested = buildDay(read(rows, { provider: "claude", model: "sonnet" }), "2026-10-19");

    expect(actual.totals.metrics.total_tokens).toBe(120);
    expect(actual.input_material.observed_approximate_tokens).toBe(5);
    expect(actual.tool_calls).toBe(1);
    expect(actual.input_material.coverage).toMatchObject({ partial_samples: 1, missing_samples: 0 });
    expect(actual.input_material.calibration.reasons).toContain("replayed_history");
    expect(requested.totals.metrics.total_tokens).toBe(null);
    expect(requested.input_material.observed_approximate_tokens).toBe(null);
    expect(requested.tool_calls).toBe(0);
    expect(requested.input_material.coverage).toMatchObject({ partial_samples: 0, missing_samples: 0 });
    expect(requested.input_material.calibration.reasons).not.toContain("replayed_history");
  });

  it("assigns command materials and tools across midnight to their terminal owner's day", () => {
    const ownDate = "2026-10-19T14:59:00.000Z";
    const ownerDate = "2026-10-19T15:01:00.000Z";
    const ownedTool = toolCallRow(40);
    const legacyMaterial = materialRow(31, "input/legacy", 7, {
      accounting_key: null,
      input_id: "legacy-input",
      recorded_at: ownDate,
      quality: ["hidden_system_or_schema"],
    });
    const legacyTool = toolCallRow(41);
    const result = read([
      usageRow({ owner_recorded_at: ownerDate, fact: fact({ recorded_at: ownerDate }) }),
      { ...materialRow(30, "input/owned", 5, { recorded_at: ownDate, quality: ["replayed_history"] }),
        owner_recorded_at: ownDate },
      { ...ownedTool, owner_recorded_at: ownDate, fact: { ...ownedTool.fact, recorded_at: ownDate } },
      { ...legacyMaterial, accounting_key: null, input_id: "legacy-input", owner_recorded_at: ownDate },
      { ...legacyTool, accounting_key: null, input_id: "legacy-input", owner_recorded_at: ownDate,
        fact: { ...legacyTool.fact, accounting_key: null, input_id: "legacy-input", recorded_at: ownDate } },
    ]);
    const ownerDay = buildDay(result, "2026-10-20");
    const ownDay = buildDay(result, "2026-10-19");

    expect(ownerDay.totals.metrics.total_tokens).toBe(120);
    expect(ownerDay.input_material.observed_approximate_tokens).toBe(5);
    expect(ownerDay.tool_calls).toBe(1);
    expect(ownerDay.input_material.coverage).toMatchObject({ partial_samples: 1, missing_samples: 0 });
    expect(ownerDay.input_material.calibration.reasons).toContain("replayed_history");
    expect(ownerDay.input_material.calibration.reasons).not.toContain("hidden_system_or_schema");
    expect(ownDay.totals.metrics.total_tokens).toBe(null);
    expect(ownDay.input_material.observed_approximate_tokens).toBe(7);
    expect(ownDay.tool_calls).toBe(1);
    expect(ownDay.input_material.coverage).toMatchObject({ partial_samples: 1, missing_samples: 0 });
    expect(ownDay.input_material.calibration.reasons).toContain("hidden_system_or_schema");
    expect(ownDay.input_material.calibration.reasons).not.toContain("replayed_history");
  });

  it("counts a model-part sample without material once by command", () => {
    const first = usageRow();
    const second = usageRow({
      fact: fact({ part_key: "usage:model/sonnet", representation: "model_breakdown" }),
    });
    const result = buildSessionStatisticsMaterial(read([first, second]), "2026-10-19");

    expect(result.input_material.coverage.missing_samples).toBe(1);
  });

  it("does not let one command's material cover another command in the same input", () => {
    const secondCommand = usageRow({
      selection_event_id: 21,
      owner_event_id: 21,
      input_id: "input-1",
      accounting_key: "command-2",
      fact: fact({
        event_id: 21,
        input_id: "input-1",
        accounting_key: "command-2",
      }),
    });
    const result = buildSessionStatisticsMaterial(
      read([materialRow(30, "input/first-command", 5), usageRow(), secondCommand]),
      "2026-10-19",
    );

    expect(result.input_material.coverage.missing_samples).toBe(1);
  });

  it("builds empty unknown periods as null metrics and no series", () => {
    const empty = read([], {}, new Map(), []);
    const overview = buildOverview(empty);
    const day = buildDay(empty, "2026-10-19");

    expect(overview.generated_at).toBe("2026-10-20T00:00:00.000Z");
    expect(overview.totals.metrics).toEqual({
      input_total: null,
      cache_read: null,
      cache_write: null,
      output_total: null,
      reasoning_output: null,
      total_tokens: null,
      reference_cost_usd: null,
    });
    expect(overview.totals.is_partial).toBe(true);
    expect(overview.series).toEqual([]);
    expect(day.input_material.observed_approximate_tokens).toBe(null);
    expect(day.input_material.parts.filter((part) => part.category === "harness_internal")).toHaveLength(1);
  });

  it("preserves a known command when the same input has one missing command", () => {
    const result = buildOverview(read([
      boundaryRow(10, "input"),
      usageRow(),
      missingRow({ selection_event_id: 21, candidate_event_id: 21 }),
    ]));

    expect(result.totals.metrics.total_tokens).toBe(120);
    expect(result.totals.metrics.reference_cost_usd).toBe(0.1);
    expect(result.totals.coverage.missing_usage_turns).toBe(1);
    expect(result.totals.coverage.unattributed_missing_usage).toBe(true);
  });

  it("keeps pending separate from missing while marking a known subtotal partial", () => {
    const pending = missingRow({ selection_event_id: 22, candidate_event_id: 22, state: "pending" });
    const result = buildOverview(read([usageRow(), pending]));

    expect(result.totals.metrics.total_tokens).toBe(120);
    expect(result.totals.metrics.reference_cost_usd).toBe(0.1);
    expect(result.totals.coverage.pending_inputs).toBe(1);
    expect(result.totals.coverage.missing_usage_turns).toBe(0);
    expect(result.totals.is_partial).toBe(true);
  });

  it("does not confirm a zero token or cost subtotal when missing or pending remains", () => {
    const zero = usageRow({
      fact: fact({
        input_total: 0,
        output_total: 0,
        total_tokens: 0,
        known_cost_usd: 0,
        priced_tokens: 0,
        unpriced_tokens: 0,
      }),
    });
    const zeroCost = new Map([[sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "0"]]);
    const observedZero = buildOverview(read([zero], {}, zeroCost));
    const missing = buildOverview(read([zero, missingRow()], {}, zeroCost));
    const pending = buildOverview(read([
      zero,
      missingRow({ selection_event_id: 22, candidate_event_id: 22, state: "pending", input_id: "input-2" }),
    ], {}, zeroCost));

    expect(observedZero.totals.metrics.total_tokens).toBe(0);
    expect(observedZero.totals.metrics.reference_cost_usd).toBe(0);
    expect(missing.totals.metrics.total_tokens).toBe(null);
    expect(missing.totals.metrics.reference_cost_usd).toBe(null);
    expect(missing.series.find((point) => point.project_id === "project-1" && point.bucket_start === "2026-10-19")?.metrics)
      .toMatchObject({ total_tokens: null, reference_cost_usd: null });
    expect(pending.totals.metrics.total_tokens).toBe(null);
    expect(pending.totals.metrics.reference_cost_usd).toBe(null);
  });

  it("uses null metrics in an empty bucket within a period that has known facts", () => {
    const result = buildOverview(read([usageRow()]));
    const projectSeries = result.series.filter((point) => point.project_id === "project-1");

    expect(projectSeries.map((point) => point.bucket_start)).toEqual(["2026-10-19", "2026-10-20"]);
    expect(projectSeries[0]?.metrics.total_tokens).toBe(120);
    expect(projectSeries[1]?.metrics.total_tokens).toBe(null);
  });

  it("builds an overview for thirty thousand sessions within two seconds", () => {
    const rowCount = 5_000;
    const sessionCount = 30_000;
    const rows = Array.from({ length: rowCount }, (_, index) => usageRow({
      session_id: `bulk-${index}`,
      selection_event_id: 100 + index,
      input_id: `bulk-input-${index}`,
      accounting_key: `bulk-command-${index}`,
      owner_event_id: 100 + index,
      fact: fact({
        session_id: `bulk-${index}`,
        event_id: 100 + index,
        input_id: `bulk-input-${index}`,
        accounting_key: `bulk-command-${index}`,
        known_cost_usd: null,
        priced_tokens: 0,
        unpriced_tokens: 120,
        pricing_complete: false,
      }),
    }));
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({
      sessionId: `bulk-${index}`,
      folderId: null,
      cardFolderId: null,
      projectId: "bulk-project",
      projectLabel: "Bulk",
    }));
    const expected = buildOverview(read(rows, {}, new Map(), sessions.slice(0, rowCount)));
    const started = Date.now();
    const result = buildOverview(read(rows, {}, new Map(), sessions));
    const elapsedMs = Date.now() - started;

    expect(result).toEqual(expected);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("calls repository provider and read exactly once per service method", async () => {
    const empty = read([], {}, new Map(), []);
    const repository = { read: vi.fn(async () => empty) };
    const provider = vi.fn(async () => repository);
    const service = new SessionStatisticsService(provider);

    await service.getOverview({ query: { period: "week", anchor: "2026-10-19" } } as never);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(repository.read).toHaveBeenCalledTimes(1);

    const dayRequest = { query: { period: "week", anchor: "2026-10-19" }, day: "2026-10-19" };
    const day = await service.getDay(dayRequest as never);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(repository.read).toHaveBeenCalledTimes(2);
    expect(repository.read).toHaveBeenLastCalledWith(dayRequest);
    expect(day.date).toBe(dayRequest.day);
  });
});
