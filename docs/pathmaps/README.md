# 종단 경로 지도

> 갱신 강제 계약: 이 지도들이 다루는 경로를 바꾸는 PR은 해당 장 갱신을 같은 PR에 포함한다.

| 장 | 정본 범위 |
| --- | --- |
| [메시지에서 종단까지](message-to-terminal.md) | 메시지 접수·라우팅·전이·실행·종단·투영·통지 |
| [재시작 복구](restart-recovery.md) | boot 1회 pass·node-ready replay·maintenance replay·runner recovery |
| [러너 생애주기](runner-lifecycle.md) | spawn·등록·identity/lock·adopt·terminate·dispose |
| [전달 원장](delivery-ledger.md) | `session_deliveries.state`·`aggregate_state` 전이와 작성자 |
| [타이머 목록](timers-inventory.md) | 복구·전달·러너 경로의 cadence·owner·유지 판정 |
