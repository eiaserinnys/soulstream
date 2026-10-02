# 대형 세션 첨부: 계약과 배포 후 확인 절차

웹/desktop에서 수백 MB 파일을 세션에 전달하고 대상 워커의 로컬 파일로 접근하는 기능입니다. 실제 500MiB 운영 E2E는 이 PR에서 실행하지 않았으며 배포 담당자가 아래 절차로 확인합니다.

## 실제 데이터 경로

| 경계 | 정본과 동작 |
| :--- | :--- |
| 파일 선택 | `packages/soul-ui/src/hooks/useFileUpload.ts` → `uploadSessionFile.ts`입니다. 64MiB 미만은 기존 HTTP, 이상은 multipart JSON API를 사용합니다. |
| 브라우저 → R2 | 파일당 최대 5GiB, 16MiB `File.slice`, PUT 동시 2개입니다. 파일 전체 arrayBuffer/base64 변환을 하지 않습니다. |
| init/complete/abort | `/api/attachments/sessions/multipart/{init,complete,abort}?nodeId=…`입니다. init 본문은 `session_id`, `filename`, `size`, `content_type`, 생성 전이면 `folder_id`입니다. complete는 `ticket`, 정렬된 `parts: [{partNumber, etag}]`만 사용합니다. abort는 `ticket`을 받습니다. |
| 권한 | 기존 세션은 `requireSessionAccess`를 사용합니다. 생성 전 UUID는 현재 로그인 사용자와 현재 폴더 접근 권한으로 확인합니다. complete/abort에서도 다시 확인합니다. |
| ticket | 1시간 JWT에 사용자·세션·폴더·노드·무작위 객체 키·multipart ID·import ID·파일명·크기·내용 종류·R2 설정 식별을 묶습니다. 대시보드 인증에 필요한 email claim이 없어 로그인 토큰으로 사용할 수 없습니다. |
| 저장소 설정 | `r2_storage_resolver.ts`의 attachment 설정만 사용합니다. 보드 설정으로 폴백하지 않습니다. 기존 R2 multipart/서명 구현을 공유합니다. |
| orch → 워커 | `import_attachment_from_url` 명령과 `attachment_import_v1` capability를 사용합니다. 명령 제한은 300초이고 기존 `upload_attachment_result` 응답을 사용합니다. |
| 워커 로컬 파일 | `INCOMING_FILE_DIR` 안에서 기존 파일명·경로 검증을 사용합니다. HTTPS R2 URL만 받고 redirect는 거부합니다. 스트림→임시 파일→크기 확인→rename 순서이며 실패·취소 시 임시 파일을 지웁니다. |
| 새 세션 | `createSessionPayload`가 camelCase `attachmentPaths`를 wire의 `attachment_paths`로 정규화합니다. 워커 `TaskRuntimeCommands.createSession`이 로컬 경로 안내를 prompt에 넣고 구조화 목록도 전달합니다. |
| 재개 | `submitResume` → `submitIntervention`이 prompt 경로 안내와 `attachmentPaths`를 보냅니다. 기존 intervene/durable delivery 경로가 `attachment_paths`로 전달합니다. |
| 첨부 메타데이터 | 새 테이블을 만들지 않습니다. 기존 사용자 메시지 이벤트의 `attachments` 및 재개 delivery의 `attachment_paths`를 사용합니다. |
| 임시 객체 정리 | 워커 import 성공 후 R2 객체를 best-effort 삭제합니다. 업로드 취소·실패 시 multipart abort를 best-effort 수행하고 원 오류를 유지합니다. 객체 prefix는 `session-attachments/transfers/`입니다. |

## 배포 전 운영 담당자가 확인할 것

- orch와 첨부 대상 워커가 모두 해당 PR 버전이며 등록 capability에 `attachment_import_v1: true`가 보여야 합니다.
- 비공개 attachment R2 설정과 브라우저 PUT CORS의 ETag 노출이 필요합니다. 운영 설정은 이 PR에서 수정하지 않습니다.
- 완료 HTTP 응답은 워커 import를 기다립니다. 운영 프록시가 그 응답을 허용하는지는 배포 후 실측 대상입니다. 워커 명령과 다운로드 제한은 300초입니다.
- 실패·브라우저 종료로 남은 완료 객체의 expiration을 위 prefix에 운영 lifecycle로 설정합니다. 기존 abandoned multipart lifecycle과는 별개입니다.

## 500MiB 파일을 작은 메모리로 준비

Linux에서 임시 QA 폴더를 만들고 sparse 파일을 생성합니다. 실제 업로드에는 전체 524288000바이트가 전송됩니다.

```bash
attachment_qa_dir=$(mktemp -d)
truncate -s 524288000 "$attachment_qa_dir/session-attachment-500MiB.bin"
sha256sum "$attachment_qa_dir/session-attachment-500MiB.bin"
```

파일 전체를 Python/Node 메모리에 읽거나 base64로 바꾸지 않습니다. 1GiB 확인이 필요하면 파일 크기만 1073741824바이트로 바꿉니다.

## 브라우저에서 새 세션 확인

1. 로그인한 대시보드에서 전달할 폴더·노드·에이전트를 선택합니다. 새 세션의 기존 첨부 버튼으로 준비한 파일을 선택합니다.
2. Network에서 JSON init이 201인지, 16MiB PUT이 32개인지, 동시에 전송되는 PUT이 최대 2개인지 확인합니다. 마지막 part는 파일 크기에 따라 작을 수 있습니다. 작은 첨부 POST로 폴백하지 않아야 합니다.
3. complete가 201로 `{path, filename, size, content_type}`를 반환하고 size가 524288000인지 확인합니다. ticket이나 서명 URL 원문은 보고에 복사하지 않습니다.
4. 새 세션을 시작하면서 “첨부 파일의 크기와 SHA-256을 스트림으로 확인해 주세요”라고 지시합니다. 생성 요청의 구조화 첨부 목록과 실제 첫 prompt의 로컬 경로가 동일해야 합니다.
5. 대상 워커에서 응답의 path가 `INCOMING_FILE_DIR` 하위인지, 실제 크기와 SHA-256이 준비한 파일과 같은지 확인합니다. 세션이 그 로컬 파일을 읽을 수 있어야 합니다.
6. R2의 해당 임시 객체가 import 후 삭제됐는지 확인합니다. 파일명 대신 무작위 키를 사용하므로 성공한 init의 시간·노드와 작업에 해당하는 키만 확인합니다.

## 재개와 desktop 확인

- 완료된 기존 세션을 열고 같은 파일을 첨부합니다. complete 후 메시지를 보내 세션을 재개합니다. `/intervene` 요청에서 prompt 경로 안내와 구조화 `attachmentPaths`가 모두 보이는지 확인합니다.
- 대상 워커에서 size와 스트림 SHA-256을 대조하고, 재개된 세션이 그 로컬 경로에 접근하는지 확인합니다.
- desktop은 서버 웹 화면을 로드하므로 동일한 훅을 사용합니다. desktop의 기존 첨부 버튼에서 같은 절차를 한 번 확인합니다.
- 취소 확인은 PUT 진행 중 또는 워커 import 진행 중 기존 첨부 삭제 버튼으로 합니다. multipart abort 호출과 워커 `.import-*.tmp` 잔여 파일이 없는 것을 확인합니다.

Linux 워커에서는 `stat`과 `sha256sum`을 사용합니다. Windows 워커에서는 PowerShell `Get-Item -LiteralPath`와 `Get-FileHash -Algorithm SHA256 -LiteralPath`를 사용합니다. 이 명령들은 전체 파일을 문자열로 만들지 않습니다. 경로는 complete 응답의 실제 path를 그대로 사용합니다.

## 테스트 파일과 객체 정리

- 확인에 쓴 세션이 더 이상 파일을 읽지 않는 시점에 기존 `DELETE /api/attachments/sessions/{첨부 session_id}?nodeId=…`로 그 테스트 첨부 디렉토리를 정리합니다. 새 세션 생성 전 첨부의 session_id는 init에 보낸 임시 UUID입니다.
- 응답 path를 확인해 QA 파일만 지웁니다. 사용자 세션 전체나 `INCOMING_FILE_DIR` 전체를 삭제하지 않습니다.
- 중단한 upload ticket으로 abort API를 호출할 수 있습니다. 완료 객체가 남았다면 운영 담당자가 이번 QA 키만 삭제합니다. prefix 전체를 비우지 않습니다.
- 로컬 QA 폴더와 파일을 지웁니다. 위 절차에서 만든 `$attachment_qa_dir`만 대상으로 합니다.

## 지원 범위와 남은 한계

- 이번 PR은 웹/desktop에서 워커 로컬 파일로 전달하는 기능입니다. 기존 GET 다운로드 API는 전체 base64 WS 응답 경로여서 100MiB를 넘는 파일을 읽기 전에 명확히 거부합니다. 큰 첨부를 링크로 다시 내려받는 기능은 제공하지 않습니다.
- iOS `soul-app/src/api/nativeUpload.ts`의 통파일 bytes 경로는 변경하지 않았습니다. 후속에서는 같은 init/PUT/complete 계약을 사용하는 파일 URI 분할 업로드가 필요합니다.
- import 실패 또는 ticket 만료 시 사용자가 다시 첨부합니다. 자동 재시도·재개·새 job 시스템은 추가하지 않습니다.
- 실제 500MiB/GB 전송, Windows/WSL 실행, 운영 프록시 시간 제한과 desktop 실기기 확인은 배포 담당자의 결과가 남아야 완료로 판정할 수 있습니다.
