/** MCP 중앙 설정 저장소가 던지는 유일한 오류 꼴. 라우트는 code와 statusCode만 쓴다. */
export class McpCentralError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "McpCentralError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function invalidInput(message: string): McpCentralError {
  return new McpCentralError("MCP_INVALID_INPUT", 400, message);
}

export function notFound(code: string, message: string): McpCentralError {
  return new McpCentralError(code, 404, message);
}

export function conflict(code: string, message: string): McpCentralError {
  return new McpCentralError(code, 409, message);
}
