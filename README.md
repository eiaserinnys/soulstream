# Soulstream

Claude Code 원격 실행 서비스. 세션 관리, SSE 스트리밍, 실시간 대시보드를 제공합니다.

## 구조

```
soulstream/
├── soul-server/      # FastAPI 실행 서버 (Python)
├── soul-client/      # Python HTTP+SSE 클라이언트
└── soul-dashboard/   # React + Express 대시보드 (TypeScript)
```

## 빠른 시작

### soul-server

```bash
cd soul-server
pip install -e ".[dev]"
python -m soul_server.main
```

### soul-dashboard

```bash
cd soul-dashboard
npm install
npm run dev
```
