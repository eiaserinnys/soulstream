from fastapi import FastAPI
from fastapi.testclient import TestClient

from soulstream_server.dashboard.serving import mount_dashboard


def _create_dashboard_dir(tmp_path):
    dashboard_dir = tmp_path / "dashboard"
    assets_dir = dashboard_dir / "assets"
    assets_dir.mkdir(parents=True)
    (dashboard_dir / "index.html").write_text("<!doctype html><div id='root'></div>", encoding="utf-8")
    (assets_dir / "index-AbCdEf12.js").write_text("console.log('dashboard');", encoding="utf-8")
    return dashboard_dir


def _create_client(dashboard_dir) -> TestClient:
    app = FastAPI()
    mount_dashboard(app, str(dashboard_dir))
    return TestClient(app)


def test_dashboard_index_responses_are_revalidated(tmp_path):
    client = _create_client(_create_dashboard_dir(tmp_path))

    for path in ("/", "/index.html", "/sessions/abc"):
        response = client.get(path)

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-cache"


def test_dashboard_hashed_assets_are_immutable(tmp_path):
    client = _create_client(_create_dashboard_dir(tmp_path))

    response = client.get("/assets/index-AbCdEf12.js")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
