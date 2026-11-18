# 대시보드 연결 복구 정적 제공

현재 Netcup의 `soulstream.eiaserinnys.me` HTTPS server에서 기존 `location /`만 `netcup-core-endpoints.connection-recovery.patch`처럼 include로 교체합니다. `dashboard-connection-recovery.conf`는 `/etc/nginx/snippets/soulstream-dashboard-connection-recovery.conf`에 설치할 준비본입니다. `/lab/`, TLS, 업로드 한도와 다른 server는 유지합니다.

정적 root와 index alias는 실제 orch `DASHBOARD_DIR`인 `/home/eias/migration/netcup-core-bootstrap/production-staging/repo/unified-dashboard/dist`를 가리킵니다. 배포된 index/assets/fonts 및 build-info.json은 같은 Vite 빌드 산출물입니다. 문서 요청의 502/503/504만 같은 index로 처리합니다. nginx는 원래 `/v3`와 query 요청을 HTTP redirect 없이 처리하고(앱의 기존 `/v3`→`/` history 정규화는 유지합니다), API/SSE/WS/yjs/auth 요청은 HTML fallback을 받지 않습니다. 오류 문구와 스타일은 실제 root ConnectionDialog 하나에서 렌더합니다.

적용 담당자는 최신 운영 설정과 이 patch를 대조하고 정적 파일을 nginx 사용자로 읽을 수 있는지 확인한 뒤 `nginx -t`와 승인된 reload를 수행합니다. 이 PR은 운영 설정 변경이나 nginx reload를 수행하지 않습니다. 격리 foreground 검증은 `unified-dashboard/playwright.connection.config.ts`와 `e2e/connection-harness.ts`를 사용합니다.

## 외부 접속 링크(/x/)의 키를 로그에서 가리기

기간제 외부 접속 링크의 키는 URL 경로 `/x/<key>`에 들어갑니다(카드 #1457, 설계 2.7절). 운영 443·80 server 블록은 각자 server 수준 `access_log ... soulstream_diagnostic`을 두어 http 수준 combined 로그를 대체합니다. 그 진단 로그는 `$uri`를, 오류 로그는 요청 줄(`$request`)을 남기므로, 이 조각을 설치하기 전에는 키가 `soulstream-diagnostic.log`와 `error.log`에 그대로 남습니다. http 수준 `access.log`는 다른 server 블록이 상속하며(기본 server가 잘못된 Host/SNI 요청을 받는 경우 포함), 아래 확인에서 함께 봅니다.

두 조각은 location이 선택되는 요청의 키를 nginx 로그에서 지웁니다. 앱(orch-server-ts)의 `/x` 라우트와 앱 로그 가림, 응답 헤더는 다른 단위입니다.

### 설치

| 파일 | 설치 경로 |
|---|---|
| `external-access-link.conf` | `/etc/nginx/snippets/soulstream-external-access-link.conf` |
| `external-access-link-http.conf` | `/etc/nginx/snippets/soulstream-external-access-link-http.conf` |

**HTTPS server 블록**(`soulstream.eiaserinnys.me`, 443)에는 기존 location들과 나란히 include합니다.

```nginx
    include /etc/nginx/snippets/browser-screen.conf;
    include /etc/nginx/snippets/soulstream-dashboard-connection-recovery.conf;

    include /etc/nginx/snippets/soulstream-external-access-link.conf;
```

`location ^~ /x/`는 `^~` 접두 location이라 `location /`보다 먼저 선택됩니다. 그래서 `location /`의 `proxy_intercept_errors on`과 `error_page 502 503 504 =200 /__dashboard_connection_index`가 `/x/` 요청에는 적용되지 않고, 업스트림 오류는 502/504 그대로 링크 클라이언트에 갑니다.

location은 요청 헤더를 읽은 뒤에 선택되므로, 그 전에 거절된 요청(헤더 줄 초과 400, 헤더 타임아웃 408)은 server 수준 진단 로그가 `$uri`를 남길 수 있습니다. 이 조각은 그 경로를 덮지 않습니다.

**HTTP server 블록**(80)은 지금의 server 수준 `return 301`을 `location /` 안으로 옮기고 조각을 include합니다. server 수준 `return`은 location 선택보다 먼저 실행되어 `location ^~ /x/`의 `access_log off`가 적용되지 않기 때문입니다. 옮기지 않고 조각만 넣으면 80 요청의 키가 `soulstream-diagnostic.log`에 그대로 남습니다.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name soulstream.eiaserinnys.me;
    access_log /var/log/nginx/soulstream-diagnostic.log soulstream_diagnostic;

    large_client_header_buffers 4 16k;

    include /etc/nginx/snippets/soulstream-external-access-link-http.conf;

    location / {
        return 301 https://soulstream.eiaserinnys.me$request_uri;
    }
}
```

### 적용 순서

앱의 `/x` 경로를 배포하기 전에 이 조각을 먼저 적용합니다. 반대 순서면 그 사이에 들어온 요청의 키가 로그에 남습니다.

### 적용

운영 설정 변경과 reload는 이 리포가 하지 않습니다. 적용 담당자가 최신 운영 설정과 조각을 대조한 뒤 root로 설치하고 `nginx -t`와 승인된 reload를 수행합니다. 아래 명령은 리포 루트 기준입니다.

```bash
sudo install -m 0644 deploy/nginx/external-access-link.conf /etc/nginx/snippets/soulstream-external-access-link.conf
sudo install -m 0644 deploy/nginx/external-access-link-http.conf /etc/nginx/snippets/soulstream-external-access-link-http.conf
sudo nginx -t
sudo systemctl reload nginx   # 승인된 경우에만
```

### 적용 뒤 확인

합성 키를 만들어 운영 주소로 몇 번 보내고, 세 로그 파일에서 키 전체와 두 조각(22자, 43자)을 찾습니다. 로그를 읽으려면 root 또는 `adm` 그룹 권한이 필요합니다. 아래에서 `LEAK`가 하나도 없고 비교용 경로가 진단 로그에 보이면 통과입니다.

```bash
KEY="ssxl_$(openssl rand -base64 16 | tr '+/' '-_' | tr -d '=\n')_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
GRANT="${KEY:5:22}"; NONCE="${KEY:28:43}"
echo "key=${#KEY} grant=${#GRANT} nonce=${#NONCE}"   # 71 22 43

# 합성 키는 실제 grant가 아니므로 앱의 상태 코드는 401이나 404일 수 있습니다.
# 여기서 볼 것은 상태 코드가 아니라 아래 grep에서 키가 나오지 않는 것입니다.
curl -sS -o /dev/null -w '%{http_code}\n' "https://soulstream.eiaserinnys.me/x/$KEY"
curl -sS -o /dev/null -w '%{http_code}\n' "https://soulstream.eiaserinnys.me/x/$KEY/messages/00000000-0000-0000-0000-000000000000"
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE "https://soulstream.eiaserinnys.me/x/$KEY/stop"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{"text":' "https://soulstream.eiaserinnys.me/x/$KEY/messages"
head -c 400000 /dev/zero > /tmp/link-oversize.bin
curl -sS -o /dev/null -w '%{http_code}\n' -X POST --data-binary @/tmp/link-oversize.bin "https://soulstream.eiaserinnys.me/x/$KEY/messages"   # 413 (nginx, client_max_body_size 320k)
rm -f /tmp/link-oversize.bin

PROBE="/__link-log-probe-$(date +%s)"
curl -sS -o /dev/null "https://soulstream.eiaserinnys.me$PROBE"

for f in /var/log/nginx/soulstream-diagnostic.log /var/log/nginx/access.log /var/log/nginx/error.log; do
  for part in "$KEY" "$GRANT" "$NONCE"; do
    if grep -qF -- "$part" "$f"; then echo "LEAK: $f ($part)"; else echo "clean: $f"; fi
  done
done
grep -F -- "$PROBE" /var/log/nginx/soulstream-diagnostic.log   # 비교용 경로는 남아야 한다
```

400KB POST만 nginx가 413으로 끊고 나머지는 앱이 응답합니다(합성 키라 401/404). 앱이 내는 413(256KiB 초과)은 실제 grant로 따로 확인합니다. 이 조각이 보장하는 것은 위 요청들이 로그에 키를 남기지 않는 것입니다.

### 검증 스크립트

```bash
bash deploy/nginx/verify-external-access-link.sh
```

root 없이 시스템 nginx 바이너리를 임시 prefix와 빈 루프백 포트로 따로 띄워 두 조각을 확인합니다. `/etc/nginx`, 운영 nginx 프로세스, 운영 로그, sudo를 쓰지 않고 reload도 하지 않습니다. `nginx`, `python3`, `curl`이 없으면 건너뛰지 않고 실패합니다. 합성 키로 200, 404, 405, 400, 413, 업스트림 502와 80 블록의 301을 내고, 세 로그 어디에도 키 전체와 두 조각이 없으며 502가 대시보드 index의 200으로 바뀌지 않는지 봅니다. 끝나면 띄운 프로세스와 임시 폴더를 정리합니다.
