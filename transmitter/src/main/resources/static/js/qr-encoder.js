/**
 * @file qr-encoder.js
 * @description QR 코드 생성 헬퍼.
 * js/lib/qrcodegen.js 라이브러리를 감싸서 Uint8Array → OffscreenCanvas 변환을 제공한다.
 * 항상 BYTE 모드로 인코딩하여 이진 데이터를 안전하게 처리한다.
 *
 * 사용법:
 *   const canvas = createQrCanvas(uint8Array, cellSizePx);
 *   ctx.drawImage(canvas, x, y, w, h);
 *
 * 관계:
 *   QrRenderer.js → createQrCanvas() 호출
 *   js/lib/qrcodegen.js → QrCode, QrSegment, QrCode.Ecc 사용
 */

import { QrCode, QrSegment } from './lib/qrcodegen.js';

/**
 * Uint8Array를 BYTE 모드 QR 코드로 인코딩하여 OffscreenCanvas를 반환한다.
 *
 * @param {Uint8Array} bytes 인코딩할 바이트 배열
 * @param {number} moduleSizePx QR 모듈 1개당 픽셀 크기 (정수 권장 — calcModuleSize로 계산)
 * @returns {OffscreenCanvas} QR 코드가 렌더링된 캔버스
 */
export function createQrCanvas(bytes, moduleSizePx) {
  // BYTE 모드로 세그먼트 생성 (문자열 변환 없이 바이너리 안전)
  const seg = QrSegment.makeBytes(bytes);

  // ECC M 레벨로 QR 코드 생성 (15% 오류 복원)
  // 버전은 자동 선택 (1~40)
  const qr = QrCode.encodeSegments([seg], QrCode.Ecc.MEDIUM);

  // 모듈당 픽셀 크기를 정수로 보정 (antialiasing 방지)
  const moduleSize = Math.max(1, Math.floor(moduleSizePx));

  // QR 전체 크기 = (quiet zone * 2 + qr.size) * moduleSize
  // 조용한 구역(quiet zone) = 4 모듈 (QR 규격 최소 요구사항)
  const quietZone = 4;
  const totalModules = quietZone * 2 + qr.size;
  const canvasSize = totalModules * moduleSize;

  // OffscreenCanvas 생성 (메인 스레드 캔버스 없이 렌더 가능)
  const offscreen = new OffscreenCanvas(canvasSize, canvasSize);
  const ctx = offscreen.getContext('2d');

  // 배경: 순백 (OS 다크모드 무관하게 고정)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  // 모듈 렌더링: 검정 모듈만 그림 (배경은 이미 흰색)
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        // quiet zone 오프셋 적용 후 정수 픽셀 좌표로 그리기
        ctx.fillRect(
          (quietZone + x) * moduleSize,
          (quietZone + y) * moduleSize,
          moduleSize,
          moduleSize
        );
      }
    }
  }

  return offscreen;
}

/**
 * QR 코드의 모듈 크기를 계산한다 (cellW, cellH 중 작은 값 기준).
 * GridRenderer가 셀에 QR을 꽉 맞게 그릴 때 사용.
 *
 * @param {Uint8Array} bytes 인코딩할 바이트
 * @param {number} cellW 셀 너비(px)
 * @param {number} cellH 셀 높이(px)
 * @returns {number} 모듈당 픽셀 크기 (정수, 최소 1)
 */
export function calcModuleSize(bytes, cellW, cellH) {
  // 임시 QR 생성으로 모듈 수 확인
  const seg = QrSegment.makeBytes(bytes);
  const qr = QrCode.encodeSegments([seg], QrCode.Ecc.MEDIUM);
  const quietZone = 4;
  const totalModules = quietZone * 2 + qr.size;
  return Math.max(1, Math.floor(Math.min(cellW, cellH) / totalModules));
}
