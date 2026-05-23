"""Pending command request lifecycle for node WebSocket commands."""

import asyncio
import time
from collections.abc import Callable
from typing import Any


class PendingCommands:
    """Track in-flight command futures and normalize lifecycle failures."""

    def __init__(self, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._request_counter = 0
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._closed = False

    @property
    def pending(self) -> dict[str, asyncio.Future[dict[str, Any]]]:
        return self._pending

    @property
    def closed(self) -> bool:
        return self._closed

    def next_request_id(self) -> str:
        self._request_counter += 1
        return f"req-{self._request_counter}-{int(self._clock() * 1000)}"

    def register(self, request_id: str) -> asyncio.Future[dict[str, Any]]:
        future: asyncio.Future[dict[str, Any]] = (
            asyncio.get_running_loop().create_future()
        )
        self._pending[request_id] = future
        return future

    def resolve(self, request_id: str, data: dict[str, Any]) -> bool:
        future = self._pending.pop(request_id, None)
        if future is None:
            return False
        if not future.done():
            future.set_result(data)
        return True

    def reject(self, request_id: str, message: str) -> bool:
        future = self._pending.pop(request_id, None)
        if future is None:
            return False
        if not future.done():
            future.set_exception(RuntimeError(message))
        return True

    def discard(self, request_id: str) -> None:
        self._pending.pop(request_id, None)

    async def wait_for_result(
        self,
        request_id: str,
        *,
        command: str,
        future: asyncio.Future[dict[str, Any]],
        timeout: float,
    ) -> dict[str, Any]:
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            raise TimeoutError(
                f"Command {command} timed out after {timeout}s "
                f"(request_id={request_id})"
            )
        except asyncio.CancelledError:
            if self._closed:
                raise ConnectionError(
                    f"Node disconnected during command: {command} "
                    f"(request_id={request_id})"
                )
            raise
        finally:
            self.discard(request_id)

    def cancel_all_for_close(self) -> None:
        self._closed = True
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()
