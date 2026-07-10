/**
 * 파일 목적: 수신 완료 뷰 제어
 * 책임: 완료 화면 표시/숨김, 진동+비프음 알림, 저장/재시작 버튼 콜백 연결
 * 관계: main.ts에서 onComplete 콜백 수신 후 호출됨
 */

export class ResultView {
  private el = document.getElementById('result-view')!;
  private filenameEl = document.getElementById('result-filename')!;
  private saveBtn = document.getElementById('save-btn')!;
  private restartBtn = document.getElementById('restart-btn')!;

  /**
   * 완료 뷰 표시.
   * @param filename 수신된 파일명
   */
  show(filename: string): void {
    this.filenameEl.textContent = filename;
    this.el.classList.add('active');
  }

  /** 완료 뷰 숨김 */
  hide(): void {
    this.el.classList.remove('active');
  }

  /**
   * 저장 버튼 클릭 핸들러 등록.
   * 반드시 사용자 탭 제스처 맥락에서 파일 저장을 수행해야 하므로
   * 이 이벤트 핸들러에서만 FileSaver를 호출해야 함.
   * @param cb 저장 버튼 클릭 시 호출될 콜백
   */
  onSaveClick(cb: () => void): void {
    this.saveBtn.addEventListener('click', cb);
  }

  /**
   * 다시 수신 버튼 클릭 핸들러 등록.
   * @param cb 다시 수신 버튼 클릭 시 호출될 콜백
   */
  onRestartClick(cb: () => void): void {
    this.restartBtn.addEventListener('click', cb);
  }

  /**
   * 수신 완료 알림: 진동(200ms) + 비프음(880Hz, 0.3초).
   * 진동은 모바일에서만 동작하고, AudioContext는 사용자 제스처 없이도
   * 첫 완료 시 즉시 재생 가능(재생 정책은 브라우저마다 다를 수 있음).
   */
  async notifyCompletion(): Promise<void> {
    // 진동: 모바일 기기 (지원하지 않는 기기에서는 조용히 무시)
    navigator.vibrate?.(200);

    // 비프음: Web Audio API로 880Hz 사인파 0.3초 재생
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      // 음량: 0.3에서 시작해 0.3초 후 무음으로 지수 감쇠 (클릭 방지)
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
      // AudioContext를 열어둔 채로 오실레이터 종료 후 자원 정리
      osc.addEventListener('ended', () => ctx.close());
    } catch {
      // Web Audio API 미지원 기기에서 조용히 무시
    }
  }
}
