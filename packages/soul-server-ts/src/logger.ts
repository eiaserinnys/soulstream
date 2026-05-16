import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * pino logger 인스턴스 생성.
 *
 * production 모드(stdout JSON)와 개발 모드(pretty)를 분리하지 *않고* 단일 JSON 출력만 한다 —
 * Haniel에 의해 stdout이 그대로 로그 파일로 수집되므로 pretty 변환은 후처리 단계의 책임.
 */
export function createLogger(level: string = "info"): Logger {
  const options: LoggerOptions = {
    level,
    base: undefined, // pid/hostname 기본 필드 제거 — Haniel이 따로 노드 식별 함
  };
  return pino(options);
}
