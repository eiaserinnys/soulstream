"""PushNotificationProvider 추상화.

향후 Expo Push 외 APNs 직접/FCM 직접으로 전환할 수 있도록 send 인터페이스를
provider 단에서 캡슐화한다 (design-principles §1: 작은 인터페이스 뒤 큰 행위).
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class SendResult:
    """Push 전송 결과.

    invalid_token=True는 그 토큰이 더 이상 유효하지 않음(DeviceNotRegistered 등)을
    의미하며, 호출자는 이 결과를 받아 push_tokens에서 해당 토큰을 정리해야 한다.
    """

    ok: bool
    invalid_token: bool
    error: str | None = None


class PushNotificationProvider(ABC):
    """디바이스 토큰 1개로 알림 1건을 발송하는 단순 인터페이스."""

    @abstractmethod
    async def send(
        self,
        token: str,
        title: str,
        body: str,
        data: dict,
    ) -> SendResult:
        """알림 1건 전송. 실패는 SendResult로 반환 (예외 raise 안 함)."""
