/**
 * @file QrRenderer.js
 * @description 심볼 바이트 → 캔버스 셀에 QR 렌더링.
 * createQrCanvas()로 OffscreenCanvas를 생성하고
 * ctx.drawImage()로 지정된 셀 영역에 그린다.
 *
 * 렌더링 원칙:
 *   - imageSmoothingEnabled = false: 선명한 QR 모듈 유지
 *   - 정수 픽셀 모듈 크기: 부동소수점 보간 방지
 *   - 배경 순백, 모듈 순흑: OS 다크모드 무관하게 고정
 *
 * 관계:
 *   GridRenderer.js → renderToCanvas() 호출
 *   qr-encoder.js  → createQrCanvas(), calcModuleSize() 사용
 */

"use strict";

import { createQrCanvas, calcModuleSize } from './qr-encoder.js';

export class QrRenderer {

  /**
   * 심볼 바이트를 QR 코드로 인코딩하여 ctx의 지정 영역에 렌더링한다.
   *
   * @param {CanvasRenderingContext2D} ctx 렌더링 컨텍스트
   * @param {Uint8Array} symbolBytes QR로 인코딩할 바이트
   * @param {number} x 셀 왼쪽 상단 X 좌표 (devicePixelRatio 보정 후 실제 픽셀)
   * @param {number} y 셀 왼쪽 상단 Y 좌표
   * @param {number} w 셀 너비 (실제 픽셀)
   * @param {number} h 셀 높이 (실제 픽셀)
   */
  renderToCanvas(ctx, symbolBytes, x, y, w, h) {
    // 모듈당 픽셀 크기를 셀 크기에 맞게 계산 (정수).
    // 셀 픽셀 전체를 모듈 크기로 넘기면 수천 px짜리 OffscreenCanvas가 생성되어
    // 메모리·프레임 드롭을 유발하므로 반드시 모듈 단위로 환산한다.
    const moduleSize = calcModuleSize(symbolBytes, w, h);

    // OffscreenCanvas로 QR 생성 (모듈당 moduleSize px)
    let qrCanvas;
    try {
      qrCanvas = createQrCanvas(symbolBytes, moduleSize);
    } catch (e) {
      // QR 생성 실패 시 (데이터 너무 큼 등) 빈 흰 셀로 대체
      console.warn('[QrRenderer] QR 생성 실패:', e.message);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(x, y, w, h);
      return;
    }

    // 셀 배경을 순백으로 초기화 (QR 주변 여백 처리)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, w, h);

    // 안티앨리어싱 비활성화 (QR 모듈 경계 선명하게)
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;

    // QR 캔버스를 스케일링 없이 원본 크기(정수 모듈)로 셀 중앙에 배치.
    // 확대/축소하면 모듈 경계가 비정수 픽셀에 걸려 카메라 디코딩 성공률이 떨어진다.
    const qrSize = qrCanvas.width;
    const offsetX = x + Math.floor((w - qrSize) / 2);
    const offsetY = y + Math.floor((h - qrSize) / 2);

    ctx.drawImage(qrCanvas, offsetX, offsetY);

    // 이전 smoothing 설정 복원
    ctx.imageSmoothingEnabled = prevSmoothing;
  }
}
