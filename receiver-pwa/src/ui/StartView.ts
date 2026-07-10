/**
 * 파일 목적: 시작 화면 뷰 제어
 * 책임: "카메라 시작" 버튼 표시, 홈 화면 추가 힌트, 에러 메시지 표시
 * 관계: main.ts에서 생성, 카메라 시작 콜백을 받아 버튼 이벤트에 연결
 */

export class StartView {
  private el = document.getElementById('start-view')!;
  private installHint = document.getElementById('install-hint')!;
  private errorMsg = document.getElementById('error-msg')!;
  private cameraBtn = document.getElementById('camera-btn')!;

  /**
   * 시작 뷰 표시.
   * standalone 모드가 아닐 때 홈 화면 추가 힌트도 함께 표시.
   */
  show(): void {
    this.el.classList.add('active');
    // standalone 모드가 아닐 때만 설치 힌트 표시
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    if (!isStandalone) {
      this.installHint.style.display = 'block';
    }
  }

  /** 시작 뷰 숨김 */
  hide(): void {
    this.el.classList.remove('active');
    this.errorMsg.style.display = 'none';
  }

  /**
   * 카메라 시작 버튼 클릭 핸들러 등록.
   * @param cb 버튼 클릭 시 호출될 콜백
   */
  onCameraClick(cb: () => void): void {
    this.cameraBtn.addEventListener('click', cb);
  }

  /**
   * 에러 메시지 표시 (카메라 권한 거부 등).
   * @param msg 표시할 에러 문자열
   */
  showError(msg: string): void {
    this.errorMsg.textContent = msg;
    this.errorMsg.style.display = 'block';
  }
}
