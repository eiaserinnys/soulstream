"""test_jwt_picture_default — R-2 JWT picture 조건부 키 회귀.

R-2 fix(2026-05-10) — atom bfdf8f2f (G-1):
- `generate_token`이 user.picture가 truthy일 때만 payload에 박는다.
- 빈 문자열/None은 payload 키 자체 미포함.
- 키 부재 vs 빈 문자열 의미 분리 — build_browser_caller_info의 truthy 필터가
  빈 문자열 picture를 wire에 키 부재로 떨구던 결함을 닫는다.
"""
from soul_common.auth.jwt import generate_token, verify_token


_SECRET = "test-secret-key-for-jwt-32bytes-aaaaaaaa"


class TestPictureConditionalKey:
    def test_picture_truthy_promoted_to_payload(self):
        """picture truthy → payload에 박힘."""
        user = {
            "sub": "u1",
            "email": "alice@example.com",
            "name": "Alice",
            "picture": "https://lh3.googleusercontent.com/alice.jpg",
        }
        token = generate_token(user, _SECRET)
        payload = verify_token(token, _SECRET)
        assert payload["picture"] == "https://lh3.googleusercontent.com/alice.jpg"

    def test_picture_missing_key_absent_from_payload(self):
        """user에 picture 키 없음 → payload에 키 자체 부재 (R-2)."""
        user = {"sub": "u2", "email": "bob@example.com", "name": "Bob"}
        token = generate_token(user, _SECRET)
        payload = verify_token(token, _SECRET)
        assert "picture" not in payload

    def test_picture_empty_string_absent_from_payload(self):
        """user.picture가 빈 문자열 → payload에 키 자체 부재 (R-2 핵심)."""
        user = {
            "sub": "u3",
            "email": "carol@example.com",
            "name": "Carol",
            "picture": "",
        }
        token = generate_token(user, _SECRET)
        payload = verify_token(token, _SECRET)
        assert "picture" not in payload, (
            "빈 문자열 picture는 payload에 박지 않아야 한다 — "
            "build_browser_caller_info의 truthy 필터가 wire에서 키를 떨구는 G-1 회로 차단."
        )

    def test_picture_none_absent_from_payload(self):
        """user.picture가 None → payload에 키 자체 부재."""
        user = {
            "sub": "u4",
            "email": "dave@example.com",
            "name": "Dave",
            "picture": None,
        }
        token = generate_token(user, _SECRET)
        payload = verify_token(token, _SECRET)
        assert "picture" not in payload

    def test_email_and_name_always_present(self):
        """picture 부재해도 email/name은 박힘 (다른 필드 회귀 보존)."""
        user = {"sub": "u5", "email": "min@example.com"}
        token = generate_token(user, _SECRET)
        payload = verify_token(token, _SECRET)
        assert payload["email"] == "min@example.com"
        assert payload["sub"] == "min@example.com"
        # name도 graceful default ""
        assert payload["name"] == ""
        assert "picture" not in payload
