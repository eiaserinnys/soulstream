export interface NodeCpuMetrics {
  usagePercent: number;
  cores: number;
  loadAvg1m: number | null;
}

export interface NodeMemoryMetrics {
  usagePercent: number;
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
}

export interface NodeDiskMetrics {
  path: string;
  usagePercent: number;
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
}

export interface NodeDiskQueueMetrics {
  device: string;
  inFlight: number;
  avgQueueDepth: number;
  busyPercent: number;
}

export interface NodeResourceSnapshot {
  collectedAt: string;
  cpu: NodeCpuMetrics;
  memory: NodeMemoryMetrics;
  disk: NodeDiskMetrics | null;
  diskQueue: NodeDiskQueueMetrics | null;
}

export function parseNodeResourceSnapshot(value: unknown): NodeResourceSnapshot | undefined {
  if (!isRecord(value) || typeof value.collectedAt !== "string") return undefined;
  const cpu = parseCpu(value.cpu);
  const memory = parseMemory(value.memory);
  const disk = value.disk === null ? null : parseDisk(value.disk);
  const diskQueue = value.diskQueue === null ? null : parseDiskQueue(value.diskQueue);
  if (!cpu || !memory || disk === undefined || diskQueue === undefined) return undefined;
  return {
    collectedAt: value.collectedAt,
    cpu,
    memory,
    disk,
    diskQueue,
  };
}

function parseCpu(value: unknown): NodeCpuMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const usagePercent = finiteNumber(value.usagePercent);
  const cores = finiteNumber(value.cores);
  const loadAvg1m = value.loadAvg1m === null ? null : finiteNumber(value.loadAvg1m);
  if (usagePercent === undefined || cores === undefined || loadAvg1m === undefined) {
    return undefined;
  }
  return { usagePercent, cores, loadAvg1m };
}

function parseMemory(value: unknown): NodeMemoryMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const usagePercent = finiteNumber(value.usagePercent);
  const usedBytes = finiteNumber(value.usedBytes);
  const availableBytes = finiteNumber(value.availableBytes);
  const totalBytes = finiteNumber(value.totalBytes);
  if (
    usagePercent === undefined
    || usedBytes === undefined
    || availableBytes === undefined
    || totalBytes === undefined
  ) return undefined;
  return { usagePercent, usedBytes, availableBytes, totalBytes };
}

function parseDisk(value: unknown): NodeDiskMetrics | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return undefined;
  const usagePercent = finiteNumber(value.usagePercent);
  const usedBytes = finiteNumber(value.usedBytes);
  const availableBytes = finiteNumber(value.availableBytes);
  const totalBytes = finiteNumber(value.totalBytes);
  if (
    usagePercent === undefined
    || usedBytes === undefined
    || availableBytes === undefined
    || totalBytes === undefined
  ) return undefined;
  return { path: value.path, usagePercent, usedBytes, availableBytes, totalBytes };
}

function parseDiskQueue(value: unknown): NodeDiskQueueMetrics | undefined {
  if (!isRecord(value) || typeof value.device !== "string") return undefined;
  const inFlight = finiteNumber(value.inFlight);
  const avgQueueDepth = finiteNumber(value.avgQueueDepth);
  const busyPercent = finiteNumber(value.busyPercent);
  if (inFlight === undefined || avgQueueDepth === undefined || busyPercent === undefined) {
    return undefined;
  }
  return { device: value.device, inFlight, avgQueueDepth, busyPercent };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
