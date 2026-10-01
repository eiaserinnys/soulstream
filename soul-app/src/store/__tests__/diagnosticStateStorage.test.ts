import {
  bindSessionDiagnosticsSink,
  type SessionDiagnosticsSink,
} from "../../lib/session-diagnostics-api";
import { withDiagnosticStateStorage } from "../diagnosticStateStorage";

test("state storage records fixed operation codes without retaining keys or values", async () => {
  const calls: unknown[][] = [];
  let operationId = 0;
  bindSessionDiagnosticsSink({
    recordRoute: jest.fn(),
    recordModal: jest.fn(),
    recordSseConnection: jest.fn(),
    recordSseMessage: jest.fn(),
    recordStoreUpdate: jest.fn(),
    recordFeedRender: jest.fn(),
    beginOperation: (source, operationCode) => {
      calls.push(["begin", source, operationCode]);
      operationId += 1;
      return { id: operationId, startedAtMs: 1, startedAtMonotonicMs: 1 };
    },
    endOperation: (source, operationCode, operation, failed) => {
      calls.push(["end", source, operationCode, operation.id, failed]);
    },
  } as SessionDiagnosticsSink);

  const storage = withDiagnosticStateStorage(
    {
      getItem: async () => "private-value",
      setItem: async () => undefined,
      removeItem: async () => undefined,
    },
    "auth",
  );

  try {
    await expect(storage.getItem("private-key")).resolves.toBe("private-value");
    await storage.setItem("private-key", "private-value");
    await storage.removeItem("private-key");
  } finally {
    bindSessionDiagnosticsSink(null);
  }

  expect(calls).toEqual([
    ["begin", "auth", 20],
    ["end", "auth", 20, 1, false],
    ["begin", "auth", 21],
    ["end", "auth", 21, 2, false],
    ["begin", "auth", 22],
    ["end", "auth", 22, 3, false],
  ]);
  expect(JSON.stringify(calls)).not.toContain("private");
});

test("state storage records failures and preserves the original rejection", async () => {
  const error = new Error("private storage failure");
  const endOperation = jest.fn();
  bindSessionDiagnosticsSink({
    recordRoute: jest.fn(),
    recordModal: jest.fn(),
    recordSseConnection: jest.fn(),
    recordSseMessage: jest.fn(),
    recordStoreUpdate: jest.fn(),
    recordFeedRender: jest.fn(),
    beginOperation: () => ({ id: 1, startedAtMs: 1, startedAtMonotonicMs: 1 }),
    endOperation,
  } as SessionDiagnosticsSink);

  try {
    const storage = withDiagnosticStateStorage(
      {
        getItem: async () => null,
        setItem: async () => {
          throw error;
        },
        removeItem: async () => undefined,
      },
      "settings",
    );
    await expect(storage.setItem("private-key", "private-value")).rejects.toBe(
      error,
    );
  } finally {
    bindSessionDiagnosticsSink(null);
  }

  expect(endOperation).toHaveBeenCalledWith(
    "settings",
    21,
    expect.objectContaining({ id: 1 }),
    true,
  );
});
