"""Tests for account-scoped user preferences API."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from soulstream_server.api.user_preferences import create_user_preferences_router
from soulstream_server.user_preferences import (
    InMemoryUserPreferencesRepository,
    MAX_BACKGROUND_BYTES,
)


def _make_client(email: str | None = "User@Example.com") -> TestClient:
    app = FastAPI()
    repository = InMemoryUserPreferencesRepository()

    @app.middleware("http")
    async def add_auth_user(request, call_next):
        if email is not None:
            request.state.auth_user = {"email": email}
        return await call_next(request)

    app.include_router(create_user_preferences_router(repository))
    return TestClient(app)


def test_get_preferences_returns_default_for_authenticated_user():
    client = _make_client()

    response = client.get("/api/user/preferences")

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "user@example.com"
    assert body["appearance"] == "system"
    assert body["wallpaper"] == {"mode": "bokeh"}
    assert body["preferences"]["glass"] == {
        "enabled": True,
        "refraction": 75,
        "blur": 5,
        "chromatic": 0.8,
        "specular": 0.25,
        "tint": 0.42,
    }
    assert body["hasBackground"] is False
    assert body["updatedAt"] is None


def test_put_preferences_persists_appearance_and_wallpaper():
    client = _make_client()

    response = client.put(
        "/api/user/preferences",
        json={
            "appearance": "dark",
            "wallpaper": {"mode": "metal"},
            "glass": {
                "enabled": False,
                "refraction": 60,
                "blur": 3.5,
                "chromatic": 1.1,
                "specular": 0.9,
                "tint": 0.25,
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["appearance"] == "dark"
    assert body["wallpaper"] == {"mode": "metal"}
    assert body["preferences"]["glass"] == {
        "enabled": False,
        "refraction": 60,
        "blur": 3.5,
        "chromatic": 1.1,
        "specular": 0.9,
        "tint": 0.25,
    }
    assert body["updatedAt"]

    stored = client.get("/api/user/preferences").json()
    assert stored["appearance"] == "dark"
    assert stored["wallpaper"] == {"mode": "metal"}
    assert stored["preferences"]["glass"]["enabled"] is False


def test_put_preferences_normalizes_glass_ranges():
    client = _make_client()

    response = client.put(
        "/api/user/preferences",
        json={
            "glass": {
                "enabled": True,
                "refraction": 999,
                "blur": -1,
                "chromatic": "2.25",
                "specular": None,
                "tint": 2,
            },
        },
    )

    assert response.status_code == 200
    assert response.json()["preferences"]["glass"] == {
        "enabled": True,
        "refraction": 90,
        "blur": 0,
        "chromatic": 2.25,
        "specular": 0.25,
        "tint": 1,
    }


def test_upload_background_stores_blob_and_serves_image():
    client = _make_client()

    upload = client.post(
        "/api/user/background",
        files={"file": ("bg.png", b"png-bytes", "image/png")},
    )

    assert upload.status_code == 200
    upload_body = upload.json()
    assert upload_body["hasBackground"] is True
    assert upload_body["wallpaper"]["mode"] == "photo"
    assert upload_body["wallpaper"]["customImage"].startswith("/api/user/background?v=")

    image = client.get("/api/user/background")
    assert image.status_code == 200
    assert image.content == b"png-bytes"
    assert image.headers["content-type"].startswith("image/png")


def test_put_preferences_can_clear_background():
    client = _make_client()
    client.post(
        "/api/user/background",
        files={"file": ("bg.webp", b"webp-bytes", "image/webp")},
    )

    response = client.put(
        "/api/user/preferences",
        json={
            "appearance": "light",
            "wallpaper": {"mode": "plain"},
            "clearBackground": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["hasBackground"] is False
    assert body["wallpaper"] == {"mode": "plain"}
    assert client.get("/api/user/background").status_code == 404


def test_non_photo_preferences_are_not_forced_to_photo_when_blob_exists():
    client = _make_client()
    client.post(
        "/api/user/background",
        files={"file": ("bg.webp", b"webp-bytes", "image/webp")},
    )

    response = client.put(
        "/api/user/preferences",
        json={"appearance": "dark", "wallpaper": {"mode": "metal"}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["hasBackground"] is True
    assert body["backgroundUrl"].startswith("/api/user/background?v=")
    assert body["wallpaper"] == {"mode": "metal"}


def test_rejects_unsupported_background_mime_type():
    client = _make_client()

    response = client.post(
        "/api/user/background",
        files={"file": ("bg.svg", b"<svg/>", "image/svg+xml")},
    )

    assert response.status_code == 415
    assert "image/png" in response.json()["detail"]["allowed"]


def test_rejects_oversized_background_blob():
    client = _make_client()

    response = client.post(
        "/api/user/background",
        files={"file": ("bg.jpg", b"x" * (MAX_BACKGROUND_BYTES + 1), "image/jpeg")},
    )

    assert response.status_code == 413
    assert response.json()["detail"]["maxBytes"] == MAX_BACKGROUND_BYTES


def test_requires_authenticated_user_email():
    client = _make_client(email=None)

    response = client.get("/api/user/preferences")

    assert response.status_code == 401
