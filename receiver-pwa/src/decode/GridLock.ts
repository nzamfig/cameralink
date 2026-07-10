/**
 * 파일 목적: 격자 크기 부트스트랩 및 lock 관리 (경로 B용)
 * 책임: 최초 심볼 수신 전까지 격자 후보 탐색, 심볼의 grid 바이트로 즉시 lock,
 *        연속 실패 또는 grid 바이트 변경 시 unlock 후 재탐색
 * 관계: QrDecoder, CellExtractor와 협력하여 격자 크기를 결정
 *
 * "닭-달걀 문제" 해결:
 * 격자 크기를 모르면 셀을 크롭할 수 없고, 셀을 크롭해야 격자 크기를 알 수 있음.
 * 해결책: 1×1부터 최대 격자 크기까지 순차 시도하고,
 * 최초 성공한 심볼의 grid 바이트(상위 4비트=cols, 하위 4비트=rows)로 즉시 lock.
 *
 * grid 바이트 레이아웃:
 * 상위 4비트 = 열 수 (cols), 하위 4비트 = 행 수 (rows)
 * 예: grid=0x44 → cols=4, rows=4 (4×4 격자)
 */

/** 격자 lock 상태 없을 때 탐색할 최대 격자 크기 */
const MAX_GRID_SIZE = 8;

/** 연속으로 이 횟수만큼 심볼 검출 실패 시 lock 해제 (재탐색) */
const MAX_FAILS_BEFORE_UNLOCK = 30;

export class GridLock {
  private locked = false;
  private lockedCols = 0;
  private lockedRows = 0;
  private failCount = 0;

  /** 현재 격자 크기가 lock되어 있는지 */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * 현재 lock된 격자 크기 반환.
   * lock 안 되어 있으면 null.
   */
  getGrid(): { cols: number; rows: number } | null {
    return this.locked ? { cols: this.lockedCols, rows: this.lockedRows } : null;
  }

  /**
   * 수신된 심볼의 grid 바이트로 격자 크기 lock.
   * @param gridByte 심볼 헤더의 grid 바이트 (상위4비트=cols, 하위4비트=rows)
   */
  lock(gridByte: number): void {
    const cols = (gridByte >> 4) & 0xF;
    const rows = gridByte & 0xF;

    // 유효하지 않은 격자 크기(0) 무시
    if (cols <= 0 || rows <= 0) return;

    this.lockedCols = cols;
    this.lockedRows = rows;
    this.locked = true;
    this.failCount = 0;
  }

  /**
   * 이미 lock된 상태에서 다른 grid 바이트가 수신될 때 호출.
   * 새 전송이 시작된 것이므로 unlock 후 재lock.
   * @param gridByte 새로 수신된 grid 바이트
   */
  updateGrid(gridByte: number): void {
    this.unlock();
    this.lock(gridByte);
  }

  /** 심볼 검출 성공 시 호출: 실패 카운터 초기화 */
  onSuccess(): void {
    this.failCount = 0;
  }

  /**
   * 심볼 검출 실패 시 호출.
   * 연속 실패가 MAX_FAILS_BEFORE_UNLOCK 이상이면 lock 해제.
   */
  onFailure(): void {
    this.failCount++;
    if (this.failCount >= MAX_FAILS_BEFORE_UNLOCK) {
      this.unlock();
    }
  }

  /** lock 해제 및 상태 초기화 (새 탐색 시작) */
  unlock(): void {
    this.locked = false;
    this.lockedCols = 0;
    this.lockedRows = 0;
    this.failCount = 0;
  }

  /**
   * lock 안 된 상태에서 탐색할 격자 후보 목록 반환.
   * 1×1부터 MAX_GRID_SIZE×MAX_GRID_SIZE까지의 조합.
   * (실제 사용은 헤더 심볼 수신 전 첫 셀(0,0)에서만 시도)
   */
  getCandidates(): { cols: number; rows: number }[] {
    const candidates: { cols: number; rows: number }[] = [];
    for (let s = 1; s <= MAX_GRID_SIZE; s++) {
      candidates.push({ cols: s, rows: s });
    }
    return candidates;
  }
}
