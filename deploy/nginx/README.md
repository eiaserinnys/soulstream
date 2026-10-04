# 대시보드 연결 복구 정적 제공

현재 Netcup의 `soulstream.eiaserinnys.me` HTTPS server에서 기존 `location /`만 `netcup-core-endpoints.connection-recovery.patch`처럼 include로 교체합니다. `dashboard-connection-recovery.conf`는 `/etc/nginx/snippets/soulstream-dashboard-connection-recovery.conf`에 설치할 준비본입니다. `/lab/`, TLS, 업로드 한도와 다른 server는 유지합니다.

정적 root와 index alias는 실제 orch `DASHBOARD_DIR`인 `/home/eias/migration/netcup-core-bootstrap/production-staging/repo/unified-dashboard/dist`를 가리킵니다. 배포된 index/assets/fonts 및 build-info.json은 같은 Vite 빌드 산출물입니다. 문서 요청의 502/503/504만 같은 index로 처리합니다. nginx는 원래 `/v3`와 query 요청을 HTTP redirect 없이 처리하고(앱의 기존 `/v3`→`/` history 정규화는 유지합니다), API/SSE/WS/yjs/auth 요청은 HTML fallback을 받지 않습니다. 오류 문구와 스타일은 실제 root ConnectionDialog 하나에서 렌더합니다.

적용 담당자는 최신 운영 설정과 이 patch를 대조하고 정적 파일을 nginx 사용자로 읽을 수 있는지 확인한 뒤 `nginx -t`와 승인된 reload를 수행합니다. 이 PR은 운영 설정 변경이나 nginx reload를 수행하지 않습니다. 격리 foreground 검증은 `unified-dashboard/playwright.connection.config.ts`와 `e2e/connection-harness.ts`를 사용합니다.
