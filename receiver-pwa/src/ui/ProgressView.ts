/**
 * 파일 목적: 수신 진행률 바 UI 제어
 * 책임: 진행률(0~1)을 받아 바 너비와 퍼센트 텍스트 갱신
 * 관계: ReceivePipeline의 onProgress 콜백에서 호출됨
 */

export class ProgressView {
  private bar = document.getElementById('progress-bar')!;
  private text = document.getElementById('progress-text')!;

  /**
   * 진행률 갱신.
   * @param ratio 0~1 범위의 진행률
   */
  update(ratio: number): void {
    const pct = Math.round(ratio * 100);
    this.bar.style.width = `${pct}%`;
    this.text.textContent = `${pct}%`;
  }

  /** 진행률 초기화 (새 수신 시작 시) */
  reset(): void {
    this.update(0);
  }
}
