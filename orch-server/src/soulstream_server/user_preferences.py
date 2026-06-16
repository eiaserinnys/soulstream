"""Account-scoped dashboard appearance and wallpaper preferences."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from soulstream_server.users import validate_user_email


ALLOWED_APPEARANCES = frozenset({"system", "light", "dark"})
ALLOWED_WALLPAPER_MODES = frozenset({"bokeh", "metal", "photo", "plain"})
DEFAULT_GLASS_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "refraction": 75,
    "blur": 5,
    "chromatic": 0.8,
    "specular": 0.25,
    "tint": 0.42,
}
GLASS_NUMERIC_LIMITS = {
    "refraction": (0, 90),
    "blur": (0, 8),
    "chromatic": (0, 2.5),
    "specular": (0, 1.5),
    "tint": (0, 1),
}
ALLOWED_BACKGROUND_MIME_TYPES = frozenset({
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
})
MAX_BACKGROUND_BYTES = 5 * 1024 * 1024

DEFAULT_USER_PREFERENCES: dict[str, Any] = {
    "appearance": "system",
    "wallpaper": {"mode": "bokeh"},
    "glass": DEFAULT_GLASS_SETTINGS,
}

USER_PREFERENCES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS user_preferences (
    email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
    prefs JSONB NOT NULL DEFAULT '{}'::JSONB,
    background_blob BYTEA,
    background_mime TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}'::JSONB;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS background_blob BYTEA;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS background_mime TEXT;
ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
COMMENT ON COLUMN user_preferences.prefs IS
    'Dashboard preferences JSON: appearance, wallpaper, and liquid glass settings.';
"""


@dataclass(frozen=True)
class UserPreferences:
    email: str
    prefs: dict[str, Any]
    background_blob: bytes | None
    background_mime: str | None
    updated_at: datetime | None

    @property
    def has_background(self) -> bool:
        return bool(self.background_blob and self.background_mime)

    @classmethod
    def default(cls, email: str) -> "UserPreferences":
        return cls(
            email=validate_user_email(email),
            prefs=normalize_user_preferences(None),
            background_blob=None,
            background_mime=None,
            updated_at=None,
        )

    @classmethod
    def from_row(cls, row: Any) -> "UserPreferences":
        get = row.get if hasattr(row, "get") else row.__getitem__
        blob = get("background_blob")
        if isinstance(blob, memoryview):
            blob = blob.tobytes()
        return cls(
            email=validate_user_email(get("email")),
            prefs=normalize_user_preferences(_decode_prefs(get("prefs"))),
            background_blob=blob,
            background_mime=_normalize_background_mime(get("background_mime")),
            updated_at=get("updated_at"),
        )

def normalize_user_preferences(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    appearance = source.get("appearance")
    if appearance not in ALLOWED_APPEARANCES:
        appearance = DEFAULT_USER_PREFERENCES["appearance"]

    wallpaper = source.get("wallpaper")
    if not isinstance(wallpaper, dict):
        wallpaper = {}
    mode = wallpaper.get("mode")
    if mode not in ALLOWED_WALLPAPER_MODES:
        mode = DEFAULT_USER_PREFERENCES["wallpaper"]["mode"]

    normalized_wallpaper: dict[str, Any] = {"mode": mode}
    custom_image = wallpaper.get("customImage")
    if isinstance(custom_image, str) and _is_safe_background_url(custom_image):
        normalized_wallpaper["customImage"] = custom_image

    return {
        "appearance": appearance,
        "wallpaper": normalized_wallpaper,
        "glass": _normalize_glass_settings(source.get("glass")),
    }


def preferences_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    prefs: dict[str, Any] = {}
    nested = payload.get("prefs")
    if isinstance(nested, dict):
        prefs.update(nested)
    for key in ("appearance", "wallpaper", "glass"):
        if key in payload:
            prefs[key] = payload[key]
    return normalize_user_preferences(prefs)


def _normalize_glass_settings(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    normalized = dict(DEFAULT_GLASS_SETTINGS)
    enabled = source.get("enabled")
    if isinstance(enabled, bool):
        normalized["enabled"] = enabled
    for key, (minimum, maximum) in GLASS_NUMERIC_LIMITS.items():
        normalized[key] = _number_in_range(source.get(key), minimum, maximum, DEFAULT_GLASS_SETTINGS[key])
    return normalized


def _number_in_range(value: Any, minimum: float, maximum: float, fallback: float) -> float:
    if isinstance(value, bool):
        return fallback
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    if not numeric == numeric:
        return fallback
    clipped = min(maximum, max(minimum, numeric))
    if isinstance(fallback, int) and clipped.is_integer():
        return int(clipped)
    return clipped


def validate_background_mime(value: str | None) -> str:
    mime = _normalize_background_mime(value)
    if mime not in ALLOWED_BACKGROUND_MIME_TYPES:
        allowed = ", ".join(sorted(ALLOWED_BACKGROUND_MIME_TYPES))
        raise ValueError(f"Unsupported background image MIME type. Allowed: {allowed}")
    return mime


def current_utc() -> datetime:
    return datetime.now(timezone.utc)


class InMemoryUserPreferencesRepository:
    def __init__(self) -> None:
        self._rows: dict[str, UserPreferences] = {}

    async def ensure_schema(self) -> None:
        return None

    async def get(self, email: str) -> UserPreferences:
        email = validate_user_email(email)
        return self._rows.get(email) or UserPreferences.default(email)

    async def put(
        self,
        email: str,
        prefs: dict[str, Any],
        *,
        clear_background: bool = False,
    ) -> UserPreferences:
        email = validate_user_email(email)
        existing = await self.get(email)
        row = UserPreferences(
            email=email,
            prefs=normalize_user_preferences(prefs),
            background_blob=None if clear_background else existing.background_blob,
            background_mime=None if clear_background else existing.background_mime,
            updated_at=current_utc(),
        )
        self._rows[email] = row
        return row

    async def put_background(
        self,
        email: str,
        prefs: dict[str, Any],
        *,
        blob: bytes,
        mime: str,
    ) -> UserPreferences:
        email = validate_user_email(email)
        row = UserPreferences(
            email=email,
            prefs=normalize_user_preferences(prefs),
            background_blob=bytes(blob),
            background_mime=validate_background_mime(mime),
            updated_at=current_utc(),
        )
        self._rows[email] = row
        return row


class PostgresUserPreferencesRepository:
    def __init__(self, pool) -> None:
        self._pool = pool

    async def ensure_schema(self) -> None:
        await self._pool.execute(USER_PREFERENCES_SCHEMA_SQL)

    async def get(self, email: str) -> UserPreferences:
        email = validate_user_email(email)
        row = await self._pool.fetchrow(
            """
            SELECT email, prefs, background_blob, background_mime, updated_at
            FROM user_preferences
            WHERE email = $1
            """,
            email,
        )
        return UserPreferences.from_row(row) if row else UserPreferences.default(email)

    async def put(
        self,
        email: str,
        prefs: dict[str, Any],
        *,
        clear_background: bool = False,
    ) -> UserPreferences:
        email = validate_user_email(email)
        row = await self._pool.fetchrow(
            """
            INSERT INTO user_preferences (email, prefs, background_blob, background_mime, updated_at)
            VALUES ($1, $2::jsonb, NULL, NULL, NOW())
            ON CONFLICT (email) DO UPDATE SET
                prefs = EXCLUDED.prefs,
                background_blob = CASE
                    WHEN $3 THEN NULL
                    ELSE user_preferences.background_blob
                END,
                background_mime = CASE
                    WHEN $3 THEN NULL
                    ELSE user_preferences.background_mime
                END,
                updated_at = NOW()
            RETURNING email, prefs, background_blob, background_mime, updated_at
            """,
            email,
            _encode_prefs(normalize_user_preferences(prefs)),
            clear_background,
        )
        return UserPreferences.from_row(row)

    async def put_background(
        self,
        email: str,
        prefs: dict[str, Any],
        *,
        blob: bytes,
        mime: str,
    ) -> UserPreferences:
        email = validate_user_email(email)
        row = await self._pool.fetchrow(
            """
            INSERT INTO user_preferences (email, prefs, background_blob, background_mime, updated_at)
            VALUES ($1, $2::jsonb, $3, $4, NOW())
            ON CONFLICT (email) DO UPDATE SET
                prefs = EXCLUDED.prefs,
                background_blob = EXCLUDED.background_blob,
                background_mime = EXCLUDED.background_mime,
                updated_at = NOW()
            RETURNING email, prefs, background_blob, background_mime, updated_at
            """,
            email,
            _encode_prefs(normalize_user_preferences(prefs)),
            bytes(blob),
            validate_background_mime(mime),
        )
        return UserPreferences.from_row(row)


def _decode_prefs(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _encode_prefs(value: dict[str, Any]) -> str:
    return json.dumps(normalize_user_preferences(value), ensure_ascii=False)


def _normalize_background_mime(value: str | None) -> str | None:
    if not value:
        return None
    return value.split(";", 1)[0].strip().lower() or None


def _is_safe_background_url(value: str) -> bool:
    return (
        value.startswith("/api/user/background")
        or value.startswith("data:image/")
        or value.startswith("https://")
        or value.startswith("http://")
    )
