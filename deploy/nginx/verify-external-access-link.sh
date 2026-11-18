#!/usr/bin/env bash
# Verify that deploy/nginx/external-access-link.conf and
# deploy/nginx/external-access-link-http.conf keep the external access link
# key out of every nginx log, without root and without touching the running
# nginx.
#
# The system nginx binary runs with a temporary prefix on free loopback
# ports, in front of a small fake upstream started with python3. /etc/nginx,
# the operational nginx process, the operational logs and sudo are not used,
# and nothing is reloaded. The temporary processes and directory are removed
# when the script ends.
#
# Requires: bash, nginx, python3, curl. A missing tool is a failure, not a
# skip.
#
# Usage: bash deploy/nginx/verify-external-access-link.sh
set -euo pipefail

src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
snippet_https="$src_dir/external-access-link.conf"
snippet_http="$src_dir/external-access-link-http.conf"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

for tool in nginx python3 curl; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool not found"
done
for file in "$snippet_https" "$snippet_http"; do
    [[ -f "$file" ]] || fail "missing snippet: $file"
done

tmp="$(mktemp -d "${TMPDIR:-/tmp}/verify-external-access-link.XXXXXX")"
logs="$tmp/logs"
conf="$tmp/conf"
mkdir -p "$logs" "$conf"

up_pid=""
nginx_running=""
cleanup() {
    if [[ -n "$nginx_running" && -f "$tmp/nginx.pid" ]]; then
        nginx -p "$tmp" -c "$conf/nginx.conf" -s quit >/dev/null 2>&1 || true
    fi
    if [[ -n "$up_pid" ]]; then
        kill "$up_pid" >/dev/null 2>&1 || true
        wait "$up_pid" 2>/dev/null || true
    fi
    rm -rf "$tmp"
}
trap cleanup EXIT

# ---- synthetic key: ssxl_<22 base64url>_<43 base64url> --------------------
base64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
grant="$(head -c 16 /dev/urandom | base64url)"
nonce="$(head -c 32 /dev/urandom | base64url)"
[[ ${#grant} -eq 22 ]] || fail "grant part is ${#grant} chars, expected 22"
[[ ${#nonce} -eq 43 ]] || fail "nonce part is ${#nonce} chars, expected 43"
key="ssxl_${grant}_${nonce}"

# ---- free ports -----------------------------------------------------------
cat > "$tmp/pick_ports.py" <<'PY'
import socket

sockets = []
ports = []
for _ in range(3):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sockets.append(sock)
    ports.append(sock.getsockname()[1])
for sock in sockets:
    sock.close()
print(" ".join(str(port) for port in ports))
PY
read -r up_port https_port http_port < <(python3 "$tmp/pick_ports.py")
[[ -n "$up_port" && -n "$https_port" && -n "$http_port" ]] || fail "could not pick free ports"

# ---- fake upstream (returns 200, 404, 405 or 400 by path suffix) ----------
cat > "$tmp/fake_upstream.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RESPONSES = (
    ("/missing", 404, b'{"error":"not_found"}'),
    ("/no-method", 405, b'{"error":"method_not_allowed"}'),
    ("/bad-json", 400, b'{"error":"bad_request"}'),
)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        # Never write a request line: the path carries the synthetic key.
        return

    def _handle(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        status, body = 200, b'{"ok":true}'
        for suffix, code, payload in RESPONSES:
            if path.endswith(suffix):
                status, body = code, payload
                break
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_HEAD = _handle


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY

# ---- test configuration, same shape as the operational one ---------------
# The snippet keeps its include of /etc/nginx/snippets/netcup-core-proxy.conf;
# the temporary copy rewrites only that path, the original file is untouched.
cat > "$conf/netcup-core-proxy.conf" <<'EOF'
# Test copy of the operational /etc/nginx/snippets/netcup-core-proxy.conf.
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $netcup_core_connection_upgrade;
proxy_connect_timeout 5s;
proxy_send_timeout 3600s;
proxy_read_timeout 3600s;
proxy_buffering off;
EOF

sed "s|include /etc/nginx/snippets/netcup-core-proxy.conf;|include $conf/netcup-core-proxy.conf;|" \
    "$snippet_https" > "$conf/external-access-link.conf"
grep -qF "include $conf/netcup-core-proxy.conf;" "$conf/external-access-link.conf" \
    || fail "external-access-link.conf no longer includes /etc/nginx/snippets/netcup-core-proxy.conf; update this verifier"
cp "$snippet_http" "$conf/external-access-link-http.conf"

cat > "$conf/nginx.conf.in" <<'EOF'
pid @TMP@/nginx.pid;
error_log @TMP@/logs/error.log info;
worker_processes 1;

events {
    worker_connections 128;
}

http {
    default_type application/octet-stream;

    # Same format as /etc/nginx/conf.d/soulstream-request-diagnostic.conf.
    log_format soulstream_diagnostic escape=json '{"time":"$time_iso8601","connection":"$connection","connection_requests":"$connection_requests","method":"$request_method","uri":"$uri","status":$status,"bytes":$body_bytes_sent,"request_length":$request_length,"request_time":"$request_time","upstream_status":"$upstream_status","upstream_addr":"$upstream_addr","upstream_time":"$upstream_response_time","protocol":"$server_protocol"}';

    # http-level combined access log, as in /etc/nginx/nginx.conf.
    access_log @TMP@/logs/access.log;

    map $http_upgrade $netcup_core_connection_upgrade {
        default upgrade;
        ''      close;
    }

    upstream netcup_core_soulstream_orchestrator {
        server 127.0.0.1:@UP@;
        keepalive 16;
        keepalive_requests 1;
    }

    # Shape of the soulstream.eiaserinnys.me HTTPS server block.
    server {
        listen 127.0.0.1:@A@;
        server_name soulstream.eiaserinnys.me;

        access_log @TMP@/logs/soulstream-diagnostic.log soulstream_diagnostic;
        # The operational server-level log replaces the http-level combined
        # log, so the test keeps the combined log here as well: the
        # comparison request must be visible in both access logs, and /x
        # must be absent from both.
        access_log @TMP@/logs/access.log;
        large_client_header_buffers 4 16k;
        client_max_body_size 110M;

        include @TMP@/conf/external-access-link.conf;

        location = /__dashboard_connection_index {
            internal;
            default_type text/html;
            return 200 "dashboard-index\n";
        }
        location / {
            proxy_pass http://netcup_core_soulstream_orchestrator;
            include @TMP@/conf/netcup-core-proxy.conf;
            proxy_intercept_errors on;
            error_page 502 503 504 =200 /__dashboard_connection_index;
        }
    }

    # Shape of the soulstream.eiaserinnys.me HTTP (port 80) server block after
    # installing external-access-link-http.conf: the server-level return moved
    # into `location /`.
    server {
        listen 127.0.0.1:@B@;
        server_name soulstream.eiaserinnys.me;

        access_log @TMP@/logs/soulstream-diagnostic-http.log soulstream_diagnostic;
        large_client_header_buffers 4 16k;

        include @TMP@/conf/external-access-link-http.conf;

        location / {
            return 301 https://$host$request_uri;
        }
    }
}
EOF

sed -e "s|@TMP@|$tmp|g" \
    -e "s|@UP@|$up_port|g" \
    -e "s|@A@|$https_port|g" \
    -e "s|@B@|$http_port|g" \
    "$conf/nginx.conf.in" > "$conf/nginx.conf"

# ---- start the fake upstream and nginx -----------------------------------
python3 "$tmp/fake_upstream.py" "$up_port" &
up_pid=$!

up_ready=""
for _ in $(seq 1 100); do
    if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$up_port/__up" 2>/dev/null; then
        up_ready=1
        break
    fi
    kill -0 "$up_pid" 2>/dev/null || fail "fake upstream exited before it was reachable"
    sleep 0.1
done
[[ -n "$up_ready" ]] || fail "fake upstream did not become reachable on 127.0.0.1:$up_port"

if ! nginx -p "$tmp" -c "$conf/nginx.conf" -t >"$logs/nginx-t.out" 2>&1; then
    cat "$logs/nginx-t.out" >&2
    fail "nginx -t rejected the test configuration"
fi
nginx -p "$tmp" -c "$conf/nginx.conf" || fail "nginx failed to start on the test prefix"
nginx_running=1

base_https="http://127.0.0.1:$https_port"
base_http="http://127.0.0.1:$http_port"

ready=""
for _ in $(seq 1 100); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "$base_https/__ready" 2>/dev/null || true)" == "200" ]]; then
        ready=1
        break
    fi
    sleep 0.1
done
[[ -n "$ready" ]] || fail "nginx did not become reachable on 127.0.0.1:$https_port"

# ---- requests -------------------------------------------------------------
request_code() { # method url [curl args...]
    local method=$1 url=$2
    shift 2
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X "$method" "$@" "$url" 2>/dev/null || true
}

expect_code() { # expected label method url [curl args...]
    local want=$1 label=$2
    shift 2
    local got
    got="$(request_code "$@")"
    [[ "$got" == "$want" ]] || fail "$label: got HTTP ${got:-<none>}, expected $want"
}

expect_code 200 "GET /x/<key>" GET "$base_https/x/$key"
expect_code 404 "GET /x/<key>/missing" GET "$base_https/x/$key/missing"
expect_code 405 "DELETE /x/<key>/no-method" DELETE "$base_https/x/$key/no-method"
expect_code 400 "POST /x/<key>/bad-json" POST "$base_https/x/$key/bad-json" \
    -H 'Content-Type: application/json' --data-binary '{"text":'

head -c 400000 /dev/zero | tr '\0' 'a' > "$tmp/oversize.bin"
expect_code 413 "POST /x/<key>/oversize" POST "$base_https/x/$key/oversize" \
    -H 'Content-Type: application/json' --data-binary "@$tmp/oversize.bin"

# Control while the upstream is up: a non-/x path must be logged.
expect_code 200 "GET /control/probe" GET "$base_https/control/probe"

# HTTP (port 80) block keeps its redirect and drops the log for /x/.
expect_code 301 "GET /x/<key> on the HTTP block" GET "$base_http/x/$key" \
    -H 'Host: soulstream.eiaserinnys.me'
expect_code 301 "GET /control-http on the HTTP block" GET "$base_http/control-http" \
    -H 'Host: soulstream.eiaserinnys.me'

# ---- upstream failure: /x must stay 502, other paths still get the index --
kill "$up_pid" >/dev/null 2>&1 || true
wait "$up_pid" 2>/dev/null || true
up_pid=""

code=""
for _ in $(seq 1 50); do
    code="$(request_code GET "$base_https/x/$key")"
    [[ "$code" == "502" ]] && break
    sleep 0.1
done
[[ "$code" == "502" ]] || fail "GET /x/<key> with the upstream down: got HTTP ${code:-<none>}, expected 502"
body="$(curl -sS --max-time 10 "$base_https/x/$key" 2>/dev/null || true)"
[[ "$body" != *dashboard-index* ]] || fail "GET /x/<key> with the upstream down was rewritten to the dashboard index"

expect_code 200 "GET /control/down" GET "$base_https/control/down"
body="$(curl -sS --max-time 10 "$base_https/control/down" 2>/dev/null || true)"
[[ "$body" == *dashboard-index* ]] || fail "control: /control/down did not reach the dashboard index; the error_page test is not meaningful"

# ---- log assertions -------------------------------------------------------
mask() { # $1 line; mask the key and both parts
    local line=$1
    line="${line//"$key"/***}"
    line="${line//"$grant"/***}"
    line="${line//"$nonce"/***}"
    printf '%s' "${line:0:200}"
}

assert_absent() { # file needle label
    local file=$1 needle=$2 label=$3
    [[ -f "$file" ]] || fail "missing log file: $file"
    if grep -qF -- "$needle" "$file"; then
        local hit lineno
        hit="$(grep -nF -- "$needle" "$file" | head -n 1)"
        lineno="${hit%%:*}"
        fail "$label: key material in ${file##*/} line $lineno: $(mask "${hit#*:}")"
    fi
}

assert_present() { # file needle label
    local file=$1 needle=$2 label=$3
    [[ -f "$file" ]] || fail "missing log file: $file"
    grep -qF -- "$needle" "$file" || fail "$label: '$needle' not found in ${file##*/}"
}

for log in access soulstream-diagnostic soulstream-diagnostic-http error; do
    assert_absent "$logs/$log.log" "$key" "full key in $log.log"
    assert_absent "$logs/$log.log" "$grant" "grant part in $log.log"
    assert_absent "$logs/$log.log" "$nonce" "nonce part in $log.log"
done

# Positive controls: the test logs are actually written.
assert_present "$logs/access.log" "/control/probe" "combined access log is written"
assert_present "$logs/soulstream-diagnostic.log" "/control/probe" "server-level diagnostic log is written"
assert_present "$logs/soulstream-diagnostic-http.log" "/control-http" "HTTP block diagnostic log is written"
assert_present "$logs/error.log" 'request: "GET /control/down HTTP/1.1"' "main error log is written"

# Self-check: the detector must fail on a planted key. The differential
# controls above prove the logs are written; this proves assert_absent reads
# them.
cp "$logs/soulstream-diagnostic.log" "$tmp/planted.log"
printf 'request: "GET /x/%s HTTP/1.1"\n' "$key" >> "$tmp/planted.log"
if ( assert_absent "$tmp/planted.log" "$key" "self-check" ) >/dev/null 2>&1; then
    fail "self-check: the leak detector did not report a planted key"
fi

printf 'PASS: /x key absent from access.log, soulstream-diagnostic.log, soulstream-diagnostic-http.log and error.log\n'
printf 'PASS: 200/404/405/400/413/502 and the 80-block 301 answered as expected; 502 was not rewritten to the dashboard index\n'
printf 'PASS: control paths are present in the logs (the test configuration writes logs)\n'
