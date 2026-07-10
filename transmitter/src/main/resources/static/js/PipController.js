/**
 * @file PipController.js
 * @description Document Picture-in-Picture(PiP) 제어.
 * QR 렌더 캔버스를 항상 위에 떠 있는 PiP 창으로 이동하거나 메인 창으로 복귀시킨다.
 *
 * Document PiP는 일반 HTMLVideoElement PiP와 달리 임의 DOM을 독립 창에 표시한다.
 * (Chrome 116+ 지원: https://developer.chrome.com/docs/web-platform/document-picture-in-picture)
 *
 * 지원 여부 확인: isSupported()
 *   - 미지원 브라우저: PiP 버튼 비활성화
 *
 * PiP 창에서 rAF 전환:
 *   - PiP 창 진입 시 GridRenderer.usePipRaf() 호출 → pipWindow.requestAnimationFrame 사용
 *   - 메인 창 복귀 시 GridRenderer.useMainRaf() 호출 → window.requestAnimationFrame 복원
 *
 * 관계:
 *   GridRenderer.js → usePipRaf(), useMainRaf() 호출받음
 *   main.js         → PipController 인스턴스 생성, toggle() 호출
 *   TransmitView.js → pip 버튼 이벤트 연결
 */

"use strict";

export class PipController {

  /**
   * @param {HTMLCanvasElement} canvas QR 렌더 캔버스
   * @param {GridRenderer} renderer GridRenderer 인스턴스
   * @param {HTMLButtonElement} pipBtn PiP 토글 버튼
   */
  constructor(canvas, renderer, pipBtn) {
    this.canvas   = canvas;
    this.renderer = renderer;
    this.pipBtn   = pipBtn;

    this._pipWindow = null; // 현재 PiP 창 참조
    this._originalParent = null; // 캔버스 원래 부모 요소
  }

  // ─────────────────────────────────────────────
  // 공개 API
  // ─────────────────────────────────────────────

  /**
   * Document Picture-in-Picture 지원 여부 확인.
   * @returns {boolean}
   */
  isSupported() {
    return 'documentPictureInPicture' in window;
  }

  /**
   * PiP 상태를 토글한다.
   * PiP 창이 없으면 enter(), 있으면 exit().
   */
  async toggle() {
    if (this._pipWindow) {
      this.exit();
    } else {
      await this.enter();
    }
  }

  /**
   * PiP 창을 열고 캔버스를 이동한다.
   * 실패 시 콘솔에 경고만 출력하고 메인 창 렌더 유지.
   */
  async enter() {
    if (!this.isSupported()) {
      alert('이 브라우저는 Document Picture-in-Picture를 지원하지 않습니다.\n(Chrome 116+ 필요)');
      return;
    }

    if (this._pipWindow) return; // 이미 PiP 중

    try {
      // 캔버스 현재 크기로 PiP 창 요청
      const pipW = this.canvas.clientWidth  || 800;
      const pipH = this.canvas.clientHeight || 600;

      this._pipWindow = await window.documentPictureInPicture.requestWindow({
        width:  Math.min(pipW, window.screen.width),
        height: Math.min(pipH, window.screen.height),
      });

      // PiP 창에 기본 스타일 적용 (배경 흰색)
      const style = this._pipWindow.document.createElement('style');
      style.textContent = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #fff; overflow: hidden; }
        canvas { display: block; width: 100%; height: 100vh; }
      `;
      this._pipWindow.document.head.appendChild(style);

      // 캔버스를 PiP 창으로 이동
      this._originalParent = this.canvas.parentElement;
      this._pipWindow.document.body.appendChild(this.canvas);

      // GridRenderer에 PiP rAF 소스로 전환 요청
      this.renderer.usePipRaf(this._pipWindow, this._pipWindow.requestAnimationFrame.bind(this._pipWindow));

      // PiP 창 닫힘 이벤트 (사용자가 X 버튼으로 닫을 때)
      this._pipWindow.addEventListener('pagehide', () => {
        this._onPipClose();
      });

      // 버튼 텍스트 변경
      if (this.pipBtn) {
        this.pipBtn.textContent = '항상 위 해제';
        this.pipBtn.classList.add('pip-active');
      }

    } catch (e) {
      console.warn('[PipController] PiP 창 열기 실패:', e.message);
      this._pipWindow = null;
    }
  }

  /**
   * PiP 창을 닫고 캔버스를 메인 문서로 복귀시킨다.
   */
  exit() {
    if (!this._pipWindow) return;

    try {
      this._pipWindow.close();
    } catch (e) {
      // 이미 닫혔을 수 있음 — 무시
    }

    this._onPipClose();
  }

  // ─────────────────────────────────────────────
  // 내부 메서드
  // ─────────────────────────────────────────────

  /**
   * PiP 창이 닫힐 때 정리 작업.
   * 캔버스를 원래 부모로 복귀시키고 rAF 소스를 메인으로 전환.
   */
  _onPipClose() {
    if (!this._pipWindow) return;

    // 캔버스를 원래 위치로 복귀
    if (this._originalParent && this.canvas.parentElement !== this._originalParent) {
      try {
        this._originalParent.appendChild(this.canvas);
      } catch (e) {
        // DOM 오류 무시
      }
    }

    // rAF 소스를 메인 window로 복원
    this.renderer.useMainRaf();

    this._pipWindow = null;
    this._originalParent = null;

    // 버튼 텍스트 복원
    if (this.pipBtn) {
      this.pipBtn.textContent = '항상 위 (PiP)';
      this.pipBtn.classList.remove('pip-active');
    }
  }
}
