"""
test_config - 환경변수 파싱 및 Settings 로드 테스트

_parse_int/_parse_float가 잘못된 값에 즉시 ValueError를 내는지 검증합니다.
"""

import os
import pytest

from soul_server.config import _parse_int, _parse_float, Settings


class TestParseInt:
    def test_valid_integer(self):
        """정상 정수 문자열은 int로 반환"""
        assert _parse_int("42", "SOME_VAR") == 42

    def test_valid_negative_integer(self):
        """음수 정수도 정상 파싱"""
        assert _parse_int("-10", "SOME_VAR") == -10

    def test_valid_zero(self):
        """0은 정상 파싱"""
        assert _parse_int("0", "SOME_VAR") == 0

    def test_invalid_string_raises(self):
        """알파벳 문자열 → ValueError 즉시 발생"""
        with pytest.raises(ValueError) as exc_info:
            _parse_int("abc", "PORT")
        assert "PORT" in str(exc_info.value)
        assert "abc" in str(exc_info.value)

    def test_empty_string_raises(self):
        """빈 문자열 → ValueError 즉시 발생"""
        with pytest.raises(ValueError) as exc_info:
            _parse_int("", "MAX_CONCURRENT_SESSIONS")
        assert "MAX_CONCURRENT_SESSIONS" in str(exc_info.value)

    def test_float_string_raises(self):
        """소수점 문자열 → int 변환 불가 → ValueError 즉시 발생"""
        with pytest.raises(ValueError) as exc_info:
            _parse_int("3.14", "RUNNER_POOL_MAX_SIZE")
        assert "RUNNER_POOL_MAX_SIZE" in str(exc_info.value)

    def test_error_message_includes_expected_type(self):
        """에러 메시지에 'integer' 안내 포함"""
        with pytest.raises(ValueError) as exc_info:
            _parse_int("bad", "HEALTH_CHECK_INTERVAL")
        assert "integer" in str(exc_info.value)


class TestParseFloat:
    def test_valid_float(self):
        """정상 소수 문자열은 float로 반환"""
        assert _parse_float("3.14", "SOME_VAR") == pytest.approx(3.14)

    def test_valid_integer_as_float(self):
        """정수 문자열도 float로 파싱"""
        assert _parse_float("300", "RUNNER_POOL_IDLE_TTL") == pytest.approx(300.0)

    def test_valid_negative_float(self):
        """음수 소수도 정상 파싱"""
        assert _parse_float("-0.5", "SOME_VAR") == pytest.approx(-0.5)

    def test_invalid_string_raises(self):
        """알파벳 문자열 → ValueError 즉시 발생"""
        with pytest.raises(ValueError) as exc_info:
            _parse_float("xyz", "RUNNER_POOL_IDLE_TTL")
        assert "RUNNER_POOL_IDLE_TTL" in str(exc_info.value)
        assert "xyz" in str(exc_info.value)

    def test_empty_string_raises(self):
        """빈 문자열 → ValueError 즉시 발생"""
        with pytest.raises(ValueError) as exc_info:
            _parse_float("", "RUNNER_POOL_MAINTENANCE_INTERVAL")
        assert "RUNNER_POOL_MAINTENANCE_INTERVAL" in str(exc_info.value)

    def test_error_message_includes_expected_type(self):
        """에러 메시지에 'float' 안내 포함"""
        with pytest.raises(ValueError) as exc_info:
            _parse_float("not-a-float", "RUNNER_POOL_IDLE_TTL")
        assert "float" in str(exc_info.value)


class TestSettingsFromEnv:
    def test_valid_env_loads(self, monkeypatch, tmp_path):
        """정상 환경변수로 Settings 로드 성공"""
        monkeypatch.setenv("WORKSPACE_DIR", str(tmp_path))
        monkeypatch.setenv("PORT", "8080")
        monkeypatch.setenv("MAX_CONCURRENT_SESSIONS", "5")
        monkeypatch.setenv("RUNNER_POOL_IDLE_TTL", "120.0")

        settings = Settings.from_env()

        assert settings.port == 8080
        assert settings.max_concurrent_sessions == 5
        assert settings.runner_pool_idle_ttl == pytest.approx(120.0)

    def test_invalid_port_raises(self, monkeypatch, tmp_path):
        """PORT에 잘못된 값 → ValueError 즉시 발생"""
        monkeypatch.setenv("WORKSPACE_DIR", str(tmp_path))
        monkeypatch.setenv("PORT", "not-a-port")

        with pytest.raises(ValueError) as exc_info:
            Settings.from_env()
        assert "PORT" in str(exc_info.value)

    def test_invalid_runner_pool_idle_ttl_raises(self, monkeypatch, tmp_path):
        """RUNNER_POOL_IDLE_TTL에 잘못된 값 → ValueError 즉시 발생"""
        monkeypatch.setenv("WORKSPACE_DIR", str(tmp_path))
        monkeypatch.setenv("RUNNER_POOL_IDLE_TTL", "xyz")

        with pytest.raises(ValueError) as exc_info:
            Settings.from_env()
        assert "RUNNER_POOL_IDLE_TTL" in str(exc_info.value)

    def test_invalid_health_check_interval_raises(self, monkeypatch, tmp_path):
        """HEALTH_CHECK_INTERVAL에 잘못된 값 → ValueError 즉시 발생"""
        monkeypatch.setenv("WORKSPACE_DIR", str(tmp_path))
        monkeypatch.setenv("HEALTH_CHECK_INTERVAL", "abc")

        with pytest.raises(ValueError) as exc_info:
            Settings.from_env()
        assert "HEALTH_CHECK_INTERVAL" in str(exc_info.value)
