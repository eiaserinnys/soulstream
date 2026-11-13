import {
  EventAcknowledgementTimeoutError,
  EventOutboxDeadLetterError,
  EventOutboxQuarantinedError,
} from "../../upstream/event_outbox_pump_protocol.js";
import { isTerminalTaskStatus, type TaskStatus } from "../task_models.js";
import {
  RunnerAdoptionRejectedError,
  type RunnerAdoptionApplication,
} from "../runner_adoption_rejected_error.js";
import {
  decideNodeResponse,
  type NodeResponseDecision,
} from "./node_response_decision.js";
import {
  NODE_WIRE_REASONS,
  type NodeCentralSession,
  type NodeRegistrationMatch,
  type NodeResponseCall,
  type NodeResponseFacts,
  type NodeTerminationProjection,
  type NodeWireReason,
} from "./node_response_machine.js";

/**
 * 서버 응답을 받은 호출이 응답 칸 결정 함수에 주는 사실의 원천이다.
 * 운영 코드는 이 파일로 응답을 사실로 옮기고 결정 함수가 낸 정리 의도를 실행한다.
 */

/** 영구 거절 dead letter의 코드다. 낡은 등록이 보낸 사건을 서버가 바로 거절한 것이다. */
const STALE_REGISTRATION_CODE = "STALE_REGISTRATION";
/** 세션이 없어 거절된 dead letter의 코드다(옛 서버). */
const SESSION_NOT_FOUND_CODE = "SESSION_NOT_FOUND";
/** 같은 사건을 반복 실패로 거절한 dead letter에서 세션 없음이 reason 문장에 실린다. */
const SESSION_MISSING_MESSAGE = /session .* does not exist/i;

/** 응답 한 건을 사실로 옮길 때 호출자가 아는 것이다. */
export interface NodeResponseContext {
  call: NodeResponseCall;
  /** 보낸 사건의 등록 번호다. 없으면 등록 비교를 하지 않는다. */
  registrationId?: string | null;
  /** 종료 뒤 정상 보유 중인가. */
  retained?: boolean;
  /** 호출자가 중앙 세션 유무를 이미 확인했으면 그 값이다. */
  centralSession?: NodeCentralSession;
}

/** 전이 응답에서 노드 쪽이 읽는 칸이다(`EventSessionTransitionApplication`의 부분). */
export interface NodeTransitionApplication {
  eventId: number;
  applied: boolean;
  rejectionReason?: string;
  canonicalSession: { termination_event_id: number | null; status?: string };
  canonicalExecutionRegistration?: { registrationId: string } | null;
}

/** 응답 한 건의 사실과 그 결정이다. */
export interface NodeResponseVerdict {
  facts: NodeResponseFacts;
  decision: NodeResponseDecision;
}

export function judgeNodeResponse(facts: NodeResponseFacts): NodeResponseVerdict {
  return { facts, decision: decideNodeResponse(facts) };
}

function wireReason(reason: string | undefined): NodeWireReason {
  return (NODE_WIRE_REASONS as readonly string[]).includes(reason ?? "")
    ? (reason as NodeWireReason)
    : "none";
}

function centralSessionOf(
  context: NodeResponseContext,
  reason: NodeWireReason,
): NodeCentralSession {
  if (context.centralSession !== undefined) return context.centralSession;
  return reason === "session_missing" ? "absent" : "unknown";
}

/**
 * applied=false 응답(또는 등록 번호가 어긋난 응답)을 사실로 옮긴다.
 * 종료 호출은 정본 투영의 termination_event_id와 이 호출이 올린 사건 번호를 견준다.
 */
export function nodeResponseFactsFromApplication(
  context: NodeResponseContext,
  application: NodeTransitionApplication,
): NodeResponseFacts {
  const reason = wireReason(application.rejectionReason);
  const canonicalRegistration = application.canonicalExecutionRegistration;
  const registration: NodeRegistrationMatch =
    context.registrationId
    && canonicalRegistration
    && canonicalRegistration.registrationId !== context.registrationId
      ? "different"
      : "same";
  let termination: NodeTerminationProjection = "absent";
  if (context.call === "termination" || context.call === "resume_compensation_terminal") {
    const canonicalTermination = application.canonicalSession.termination_event_id;
    termination = canonicalTermination === null
      ? "absent"
      : canonicalTermination === application.eventId ? "same" : "different";
    // 서버가 스스로 닫은 세션(별건 7의 운영 꼴)은 사유도 종료 사건 번호도 없이 이미 끝난
    // 상태로 돌아온다. 정본 세션이 끝난 상태이면 다른 종료가 이미 있는 것으로 본다.
    // 정본 투영에 세션 상태가 없으면 이 판정을 하지 않는다.
    const canonicalStatus = application.canonicalSession.status;
    if (
      termination === "absent"
      && reason === "none"
      && canonicalStatus !== undefined
      && isTerminalTaskStatus(canonicalStatus as TaskStatus)
    ) {
      termination = "different";
    }
  }
  return {
    call: context.call,
    route: "applied_false",
    reason,
    registration,
    termination,
    centralSession: centralSessionOf(context, reason),
    retained: context.retained === true,
  };
}

/**
 * 응답 대신 던져진 오류를 사실로 옮긴다. 응답이 아닌 오류(전송 실패, 버그)는 undefined다.
 * 호출자는 그 오류를 그대로 다시 던진다.
 */
export function nodeResponseFactsFromError(
  context: NodeResponseContext,
  error: unknown,
): NodeResponseFacts | undefined {
  const base = {
    call: context.call,
    reason: "none" as const,
    registration: "same" as NodeRegistrationMatch,
    termination: "absent" as const,
    centralSession: context.centralSession ?? ("unknown" as NodeCentralSession),
    retained: context.retained === true,
  };
  if (error instanceof EventOutboxDeadLetterError) {
    const sessionMissing = error.code === SESSION_NOT_FOUND_CODE
      || SESSION_MISSING_MESSAGE.test(error.message);
    return {
      ...base,
      route: "dead_letter",
      registration: error.code === STALE_REGISTRATION_CODE ? "different" : "same",
      centralSession: sessionMissing ? "absent" : base.centralSession,
    };
  }
  if (error instanceof EventOutboxQuarantinedError) {
    return { ...base, route: "transport_quarantine" };
  }
  if (error instanceof EventAcknowledgementTimeoutError) {
    return { ...base, route: "no_response" };
  }
  return undefined;
}

/**
 * 거절 응답이 낸 결정을 들고 호출 흐름을 되돌리는 오류다.
 * 실행 시도를 그만두는 호출(등록, 재개, 첫 메시지)이 던지고 실패 처리 한 곳이 읽는다.
 */
export class NodeResponseRejectedError extends Error {
  constructor(
    readonly verdict: NodeResponseVerdict,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeResponseRejectedError";
  }
}

/** 던져진 오류에서 거절의 결정을 꺼낸다. 거절이 아니면 undefined다. */
export function nodeResponseRejection(error: unknown): NodeResponseVerdict | undefined {
  return error instanceof NodeResponseRejectedError ? error.verdict : undefined;
}

/**
 * 이 거절을 받은 실행 시도가 중앙 상태를 오류로 덮어도 되는가.
 *
 * 영구 거절과 격리는 결정 함수가 거절된 그 등록과 실행 명령에만 허락한다.
 * 다시 될 수 있는 거절은 다시 시도할 자리가 이 호출들에 없어 옛 동작대로 시도를 오류로
 * 끝내지만, 낡은 등록의 거절이나 중앙 세션이 없는 경우에는 새 실행의 상태를 덮지 않는다.
 */
export function mayMarkCentralError(verdict: NodeResponseVerdict): boolean {
  const { decision, facts } = verdict;
  if ((decision.intents as readonly string[]).includes("mark_central_error")) return true;
  return decision.cell === "retryable"
    && facts.registration === "same"
    && facts.centralSession !== "absent";
}

/** 잇기 응답이 싣는 거절 분류다. 사유만으로 가를 수 없는 거절(dead letter, 격리, 낡은 등록)이 쓴다. */
export type AdoptResponseClass = "retryable_rejection" | "terminal_rejection";

/** 응답 칸 결정 함수가 가른 분류를 더한 잇기 응답이다. */
export type NodeAdoptionApplication = RunnerAdoptionApplication & {
  response?: AdoptResponseClass;
};

/** 응답 칸 결정 함수가 가른 분류를 더한 잇기 거절 오류다. */
export class NodeAdoptionRejectedError extends RunnerAdoptionRejectedError {
  constructor(
    sessionId: string,
    rejectionReason: string | undefined,
    readonly response: AdoptResponseClass,
    options?: ErrorOptions,
  ) {
    super(sessionId, rejectionReason, options);
  }
}

/** 잇기 거절을 러너 쪽 응답 분류로 옮긴다. 거둘 수 없는 거절(낡은 등록)은 다시 될 수 있음으로 둔다. */
export function adoptResponseOfVerdict(
  verdict: NodeResponseVerdict,
): AdoptResponseClass {
  const { decision, facts } = verdict;
  if (decision.cell === "retryable" || decision.cell === "applied") {
    return "retryable_rejection";
  }
  return facts.registration === "different"
    ? "retryable_rejection"
    : "terminal_rejection";
}
