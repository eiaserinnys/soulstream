"""ClaudeRunner 모듈 레벨 레지스트리

runner_id → ClaudeRunner 인스턴스 매핑과 전역 종료를 관리한다.
"""

import asyncio
import logging
import threading
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from soul_server.claude.agent_runner import ClaudeRunner

logger = logging.getLogger(__name__)

_registry: dict[str, "ClaudeRunner"] = {}
_registry_lock = threading.Lock()
_shutting_down = False


def get_runner(runner_id: str) -> Optional["ClaudeRunner"]:
    """레지스트리에서 러너 조회"""
    with _registry_lock:
        return _registry.get(runner_id)


def register_runner(runner: "ClaudeRunner") -> bool:
    """레지스트리에 러너 등록

    Args:
        runner: 등록할 ClaudeRunner 인스턴스

    Returns:
        True: 등록 성공
        False: 셧다운 중이라 등록 거부
    """
    with _registry_lock:
        if _shutting_down:
            return False  # 셧다운 중 등록 거부
        _registry[runner.runner_id] = runner
        return True


def reset_shutdown_state() -> None:
    """테스트용: _shutting_down 플래그 초기화"""
    global _shutting_down
    with _registry_lock:
        _shutting_down = False


def remove_runner(runner_id: str) -> Optional["ClaudeRunner"]:
    """레지스트리에서 러너 제거"""
    with _registry_lock:
        return _registry.pop(runner_id, None)


def get_registry_size() -> int:
    """레지스트리에 등록된 러너 수"""
    with _registry_lock:
        return len(_registry)


async def shutdown_all() -> int:
    """모든 등록된 러너의 클라이언트를 종료

    프로세스 종료 전에 호출하여 고아 프로세스를 방지합니다.
    셧다운 시작 후 새 러너 등록은 거부됩니다.

    Returns:
        종료된 클라이언트 수
    """
    global _shutting_down

    with _registry_lock:
        _shutting_down = True
        runners = list(_registry.values())
        _registry.clear()

    if not runners:
        logger.info("종료할 활성 클라이언트 없음")
        return 0

    # TODO: shutdown 로직이 ClaudeRunner 내부 속성에 직접 접근한다.
    # ClaudeRunner에 shutdown_client() 메서드를 추출하여 이 함수의
    # 지식 경계를 줄여야 한다.
    count = 0
    for runner in runners:
        try:
            if runner.client:
                if (
                    runner._lifecycle_task is not None
                    and runner._lifecycle_shutdown_event is not None
                ):
                    # Lifecycle task 경유 종료 (anyio cross-task 버그 방지)
                    shutdown_ev = runner._lifecycle_shutdown_event
                    lifecycle = runner._lifecycle_task
                    saved_pid = runner.pid  # 타임아웃 시 force_kill 경로용
                    runner.client = None
                    runner.pid = None
                    runner._lifecycle_task = None
                    runner._lifecycle_shutdown_event = None
                    runner._client_session_id = None
                    runner._client_options_fp = None

                    shutdown_ev.set()
                    done, _ = await asyncio.wait({lifecycle}, timeout=30.0)
                    if done:
                        try:
                            await lifecycle  # 예외가 있으면 꺼냄; traceback 보존
                            count += 1
                            logger.info(f"클라이언트 종료 성공: runner={runner.runner_id}")
                        except Exception as e:
                            logger.warning(f"클라이언트 종료 실패: runner={runner.runner_id}, {e}")
                            if saved_pid:
                                runner._force_kill_process(saved_pid, runner.runner_id)
                                count += 1
                    else:
                        logger.warning(f"클라이언트 종료 타임아웃: runner={runner.runner_id}")
                        lifecycle.cancel()
                        try:
                            await lifecycle
                        except (asyncio.CancelledError, Exception):
                            pass
                        if saved_pid:
                            runner._force_kill_process(saved_pid, runner.runner_id)
                else:
                    # 직접 disconnect (lifecycle task 없음, 하위 호환)
                    await runner.client.disconnect()
                    count += 1
                    logger.info(f"클라이언트 종료 성공: runner={runner.runner_id}")
        except Exception as e:
            logger.warning(f"클라이언트 종료 실패: runner={runner.runner_id}, {e}")
            if runner.pid:
                runner._force_kill_process(runner.pid, runner.runner_id)
                count += 1

    logger.info(f"총 {count}개 클라이언트 종료 완료")
    return count


def shutdown_all_sync() -> int:
    """모든 등록된 러너의 클라이언트를 종료 (동기 버전)

    시그널 핸들러 등 동기 컨텍스트에서 사용합니다.

    Returns:
        종료된 클라이언트 수
    """
    try:
        loop = asyncio.new_event_loop()
        count = loop.run_until_complete(shutdown_all())
        loop.close()
        return count
    except Exception as e:
        logger.warning(f"클라이언트 동기 종료 중 오류: {e}")
        return 0
