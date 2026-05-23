"""Pending command lifecycle tests."""

import asyncio

import pytest

from soulstream_server.nodes.pending_commands import PendingCommands


async def test_success_resolves_and_cleans_up_pending_command():
    commands = PendingCommands()
    request_id = commands.next_request_id()
    future = commands.register(request_id)

    wait_task = asyncio.create_task(
        commands.wait_for_result(
            request_id,
            command="create_session",
            future=future,
            timeout=1,
        )
    )
    await asyncio.sleep(0)

    assert request_id in commands.pending

    assert commands.resolve(request_id, {"status": "ok"}) is True

    assert await wait_task == {"status": "ok"}
    assert commands.pending == {}


async def test_reject_sets_exception_and_cleans_up_pending_command():
    commands = PendingCommands()
    request_id = commands.next_request_id()
    future = commands.register(request_id)

    wait_task = asyncio.create_task(
        commands.wait_for_result(
            request_id,
            command="upload_attachment",
            future=future,
            timeout=1,
        )
    )
    await asyncio.sleep(0)

    assert commands.reject(request_id, "INVALID_REQUEST: bad payload") is True

    with pytest.raises(RuntimeError, match="INVALID_REQUEST"):
        await wait_task
    assert commands.pending == {}


async def test_timeout_message_includes_command_timeout_and_request_id():
    commands = PendingCommands()
    request_id = commands.next_request_id()
    future = commands.register(request_id)

    with pytest.raises(
        TimeoutError,
        match=(
            rf"Command intervene timed out after 0.01s "
            rf"\(request_id={request_id}\)"
        ),
    ):
        await commands.wait_for_result(
            request_id,
            command="intervene",
            future=future,
            timeout=0.01,
        )

    assert commands.pending == {}


async def test_close_cancel_is_normalized_to_connection_error():
    commands = PendingCommands()
    request_id = commands.next_request_id()
    future = commands.register(request_id)

    wait_task = asyncio.create_task(
        commands.wait_for_result(
            request_id,
            command="download_attachment",
            future=future,
            timeout=1,
        )
    )
    await asyncio.sleep(0)

    commands.cancel_all_for_close()

    with pytest.raises(ConnectionError, match="disconnected during command"):
        await wait_task
    assert commands.pending == {}
    assert commands.closed is True


async def test_external_task_cancellation_propagates_cancelled_error():
    commands = PendingCommands()
    request_id = commands.next_request_id()
    future = commands.register(request_id)

    wait_task = asyncio.create_task(
        commands.wait_for_result(
            request_id,
            command="download_attachment",
            future=future,
            timeout=1,
        )
    )
    await asyncio.sleep(0)

    wait_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await wait_task
    assert commands.pending == {}
    assert commands.closed is False


async def test_discard_removes_pending_command_after_send_failure():
    commands = PendingCommands()
    request_id = commands.next_request_id()
    future = commands.register(request_id)

    commands.discard(request_id)

    assert request_id not in commands.pending
    assert future.done() is False
