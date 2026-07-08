"""Board Y.Doc host proxy contract fixtures."""

from unittest.mock import AsyncMock, MagicMock, patch

from tests.conftest import TEST_AUTH_TOKEN
from tests.orch_contract_helpers import load_contract_fixture


def _make_response(status_code: int, body: dict):
    response = MagicMock()
    response.status_code = status_code
    response.content = b"{}"
    response.headers = {"content-type": "application/json"}
    response.json = MagicMock(return_value=body)
    return response


async def _register_board_host(node_manager, node_id: str, port: int, *, is_host: bool):
    ws = AsyncMock()
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return await node_manager.register_node(
        ws,
        {
            "node_id": node_id,
            "host": "localhost",
            "port": port,
            "agents": [],
            "capabilities": {"board_yjs_host": is_host},
        },
    )


async def test_board_yjs_host_cardinality_and_proxy_contract(
    client,
    mock_catalog_service,
    node_manager,
):
    fixture = load_contract_fixture("board_yjs_host_proxy.json")

    no_host = await client.post(fixture["proxy"]["route"], json={
        "folderId": "f1",
        "title": "Note",
        "body": "Body",
    })
    assert no_host.status_code == fixture["cardinality"]["zeroHostsStatus"]

    host = await _register_board_host(node_manager, "board-host", 4105, is_host=True)
    await _register_board_host(node_manager, "board-host-2", 4106, is_host=True)
    duplicate_hosts = await client.post(fixture["proxy"]["route"], json={
        "folderId": "f1",
        "title": "Note",
        "body": "Body",
    })
    assert duplicate_hosts.status_code == fixture["cardinality"]["twoHostsStatus"]

    node_manager.unregister_node("board-host-2")
    mock_response = _make_response(200, {"document": {"id": "doc-1"}})
    with patch("soulstream_server.api.catalog.httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.request = AsyncMock(return_value=mock_response)
        mock_client_cls.return_value.__aenter__.return_value = mock_client

        ok = await client.post(fixture["proxy"]["route"], json={
            "folderId": "f1",
            "title": "Note",
            "body": "Body",
        })

    assert ok.status_code == fixture["cardinality"]["oneHostStatus"]
    called_args, called_kwargs = mock_client.request.call_args
    assert called_args == (
        fixture["proxy"]["method"],
        f"http://{host.host}:{host.port}{fixture['proxy']['upstreamPath']}",
    )
    assert called_kwargs["headers"]["authorization"] == f"Bearer {TEST_AUTH_TOKEN}"
    mock_catalog_service.create_markdown_document.assert_not_called()
