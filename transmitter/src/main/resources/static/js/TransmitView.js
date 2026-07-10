/**
 * @file TransmitView.js
 * @description 화면 2: 전송 애니메이션 뷰 컴포넌트.
 * QR 격자 캔버스, PiP 버튼, 중지 버튼, 가시성 경고 배너를 관리한다.
 *
 * visibility 처리:
 *   - visibilitychange 이벤트: 창이 숨겨지면 경고 배너 표시
 *   - 창이 다시 보이면 배너 숨김
 *
 * 키보드:
 *   - ESC 키 → onStop() 콜백 호출
 *
 * 관계:
 *   main.js        → TransmitView 인스턴스 생성, onStop 콜백 연결
 *   PipController  → pipBtn 요소 전달
 *   GridRenderer   → canvas 요소 공유
 *   index.html     → #transmit-view, #qr-canvas, #pip-btn, #stop-btn, #visibility-hint
 */

"use strict";

export class TransmitView {

  /**
   * @param {HTMLElement} el #transmit-view 루트 요소
   * @param {HTMLElement} canvas #qr-canvas 요소
   * @param {HTMLButtonElement} pipBtn #pip-btn 요소
   * @param {HTMLButtonElement} stopBtn #stop-btn 요소
   * @param {HTMLElement} hintEl #visibility-hint 요소
   * @param {() => void} onStop 중지 버튼/ESC 콜백
   */
  constructor(el, canvas, pipBtn, stopBtn, hintEl, onStop) {
    this.el      = el;
    this.canvas  = canvas;
    this.pipBtn  = pipBtn;
    this.stopBtn = stopBtn;
    this.hintEl  = hintEl;
    this.onStop  = onStop;

    // 이벤트 리스너 참조 (해제용)
    this._onKeyDown = null;
    this._onVisibilityChange = null;
  }

  // ─────────────────────────────────────────────
  // 공개 API
  // ─────────────────────────────────────────────

  /**
   * 전송 뷰를 표시하고 이벤트 리스너를 등록한다.
   */
  show() {
    if (this.el) this.el.hidden = false;

    // ESC 키: 중지
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.onStop();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    // visibility change: 창 숨겨지면 경고 배너 표시
    this._onVisibilityChange = () => {
      if (document.hidden) {
        this.hintEl.hidden = false;
      } else {
        this.hintEl.hidden = true;
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // 초기 상태: 경고 배너 숨김
    this.hintEl.hidden = true;
  }

  /**
   * 전송 뷰를 숨기고 이벤트 리스너를 제거한다.
   */
  hide() {
    if (this.el) this.el.hidden = true;

    // 키보드 리스너 해제
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }

    // visibility 리스너 해제
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }

    // 경고 배너 초기화
    this.hintEl.hidden = true;
  }
}
