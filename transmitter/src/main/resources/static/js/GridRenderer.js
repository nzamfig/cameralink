/**
 * @file GridRenderer.js
 * @description requestAnimationFrame 기반 격자 QR 렌더 루프.
 * LayoutManager로 현재 레이아웃을 계산하고, LtEncoder로 심볼을 생성하며,
 * QrRenderer로 각 셀에 QR을 그린다.
 *
 * 렌더 루프 설계:
 *   - TARGET_FPS(10fps): 타임스탬프 기반 레이트 제어 (1000/fps ms 간격)
 *   - 매 HEADER_INTERVAL(8)프레임마다 셀[0]에 헤더 심볼 삽입
 *   - 헤더는 현재 레이아웃의 gridByte로 인코딩 (grid 변경 시에만 재직렬화, 캐시 사용)
 *     → 수신기 경로 B가 헤더의 grid로 격자를 lock하므로 실제 격자와 일치해야 함
 *   - 나머지 셀: 단조 증가하는 seed로 LT 데이터 심볼 생성
 *   - devicePixelRatio 보정: 캔버스 backing store = CSS 크기 × dPR
 *   - Wake Lock: navigator.wakeLock.request('screen') 으로 화면 켜짐 유지
 *   - visibility change: 숨겨지면 렌더 일시 정지 (배터리 절약)
 *
 * 관계:
 *   LayoutManager → compute() 로 격자 레이아웃 획득
 *   LtEncoder     → nextSymbol() 로 페이로드 생성
 *   QrRenderer    → renderToCanvas() 로 셀에 QR 그리기
 *   PipController → requestAnimationFrame 소스 교체 (main ↔ pip window)
 *   shared-protocol/ → encodeHeader, encodeDataSymbol, DEFAULT_FPS, HEADER_INTERVAL
 */

"use strict";

import { encodeHeader, encodeDataSymbol, DEFAULT_FPS, HEADER_INTERVAL } from './shared-protocol/index.js';
import { LayoutManager } from './LayoutManager.js';
import { QrRenderer } from './QrRenderer.js';

export class GridRenderer {

  /**
   * @param {HTMLCanvasElement} canvas 렌더링 대상 캔버스
   * @param {LayoutManager} layoutManager 레이아웃 계산기
   * @param {LtEncoder} encoder LT 인코더 인스턴스
   * @param {object} headerMeta 헤더 심볼 메타 (grid 제외 — flags, filename,
   *                 originalSize, storedSize, payloadSize, totalBlocks, crc32)
   */
  constructor(canvas, layoutManager, encoder, headerMeta) {
    this.canvas        = canvas;
    this.layoutManager = layoutManager;
    this.encoder       = encoder;
    this.headerMeta    = headerMeta;
    this.qrRenderer    = new QrRenderer();

    // 헤더 직렬화 캐시: grid 바이트가 바뀔 때만 재인코딩 (메타는 전송 중 불변)
    this._headerCache = { gridByte: -1, bytes: null };

    // 렌더 루프 상태
    this._running      = false;
    this._frameCount   = 0;   // 전체 프레임 카운터 (헤더 삽입 간격 계산)
    this._seed         = 1;   // LT 심볼 seed (단조 증가)
    this._rafId        = null; // requestAnimationFrame ID
    this._rafSource    = null; // null = window.requestAnimationFrame (PiP 전환 시 교체)

    // 레이트 제어
    this._lastFrameTime = 0;
    this._frameInterval = 1000 / DEFAULT_FPS; // ms per frame

    // Wake Lock 핸들
    this._wakeLock = null;

    // devicePixelRatio 보정용 리사이즈 옵저버
    this._resizeObserver = null;

    // this 바인딩 (rAF 콜백에서 this 유지)
    this._loop = this._loop.bind(this);
  }

  // ─────────────────────────────────────────────
  // 공개 API
  // ─────────────────────────────────────────────

  /**
   * 렌더 루프를 시작한다.
   * Wake Lock 요청, 캔버스 크기 보정, visibility change 구독.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    this._lastFrameTime = 0;

    // devicePixelRatio 대응 캔버스 크기 설정
    this._resizeCanvas();

    // ResizeObserver: 창 크기 변경 시 캔버스 재보정
    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObserver.observe(this.canvas);

    // Wake Lock: 화면 꺼짐 방지 (사용자 동의 필요 없음, 조용히 실패)
    await this._requestWakeLock();

    // visibility change: 창 숨겨지면 렌더 일시 정지
    this._onVisibilityChange = () => {
      if (document.hidden) {
        this._pauseLoop();
      } else {
        this._resumeLoop();
        this._requestWakeLock(); // 복귀 시 Wake Lock 재요청
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // 렌더 루프 시작
    this._rafId = requestAnimationFrame(this._loop);
  }

  /**
   * 렌더 루프를 중지하고 모든 리소스를 해제한다.
   */
  stop() {
    this._running = false;

    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Wake Lock 해제
    if (this._wakeLock) {
      this._wakeLock.release().catch(() => {});
      this._wakeLock = null;
    }

    // ResizeObserver 해제
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    // visibility change 리스너 제거
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }

    // 캔버스 초기화 (흰색)
    const ctx = this.canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /**
   * PipController가 PiP 창으로 이동할 때 호출.
   * requestAnimationFrame 소스를 pipWindow로 교체한다.
   *
   * @param {Window} pipWindow Document Picture-in-Picture 창
   * @param {Function} rafFn pipWindow.requestAnimationFrame
   */
  usePipRaf(pipWindow, rafFn) {
    // 기존 rAF 취소
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
    }
    this._rafSource = rafFn;
    if (this._running) {
      this._rafId = rafFn(this._loop);
    }
  }

  /**
   * PipController가 메인 창으로 복귀할 때 호출.
   * requestAnimationFrame 소스를 window로 복원한다.
   */
  useMainRaf() {
    this._rafSource = null; // null = window.requestAnimationFrame 사용
    if (this._running && this._rafId === null) {
      this._rafId = requestAnimationFrame(this._loop);
    }
  }

  // ─────────────────────────────────────────────
  // 내부 렌더 루프
  // ─────────────────────────────────────────────

  /**
   * requestAnimationFrame 콜백 — 레이트 제어 후 프레임 그리기.
   * @param {DOMHighResTimeStamp} timestamp
   */
  _loop(timestamp) {
    if (!this._running) return;

    // 레이트 제어: 목표 fps에 맞는 간격이 지났을 때만 그리기
    const elapsed = timestamp - this._lastFrameTime;
    if (elapsed >= this._frameInterval) {
      this._lastFrameTime = timestamp - (elapsed % this._frameInterval);
      this._drawFrame();
      this._frameCount++;
    }

    // 다음 프레임 예약 (rAF 소스에 따라 교체 가능)
    // this._rafSource가 PiP 창의 rAF이면 그것을 사용, 없으면 메인 window
    const raf = this._rafSource ?? requestAnimationFrame.bind(window);
    this._rafId = raf(this._loop);
  }

  /** 렌더 루프 일시 정지 */
  _pauseLoop() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** 렌더 루프 재개 */
  _resumeLoop() {
    if (this._running && this._rafId === null) {
      this._lastFrameTime = 0; // 레이트 제어 리셋
      const raf = this._rafSource || requestAnimationFrame;
      this._rafId = raf(this._loop);
    }
  }

  // ─────────────────────────────────────────────
  // 프레임 렌더링
  // ─────────────────────────────────────────────

  /**
   * 한 프레임을 그린다.
   * 레이아웃 계산 → fiducial 마커 → 헤더(8프레임마다) → 데이터 심볼.
   */
  _drawFrame() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    // 현재 레이아웃 계산
    const layout = this.layoutManager.compute();
    if (!layout) {
      // 공간 부족: 빈 흰 화면
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }

    const { cols, rows, cellW, cellH, cells, fiducials, gridByte } = layout;

    // devicePixelRatio: CSS 픽셀 → 실제 픽셀 배율
    const dpr = window.devicePixelRatio || 1;

    // 전체 배경: 순백 (OS 다크모드 무관)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // ── Fiducial 마커 (4모서리 단색 원) ─────────────────────────────────
    this._drawFiducials(ctx, fiducials, dpr);

    // ── 헤더 심볼: 매 HEADER_INTERVAL 프레임마다 셀[0]에 삽입 ──────────
    const isHeaderFrame = (this._frameCount % HEADER_INTERVAL) === 0;

    // ── 각 셀에 QR 렌더 ────────────────────────────────────────────────
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      // dpr 보정 실제 픽셀 좌표
      const px = Math.floor(cell.x * dpr);
      const py = Math.floor(cell.y * dpr);
      const pw = Math.floor(cell.w * dpr);
      const ph = Math.floor(cell.h * dpr);

      let symbolBytes;
      if (i === 0 && isHeaderFrame) {
        // 셀[0]: 헤더 심볼 — 반드시 현재 레이아웃의 gridByte로 인코딩
        symbolBytes = this._getHeaderBytes(gridByte);
      } else {
        // 나머지 셀: LT 데이터 심볼 생성
        const { payload } = this.encoder.nextSymbol(this._seed);
        symbolBytes = encodeDataSymbol({
          grid:       gridByte,
          seed:       this._seed,
          payloadLen: payload.length,
          payload,
        });
        this._seed = (this._seed + 1) >>> 0; // 32비트 부호 없는 정수 증가
      }

      // QR 렌더링 (안티앨리어싱 비활성화)
      ctx.imageSmoothingEnabled = false;
      this.qrRenderer.renderToCanvas(ctx, symbolBytes, px, py, pw, ph);
    }
  }

  /**
   * 현재 gridByte에 맞는 헤더 심볼 바이트를 반환한다.
   * 창 리사이즈로 격자가 바뀌었을 때만 재직렬화하고 그 외에는 캐시를 재사용한다.
   *
   * @param {number} gridByte 현재 레이아웃의 grid 바이트 (cols<<4 | rows)
   * @returns {Uint8Array}
   */
  _getHeaderBytes(gridByte) {
    if (this._headerCache.gridByte !== gridByte) {
      this._headerCache = {
        gridByte,
        bytes: encodeHeader({ ...this.headerMeta, grid: gridByte }),
      };
    }
    return this._headerCache.bytes;
  }

  /**
   * Fiducial 마커(단색 원)를 그린다.
   * QR finder 패턴(▣)과 구별되는 원형으로 오검출 방지.
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<{x,y,r}>} fiducials
   * @param {number} dpr devicePixelRatio
   */
  _drawFiducials(ctx, fiducials, dpr) {
    ctx.fillStyle = '#000000';
    for (const { x, y, r } of fiducials) {
      ctx.beginPath();
      ctx.arc(
        Math.floor(x * dpr),
        Math.floor(y * dpr),
        Math.floor(r * dpr),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  // ─────────────────────────────────────────────
  // 캔버스 크기 보정 (devicePixelRatio)
  // ─────────────────────────────────────────────

  /**
   * devicePixelRatio에 맞게 캔버스 backing store 크기를 조정한다.
   * CSS 크기는 그대로 유지하고 실제 픽셀 수만 증가.
   */
  _resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    if (w === 0 || h === 0) return;

    const targetW = Math.floor(w * dpr);
    const targetH = Math.floor(h * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width  = targetW;
      this.canvas.height = targetH;
    }
  }

  // ─────────────────────────────────────────────
  // Wake Lock
  // ─────────────────────────────────────────────

  /**
   * Screen Wake Lock을 요청한다.
   * 미지원 브라우저나 권한 거부 시 조용히 무시한다.
   */
  async _requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      // Wake Lock이 자동 해제될 때 핸들 null 처리
      this._wakeLock.addEventListener('release', () => {
        this._wakeLock = null;
      });
    } catch (e) {
      // 권한 거부 또는 미지원: 무시 (렌더는 계속됨)
      console.debug('[GridRenderer] Wake Lock 획득 실패:', e.message);
    }
  }
}
