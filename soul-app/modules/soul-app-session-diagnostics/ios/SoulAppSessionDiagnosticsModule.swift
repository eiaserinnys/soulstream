import ExpoModulesCore
import MetricKit
import UIKit

public final class SoulAppSessionDiagnosticsModule: Module {
  private let recorder = NativeDiagnosticsRecorder.shared

  public func definition() -> ModuleDefinition {
    Name("SoulAppSessionDiagnostics")

    OnCreate {
      self.recorder.start()
    }

    AsyncFunction("readPendingRecords") { () async -> String in
      await self.recorder.readPendingRecordsJSON()
    }

    AsyncFunction("acknowledgeRecords") { (ids: [String]) async -> Bool in
      await self.recorder.acknowledgeRecords(ids: ids)
    }

    Function("startMainThreadProbe") {
      self.recorder.startMainThreadProbe()
    }

    Function("stopMainThreadProbe") {
      self.recorder.stopMainThreadProbe()
    }
  }
}

private struct NativeStackFrame: Codable {
  let binary: String
  let binaryUuid: String?
  let offset: Double?
  let sampleCount: Int?
}

private struct NativeDiagnosticRecord: Codable {
  let id: String
  let processId: String
  let timestampMs: Double
  let kind: String
  let source: String
  var operationId: Int? = nil
  var value: Double? = nil
  var osVersion: String? = nil
  let phase: String?
  let state: String?
  let platform: String?
  let diagnosticType: String?
  let appVersion: String?
  let buildNumber: String?
  let durationMs: Double?
  let windowStartMs: Double?
  let windowEndMs: Double?
  let count: Int?
  let failed: Bool?
  var stackTruncated: Bool? = nil
  var terminationReason: String? = nil
  var exceptionType: Int? = nil
  var signal: Int? = nil
  let stackFrames: [NativeStackFrame]?
}

private final class NativeDiagnosticsRecorder: NSObject, MXMetricManagerSubscriber {
  static let shared = NativeDiagnosticsRecorder()

  private static let maxRecords = 64
  private static let maxFileBytes = 16 * 1024
  private static let maxRecordAgeMs: Double = 72 * 60 * 60 * 1000
  private static let maxStackFrames = 16
  private static let maxCrashStackFrames = 20
  private static let probeInterval: TimeInterval = 1
  private static let probeTimeout: TimeInterval = 1.5
  private static let probeBucketInterval: TimeInterval = 5

  private let storageQueue = DispatchQueue(
    label: "me.soul-app.session-diagnostics.storage",
    qos: .utility
  )
  private let probeQueue = DispatchQueue(
    label: "me.soul-app.session-diagnostics.probe",
    qos: .utility
  )
  private let foregroundLock = NSLock()
  private var foregroundActive = false
  private var records: [NativeDiagnosticRecord] = []
  private var droppedCount = 0
  private var loaded = false
  private var started = false
  private var currentProcessId = UUID().uuidString.lowercased()
  private var observers: [NSObjectProtocol] = []
  private var nativeOperationSequence = 0
  private var pendingStorageCompletion: NativeDiagnosticRecord?

  private var probeTimer: DispatchSourceTimer?
  private var probeActive = false
  private var outstandingProbe: (id: String, startedAt: TimeInterval)?
  private var pendingMainProbeId: String?
  private var probeBucketStartedAtMs = Date().timeIntervalSince1970 * 1000
  private var probeCount = 0
  private var maxResponseMs = 0.0
  private var timeoutCount = 0

  private var storageURL: URL? {
    guard let root = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first else {
      return nil
    }
    return root
      .appendingPathComponent("SessionDiagnostics", isDirectory: true)
      .appendingPathComponent("native-outbox.json", isDirectory: false)
  }

  func start() {
    guard !started else { return }
    started = true
    currentProcessId = UUID().uuidString.lowercased()
    storageQueue.async { [weak self] in
      self?.loadFromDisk()
    }
    MXMetricManager.shared.add(self)

    observe(UIApplication.willResignActiveNotification, state: "will_resign_active") { recorder in
      recorder.stopMainThreadProbe()
    }
    observe(UIApplication.didEnterBackgroundNotification, state: "did_enter_background")
    observe(UIApplication.willEnterForegroundNotification, state: "will_enter_foreground")
    observe(UIApplication.didBecomeActiveNotification, state: "did_become_active") { recorder in
      recorder.startMainThreadProbe()
    }
    observe(UIApplication.willTerminateNotification, state: "will_terminate") { recorder in
      recorder.stopMainThreadProbe()
    }

    DispatchQueue.main.async { [weak self] in
      guard UIApplication.shared.applicationState == .active else { return }
      self?.setForegroundActive(true)
      self?.startMainThreadProbe()
    }
  }

  func readPendingRecordsJSON() async -> String {
    await withCheckedContinuation { continuation in
      storageQueue.async { [weak self] in
        guard let self else {
          continuation.resume(returning: "{\"droppedCount\":0,\"records\":[]}")
          return
        }
        self.loadFromDisk()
        self.pruneExpiredRecords()
        let payload: [String: Any] = [
          "processId": self.currentProcessId,
          "droppedCount": self.droppedCount,
          "records": self.records.map { $0.dictionary },
        ]
        guard
          let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8)
        else {
          continuation.resume(returning: "{\"droppedCount\":0,\"records\":[]}")
          return
        }
        continuation.resume(returning: json)
      }
    }
  }

  func acknowledgeRecords(ids: [String]) async -> Bool {
    await withCheckedContinuation { continuation in
      storageQueue.async { [weak self] in
        guard let self else {
          continuation.resume(returning: false)
          return
        }
        self.loadFromDisk()
        let idsToRemove = Set(ids)
        guard !idsToRemove.isEmpty else {
          continuation.resume(returning: true)
          return
        }
        var nextRecords = self.records
        self.appendPendingStorageCompletion(to: &nextRecords)
        nextRecords.removeAll { idsToRemove.contains($0.id) }
        self.enforceBounds(&nextRecords)
        if self.persistAndRecordStorageCompletion(records: nextRecords) {
          continuation.resume(returning: true)
        } else {
          continuation.resume(returning: false)
        }
      }
    }
  }

  func startMainThreadProbe() {
    setForegroundActive(true)
    probeQueue.async { [weak self] in
      guard let self, !self.probeActive else { return }
      self.probeActive = true
      self.append(self.probeStateRecord(phase: "begin", state: "active"))
      self.probeBucketStartedAtMs = Date().timeIntervalSince1970 * 1000
      self.probeCount = 0
      self.maxResponseMs = 0
      self.timeoutCount = 0

      let timer = DispatchSource.makeTimerSource(queue: self.probeQueue)
      timer.schedule(
        deadline: .now() + Self.probeInterval,
        repeating: Self.probeInterval,
        leeway: .milliseconds(100)
      )
      timer.setEventHandler { [weak self] in
        self?.probeTick()
      }
      self.probeTimer = timer
      timer.resume()
    }
  }

  func stopMainThreadProbe() {
    setForegroundActive(false)
    probeQueue.async { [weak self] in
      guard let self, self.probeActive else { return }
      self.probeActive = false
      self.probeTimer?.cancel()
      self.probeTimer = nil
      self.outstandingProbe = nil
      self.persistProbeBucket()
      self.append(self.probeStateRecord(phase: "end", state: "inactive"))
    }
  }

  func didReceive(_ payload: MXMetricPayload) {
    // Daily aggregate metrics are outside this feature's diagnostic contract.
  }

  func didReceive(_ payload: MXDiagnosticPayload) {
    let startMs = payload.timeStampBegin.timeIntervalSince1970 * 1000
    let endMs = payload.timeStampEnd.timeIntervalSince1970 * 1000
    for hang in payload.hangDiagnostics ?? [] {
      let stack = sanitizedFrames(
        from: hang.callStackTree.jsonRepresentation(),
        maxFrames: Self.maxStackFrames
      )
      append(NativeDiagnosticRecord(
        id: UUID().uuidString.lowercased(),
        processId: currentProcessId,
        timestampMs: endMs,
        kind: "native_hang",
        source: "metrickit",
        osVersion: Self.safeOsVersion(hang.metaData.osVersion),
        phase: "end",
        state: nil,
        platform: "native",
        diagnosticType: "hang",
        appVersion: Self.safeVersion(hang.applicationVersion),
        buildNumber: Self.safeVersion(hang.metaData.applicationBuildVersion),
        durationMs: hang.hangDuration.converted(to: .milliseconds).value,
        windowStartMs: startMs,
        windowEndMs: endMs,
        count: nil,
        failed: nil,
        stackTruncated: stack.truncated,
        stackFrames: stack.frames
      ))
    }
    for crash in payload.crashDiagnostics ?? [] {
      let stack = sanitizedFrames(
        from: crash.callStackTree.jsonRepresentation(),
        maxFrames: Self.maxCrashStackFrames
      )
      var record = NativeDiagnosticRecord(
        id: UUID().uuidString.lowercased(),
        processId: currentProcessId,
        timestampMs: endMs,
        kind: "native_crash",
        source: "metrickit",
        osVersion: Self.safeOsVersion(crash.metaData.osVersion),
        phase: "end",
        state: nil,
        platform: "native",
        diagnosticType: "crash",
        appVersion: Self.safeVersion(crash.applicationVersion),
        buildNumber: Self.safeVersion(crash.metaData.applicationBuildVersion),
        durationMs: nil,
        windowStartMs: startMs,
        windowEndMs: endMs,
        count: nil,
        failed: nil,
        stackTruncated: stack.truncated,
        stackFrames: stack.frames
      )
      record.terminationReason = Self.safeTerminationReason(crash.terminationReason)
      record.exceptionType = crash.exceptionType?.intValue
      record.signal = crash.signal?.intValue
      append(record)
    }
  }

  private func observe(
    _ name: Notification.Name,
    state: String,
    action: ((NativeDiagnosticsRecorder) -> Void)? = nil
  ) {
    let observer = NotificationCenter.default.addObserver(
      forName: name,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.append(self.lifecycleRecord(state: state))
      action?(self)
    }
    observers.append(observer)
  }

  private func lifecycleRecord(state: String) -> NativeDiagnosticRecord {
    NativeDiagnosticRecord(
      id: UUID().uuidString.lowercased(),
      processId: currentProcessId,
      timestampMs: Date().timeIntervalSince1970 * 1000,
      kind: "lifecycle",
      source: "native_lifecycle",
      phase: state.hasPrefix("will_") ? "begin" : "end",
      state: state,
      platform: "native",
      diagnosticType: nil,
      appVersion: nil,
      buildNumber: nil,
      durationMs: nil,
      windowStartMs: nil,
      windowEndMs: nil,
      count: nil,
      failed: nil,
      stackFrames: nil
    )
  }

  private func probeStateRecord(phase: String, state: String) -> NativeDiagnosticRecord {
    NativeDiagnosticRecord(
      id: UUID().uuidString.lowercased(),
      processId: currentProcessId,
      timestampMs: Date().timeIntervalSince1970 * 1000,
      kind: "native_main_probe",
      source: "native_probe",
      phase: phase,
      state: state,
      platform: "native",
      diagnosticType: nil,
      appVersion: nil,
      buildNumber: nil,
      durationMs: nil,
      windowStartMs: nil,
      windowEndMs: nil,
      count: nil,
      failed: nil,
      stackFrames: nil
    )
  }

  private func probeTick() {
    guard probeActive, isForegroundActive() else { return }
    let now = Date().timeIntervalSince1970 * 1000
    if now - probeBucketStartedAtMs >= Self.probeBucketInterval * 1000 {
      persistProbeBucket()
    }
    // A timed-out main-queue block may still be sitting behind a hung callback.
    // Keep at most one such block queued; timeout must not schedule an unbounded
    // stream of additional main-queue work.
    guard outstandingProbe == nil, pendingMainProbeId == nil else { return }

    let id = UUID().uuidString.lowercased()
    let start = ProcessInfo.processInfo.systemUptime
    outstandingProbe = (id, start)
    pendingMainProbeId = id
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.probeQueue.async { [weak self] in
        guard let self, self.pendingMainProbeId == id else { return }
        self.pendingMainProbeId = nil
        guard self.isForegroundActive(), self.outstandingProbe?.id == id else { return }
        self.outstandingProbe = nil
        let elapsed = max(0, (ProcessInfo.processInfo.systemUptime - start) * 1000)
        self.probeCount += 1
        self.maxResponseMs = max(self.maxResponseMs, elapsed)
      }
    }
    probeQueue.asyncAfter(deadline: .now() + Self.probeTimeout) { [weak self] in
      guard let self, self.isForegroundActive(), self.outstandingProbe?.id == id else { return }
      self.outstandingProbe = nil
      self.timeoutCount += 1
      self.append(NativeDiagnosticRecord(
        id: UUID().uuidString.lowercased(),
        processId: currentProcessId,
        timestampMs: Date().timeIntervalSince1970 * 1000,
        kind: "native_main_probe",
        source: "native_probe",
        phase: "timeout",
        state: "active",
        platform: "native",
        diagnosticType: nil,
        appVersion: nil,
        buildNumber: nil,
        durationMs: Self.probeTimeout * 1000,
        windowStartMs: nil,
        windowEndMs: nil,
        count: 1,
        failed: true,
        stackFrames: nil
      ))
    }
  }

  private func persistProbeBucket() {
    let endMs = Date().timeIntervalSince1970 * 1000
    guard probeCount > 0 || timeoutCount > 0 else {
      probeBucketStartedAtMs = endMs
      return
    }
    append(NativeDiagnosticRecord(
      id: UUID().uuidString.lowercased(),
      processId: currentProcessId,
      timestampMs: endMs,
      kind: "native_main_probe",
      source: "native_probe",
      phase: "bucket",
      state: "active",
      platform: "native",
      diagnosticType: nil,
      appVersion: nil,
      buildNumber: nil,
      durationMs: maxResponseMs,
      windowStartMs: probeBucketStartedAtMs,
      windowEndMs: endMs,
      count: probeCount,
      failed: timeoutCount > 0,
      stackFrames: nil
    ))
    probeBucketStartedAtMs = endMs
    probeCount = 0
    maxResponseMs = 0
    timeoutCount = 0
  }

  private func setForegroundActive(_ active: Bool) {
    foregroundLock.lock()
    foregroundActive = active
    foregroundLock.unlock()
  }

  private func isForegroundActive() -> Bool {
    foregroundLock.lock()
    defer { foregroundLock.unlock() }
    return foregroundActive
  }

  private func append(_ record: NativeDiagnosticRecord) {
    storageQueue.async { [weak self] in
      guard let self else { return }
      self.loadFromDisk()
      var nextRecords = self.records
      self.appendPendingStorageCompletion(to: &nextRecords)
      nextRecords.append(record)
      self.enforceBounds(&nextRecords)
      _ = self.persistAndRecordStorageCompletion(records: nextRecords)
    }
  }

  private func enforceBounds(_ nextRecords: inout [NativeDiagnosticRecord]) {
    expireGeneralRecords(from: &nextRecords)
    while nextRecords.count > Self.maxRecords {
      evictLowestPriorityRecord(from: &nextRecords)
    }
    while !fitsOnDisk(records: nextRecords, droppedCount: droppedCount), !nextRecords.isEmpty {
      evictLowestPriorityRecord(from: &nextRecords)
    }
  }

  private func expireGeneralRecords(from nextRecords: inout [NativeDiagnosticRecord]) {
    let cutoffMs = Date().timeIntervalSince1970 * 1000 - Self.maxRecordAgeMs
    let expired = nextRecords.filter {
      $0.timestampMs < cutoffMs && !$0.isProtectedDiagnostic
    }.count
    guard expired > 0 else { return }
    droppedCount += expired
    nextRecords.removeAll {
      $0.timestampMs < cutoffMs && !$0.isProtectedDiagnostic
    }
  }

  private func evictLowestPriorityRecord(from nextRecords: inout [NativeDiagnosticRecord]) {
    let index = nextRecords.firstIndex { !$0.isProtectedDiagnostic } ?? 0
    nextRecords.remove(at: index)
    droppedCount += 1
  }

  private func appendPendingStorageCompletion(to records: inout [NativeDiagnosticRecord]) {
    guard let pendingStorageCompletion else { return }
    records.append(pendingStorageCompletion)
    self.pendingStorageCompletion = nil
  }

  private func persistAndRecordStorageCompletion(records nextRecords: [NativeDiagnosticRecord]) -> Bool {
    nativeOperationSequence += 1
    let operationId = nativeOperationSequence
    let startedAtMs = Date().timeIntervalSince1970 * 1000
    let startedAtUptime = ProcessInfo.processInfo.systemUptime
    let didPersist = persist(records: nextRecords, droppedCount: droppedCount)
    let endedAtMs = Date().timeIntervalSince1970 * 1000
    records = nextRecords
    pendingStorageCompletion = NativeDiagnosticRecord(
      id: UUID().uuidString.lowercased(),
      processId: currentProcessId,
      timestampMs: endedAtMs,
      kind: "operation",
      source: "native_storage",
      operationId: operationId,
      value: 40,
      phase: "end",
      state: nil,
      platform: "native",
      diagnosticType: nil,
      appVersion: nil,
      buildNumber: nil,
      durationMs: max(0, (ProcessInfo.processInfo.systemUptime - startedAtUptime) * 1000),
      windowStartMs: startedAtMs,
      windowEndMs: endedAtMs,
      count: nil,
      failed: !didPersist,
      stackFrames: nil
    )
    return didPersist
  }

  private func loadFromDisk() {
    guard !loaded else { return }
    loaded = true
    guard let storageURL, let data = try? Data(contentsOf: storageURL) else { return }
    guard let decoded = try? JSONDecoder().decode(NativeOutbox.self, from: data) else { return }
    records = decoded.records
    droppedCount = decoded.droppedCount
    let previousDroppedCount = droppedCount
    expireGeneralRecords(from: &records)
    if droppedCount > previousDroppedCount {
      _ = persist(records: records, droppedCount: droppedCount)
    }
  }

  private func pruneExpiredRecords() {
    let previousDroppedCount = droppedCount
    expireGeneralRecords(from: &records)
    guard droppedCount > previousDroppedCount else { return }
    _ = persist(records: records, droppedCount: droppedCount)
  }

  private func persist(records: [NativeDiagnosticRecord], droppedCount: Int) -> Bool {
    guard let storageURL, let data = encode(records: records, droppedCount: droppedCount) else {
      return false
    }
    do {
      try FileManager.default.createDirectory(
        at: storageURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: storageURL, options: .atomic)
      return true
    } catch {
      return false
    }
  }

  private func fitsOnDisk(records: [NativeDiagnosticRecord], droppedCount: Int) -> Bool {
    guard let data = encode(records: records, droppedCount: droppedCount) else { return false }
    return data.count <= Self.maxFileBytes
  }

  private func encode(records: [NativeDiagnosticRecord], droppedCount: Int) -> Data? {
    try? JSONEncoder().encode(NativeOutbox(
      schemaVersion: 1,
      droppedCount: droppedCount,
      records: records
    ))
  }

  private func sanitizedFrames(
    from data: Data,
    maxFrames: Int
  ) -> (frames: [NativeStackFrame], truncated: Bool) {
    guard
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let tree = root["callStackTree"] as? [String: Any],
      let stacks = tree["callStacks"] as? [[String: Any]]
    else {
      return ([], false)
    }
    let selectedStack = stacks.first(where: { $0["threadAttributed"] as? Bool == true })
      ?? stacks.first
    guard let selectedStack else { return ([], false) }
    var frames: [NativeStackFrame] = []
    var truncated = false
    guard let roots = selectedStack["callStackRootFrames"] as? [[String: Any]] else {
      return ([], false)
    }
    for (index, frame) in roots.enumerated() {
      collect(frame, into: &frames, maxFrames: maxFrames, truncated: &truncated)
      if frames.count >= maxFrames {
        if index + 1 < roots.count { truncated = true }
        return (frames, truncated)
      }
    }
    return (frames, truncated)
  }

  private func collect(
    _ frame: [String: Any],
    into frames: inout [NativeStackFrame],
    maxFrames: Int,
    truncated: inout Bool
  ) {
    guard frames.count < maxFrames else {
      truncated = true
      return
    }
    let originalName = URL(fileURLWithPath: frame["binaryName"] as? String ?? "").lastPathComponent
    let safeBinary = Self.binaryClass(for: originalName)
    let offset = Self.numericOffset(frame["offsetIntoBinaryTextSegment"])
    let binaryUuid = Self.binaryUuid(frame["binaryUUID"])
    let sampleCount = (frame["sampleCount"] as? NSNumber)?.intValue
    frames.append(NativeStackFrame(
      binary: safeBinary,
      binaryUuid: binaryUuid,
      offset: offset,
      sampleCount: sampleCount.map { max(0, $0) }
    ))
    if let children = frame["subFrames"] as? [[String: Any]] {
      for (index, child) in children.enumerated() {
        collect(child, into: &frames, maxFrames: maxFrames, truncated: &truncated)
        if frames.count >= maxFrames {
          if index + 1 < children.count { truncated = true }
          return
        }
      }
    }
  }

  private static func binaryClass(for name: String) -> String {
    let value = name.lowercased()
    if
      let executable = Bundle.main.infoDictionary?["CFBundleExecutable"] as? String,
      value == executable.lowercased()
    {
      return "soul_app"
    }
    if value.contains("soul-app") { return "soul_app" }
    if value.contains("hermes") { return "hermes" }
    if value.contains("react") || value.contains("jsi") { return "react_native" }
    if value.contains("uikit") { return "uikit" }
    if value.contains("quartzcore") { return "quartz_core" }
    if value.contains("coreanimation") { return "core_animation" }
    if value.contains("coregraphics") { return "core_graphics" }
    if value.contains("corefoundation") { return "core_foundation" }
    if value.contains("swiftui") { return "swift_ui" }
    if value.contains("foundation") { return "foundation" }
    if value.contains("libdispatch") || value.contains("dispatch") { return "libdispatch" }
    if value.hasPrefix("libsystem_") ||
      value.hasPrefix("libswift") ||
      value.hasPrefix("libobjc") ||
      value.hasPrefix("libc++") {
      return "system_runtime"
    }
    return "other"
  }

  private static func binaryUuid(_ value: Any?) -> String? {
    guard
      let string = value as? String,
      let uuid = UUID(uuidString: string)
    else {
      return nil
    }
    return uuid.uuidString.lowercased()
  }

  private static func safeVersion(_ value: String) -> String? {
    guard value.range(of: "^[A-Za-z0-9.+_-]{1,32}$", options: .regularExpression) != nil else {
      return nil
    }
    return value
  }

  private static func safeTerminationReason(_ value: String?) -> String? {
    guard let value else { return nil }
    let firstLine = value.components(separatedBy: .newlines).first ?? value
    guard
      firstLine.count <= 256,
      firstLine.range(of: "^[A-Za-z0-9 _.,:;()/+\\-<>|=@]+$", options: .regularExpression) != nil
    else {
      return nil
    }
    return firstLine
  }

  private static func safeOsVersion(_ value: String) -> String? {
    guard let range = value.range(
      of: "(?<![0-9.])[0-9]{1,3}(?:\\.[0-9]{1,3}){1,3}(?:[ ]*\\([A-Za-z0-9.]{1,16}\\))?(?![0-9.])",
      options: .regularExpression
    ) else {
      return nil
    }
    return String(value[range]).replacingOccurrences(of: " ", with: "")
  }

  private static func numericOffset(_ value: Any?) -> Double? {
    let maxSafeInteger = 9_007_199_254_740_991.0
    if let number = value as? NSNumber {
      let parsed = number.doubleValue
      guard parsed.isFinite, parsed >= 0, parsed <= maxSafeInteger else { return nil }
      return parsed
    }
    guard let string = value as? String else { return nil }
    let normalized = string.lowercased().hasPrefix("0x")
      ? String(string.dropFirst(2))
      : string
    guard
      normalized.allSatisfy({ $0.isHexDigit }),
      let parsed = UInt64(normalized, radix: 16),
      parsed <= UInt64(maxSafeInteger)
    else {
      return nil
    }
    return Double(parsed)
  }
}

private struct NativeOutbox: Codable {
  let schemaVersion: Int
  let droppedCount: Int
  let records: [NativeDiagnosticRecord]
}

private extension NativeDiagnosticRecord {
  var isProtectedDiagnostic: Bool {
    kind == "native_crash" || kind == "native_hang"
  }

  var dictionary: [String: Any] {
    var value: [String: Any] = [
      "id": id,
      "processId": processId,
      "timestampMs": timestampMs,
      "kind": kind,
      "source": source,
    ]
    if let phase { value["phase"] = phase }
    if let state { value["state"] = state }
    if let platform { value["platform"] = platform }
    if let diagnosticType { value["diagnosticType"] = diagnosticType }
    if let terminationReason { value["terminationReason"] = terminationReason }
    if let exceptionType { value["exceptionType"] = exceptionType }
    if let signal { value["signal"] = signal }
    if let operationId { value["operationId"] = operationId }
    if let eventValue = self.value { value["value"] = eventValue }
    if let osVersion { value["osVersion"] = osVersion }
    if let appVersion { value["appVersion"] = appVersion }
    if let buildNumber { value["buildNumber"] = buildNumber }
    if let durationMs { value["durationMs"] = durationMs }
    if let windowStartMs { value["windowStartMs"] = windowStartMs }
    if let windowEndMs { value["windowEndMs"] = windowEndMs }
    if let count { value["count"] = count }
    if let failed { value["failed"] = failed }
    if let stackTruncated { value["stackTruncated"] = stackTruncated }
    if let stackFrames {
      value["stackFrames"] = stackFrames.map { frame in
        var result: [String: Any] = ["binary": frame.binary]
        if let binaryUuid = frame.binaryUuid { result["binaryUuid"] = binaryUuid }
        if let offset = frame.offset { result["offset"] = offset }
        if let sampleCount = frame.sampleCount { result["sampleCount"] = sampleCount }
        return result
      }
    }
    return value
  }
}
