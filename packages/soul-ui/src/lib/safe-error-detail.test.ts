import { describe, expect, it } from "vitest";
import { safeErrorDetail } from "./safe-error-detail";

describe("safeErrorDetail", () => {
  it("allows only HTTP status and UUID request identity, never arbitrary source prose", () => {
    const requestId = "20990fda-07f5-41c9-a28c-d77eee98d251";
    const raw = `statusCode=403 request_id="${requestId}"\nAuthorization: Bearer auth-secret\nCookie: sid=cookie-secret\n{"password":"password-secret","token":"token-secret","api_key":"api-secret"}\nhttps://user-secret:pass-secret@example.test/?secret=query-secret\nunknown-field=unknown-secret`;
    const safe = safeErrorDetail(raw);
    expect(safe).toContain("HTTP 403");
    expect(safe).toContain(requestId);
    expect(safe).not.toContain("secret");
    expect(safe).not.toContain("example.test");
  });

  it("does not echo diagnostic-looking credential values or unstructured errors", () => {
    const text = safeErrorDetail("password=HTTP_TOKEN requestId=credential-value 오류 원문");
    expect(text).toBe("민감한 정보가 포함될 수 있어 오류 원문은 표시하지 않습니다.");
  });
});
