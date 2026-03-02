#!/bin/bash
# sync-serendipity-plugin.sh
# Soul 플러그인을 Soulstream에서 Serendipity로 동기화하는 스크립트
#
# Usage: ./scripts/sync-serendipity-plugin.sh [options] [serendipity-path]
#
# Options:
#   -b, --backup    기존 파일을 백업 (.bak 확장자)
#   -f, --force     확인 없이 덮어쓰기
#   -d, --dry-run   실제 복사 없이 시뮬레이션
#   -h, --help      도움말 출력
#
# Examples:
#   ./scripts/sync-serendipity-plugin.sh                    # 기본 경로 사용
#   ./scripts/sync-serendipity-plugin.sh ../serendipity     # 커스텀 경로
#   ./scripts/sync-serendipity-plugin.sh -b                 # 백업 후 복사
#   ./scripts/sync-serendipity-plugin.sh -d                 # 드라이런

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 스크립트 위치 기준으로 경로 설정
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOULSTREAM_ROOT="$(dirname "$SCRIPT_DIR")"

# 기본 설정
BACKUP=false
FORCE=false
DRY_RUN=false
SERENDIPITY_PATH=""

# 소스 및 타겟 경로
SOURCE_DIR="$SOULSTREAM_ROOT/packages/serendipity-plugin/src"
TARGET_SUBDIR="packages/web/src/plugins/soul"

# 헬프 메시지
show_help() {
    echo "Usage: $(basename "$0") [options] [serendipity-path]"
    echo ""
    echo "Soul 플러그인을 Soulstream에서 Serendipity로 동기화합니다."
    echo ""
    echo "Options:"
    echo "  -b, --backup    기존 파일을 백업 (.bak 확장자)"
    echo "  -f, --force     확인 없이 덮어쓰기"
    echo "  -d, --dry-run   실제 복사 없이 시뮬레이션"
    echo "  -h, --help      도움말 출력"
    echo ""
    echo "Arguments:"
    echo "  serendipity-path  Serendipity 레포 경로 (기본: ../../serendipity)"
    echo ""
    echo "Examples:"
    echo "  $(basename "$0")                     # 기본 경로 사용"
    echo "  $(basename "$0") ../serendipity      # 커스텀 경로"
    echo "  $(basename "$0") -b                  # 백업 후 복사"
    echo "  $(basename "$0") -d                  # 드라이런"
}

# 로깅 함수
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 인자 파싱
while [[ $# -gt 0 ]]; do
    case $1 in
        -b|--backup)
            BACKUP=true
            shift
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        -*)
            log_error "알 수 없는 옵션: $1"
            show_help
            exit 1
            ;;
        *)
            SERENDIPITY_PATH="$1"
            shift
            ;;
    esac
done

# 기본 Serendipity 경로 설정
if [ -z "$SERENDIPITY_PATH" ]; then
    SERENDIPITY_PATH="$SOULSTREAM_ROOT/../serendipity"
fi

# 절대 경로로 변환
SERENDIPITY_PATH="$(cd "$SERENDIPITY_PATH" 2>/dev/null && pwd)" || {
    log_error "Serendipity 경로를 찾을 수 없습니다: $SERENDIPITY_PATH"
    exit 1
}

TARGET_DIR="$SERENDIPITY_PATH/$TARGET_SUBDIR"

# 헤더 출력
echo ""
echo "=================================================="
echo "  Soul Plugin Sync: Soulstream → Serendipity"
echo "=================================================="
echo ""

# 설정 출력
log_info "소스 경로: $SOURCE_DIR"
log_info "타겟 경로: $TARGET_DIR"
log_info "백업 모드: $([ "$BACKUP" = true ] && echo "활성화" || echo "비활성화")"
log_info "드라이런: $([ "$DRY_RUN" = true ] && echo "활성화" || echo "비활성화")"
echo ""

# 소스 디렉토리 확인
if [ ! -d "$SOURCE_DIR" ]; then
    log_error "소스 디렉토리가 존재하지 않습니다: $SOURCE_DIR"
    exit 1
fi

# 타겟 디렉토리 확인 및 생성
if [ ! -d "$TARGET_DIR" ]; then
    log_warn "타겟 디렉토리가 존재하지 않습니다. 생성합니다: $TARGET_DIR"
    if [ "$DRY_RUN" = false ]; then
        mkdir -p "$TARGET_DIR"
    fi
fi

# 복사할 파일 목록
FILES=$(find "$SOURCE_DIR" -type f -name "*.ts" -o -name "*.tsx" -o -name "*.css" -o -name "*.json" | sort)
FILE_COUNT=$(echo "$FILES" | wc -l)

log_info "복사할 파일 수: $FILE_COUNT"
echo ""

# 확인 프롬프트 (--force가 아닌 경우)
if [ "$FORCE" = false ] && [ "$DRY_RUN" = false ]; then
    echo -e "${YELLOW}다음 파일들이 복사됩니다:${NC}"
    for file in $FILES; do
        rel_path="${file#$SOURCE_DIR/}"
        echo "  - $rel_path"
    done
    echo ""
    read -p "계속하시겠습니까? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_warn "작업이 취소되었습니다."
        exit 0
    fi
fi

# 백업 수행
if [ "$BACKUP" = true ] && [ "$DRY_RUN" = false ]; then
    BACKUP_DIR="$TARGET_DIR.bak.$(date +%Y%m%d_%H%M%S)"
    if [ -d "$TARGET_DIR" ]; then
        log_info "백업 생성 중: $BACKUP_DIR"
        cp -r "$TARGET_DIR" "$BACKUP_DIR"
        log_success "백업 완료"
    fi
fi

# 파일 복사
log_info "파일 복사 중..."
echo ""

for file in $FILES; do
    rel_path="${file#$SOURCE_DIR/}"
    target_file="$TARGET_DIR/$rel_path"
    target_dir="$(dirname "$target_file")"

    if [ "$DRY_RUN" = true ]; then
        echo -e "  ${BLUE}[DRY-RUN]${NC} $rel_path → $target_file"
    else
        # 하위 디렉토리 생성
        mkdir -p "$target_dir"

        # 파일 복사
        cp "$file" "$target_file"
        echo -e "  ${GREEN}[COPIED]${NC} $rel_path"
    fi
done

echo ""

# 복사된 파일 확인 (드라이런 아닌 경우)
if [ "$DRY_RUN" = false ]; then
    log_success "모든 파일이 성공적으로 복사되었습니다!"
    echo ""
    log_info "복사된 파일 목록:"
    ls -la "$TARGET_DIR"
else
    log_info "드라이런 완료. 실제 복사는 수행되지 않았습니다."
fi

echo ""
echo "=================================================="
echo "  동기화 완료!"
echo "=================================================="
echo ""

# 다음 단계 안내
if [ "$DRY_RUN" = false ]; then
    log_info "다음 단계:"
    echo "  1. cd $SERENDIPITY_PATH"
    echo "  2. pnpm install (필요시)"
    echo "  3. pnpm build (빌드 테스트)"
    echo "  4. pnpm dev (개발 서버 실행)"
fi
