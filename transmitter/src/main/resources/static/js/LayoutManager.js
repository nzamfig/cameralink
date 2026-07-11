/**
 * @file LayoutManager.js
 * @description 캔버스 크기 → 격자 수·셀 좌표·fiducial 위치 계산.
 * 창이나 PiP 크기가 변경될 때마다 호출하여 현재 레이아웃을 계산한다.
 * 렌더링이나 DOM 조작은 하지 않으며 순수하게 좌표만 계산한다.
 *
 * 격자 계산 규칙:
 *   - 캔버스 4변에 FIDUCIAL_MARGIN 여백을 예약하고 남은 영역을 격자로 사용
 *   - cols/rows를 화면 가로세로 비율에 맞춰 독립적으로 배분해 셀이 "정사각형"에 가깝도록 함
 *     (예전엔 cols·rows 둘 다 DEFAULT_GRID로 동일하게 clamp해서, 와이드 화면에서
 *      cellW≫cellH인 직사각형 셀에 정사각형 QR을 넣다 보니 셀 좌우로 큰 흰 여백이 남았음)
 *   - 총 셀 수(cols×rows)는 DEFAULT_GRID² 이하로 유지 (폰 디코드 성능 상한)
 *   - 각 셀은 MIN_CELL_PX 이상, 최소 1×1, 공간 부족 시 null 반환
 *
 * Fiducial 마커:
 *   - 격자 "바깥" 여백의 4모서리에 속이 꽉 찬 원 배치
 *     (격자 내부에 두면 QR 셀의 흰 배경이 덮어버려 마커가 보이지 않는다)
 *   - QR finder 패턴(▣)과 다른 단색 원으로 오검출 방지
 *
 * 관계:
 *   GridRenderer.js → compute() 호출로 레이아웃 가져오기
 */

"use strict";

import { DEFAULT_GRID, MIN_CELL_PX } from './shared-protocol/index.js';

// Fiducial 원 반지름(px). 카메라에서 검출 가능해야 하므로 너무 작으면 안 됨
const FIDUCIAL_RADIUS = 16;

// 격자 4변에 예약하는 여백(px). fiducial 지름 + 간격.
// 격자 셀과 겹치지 않아야 QR 렌더 시 마커가 지워지지 않는다
const FIDUCIAL_MARGIN = FIDUCIAL_RADIUS * 2 + 8;

export class LayoutManager {

  /**
   * @param {HTMLCanvasElement} canvas 대상 캔버스
   */
  constructor(canvas) {
    this.canvas = canvas;
  }

  /**
   * 현재 캔버스 크기 기준으로 격자 레이아웃을 계산한다.
   *
   * @returns {object|null} 레이아웃 객체 또는 null (공간 부족)
   * @returns {number} .cols 격자 열 수
   * @returns {number} .rows 격자 행 수
   * @returns {number} .cellW 각 셀 너비(px)
   * @returns {number} .cellH 각 셀 높이(px)
   * @returns {Array<{x,y,w,h}>} .cells 셀 좌표 배열 (row-major 순서)
   * @returns {Array<{x,y,r}>} .fiducials fiducial 원 좌표·반지름
   * @returns {number} .gridByte grid 바이트 (cols<<4 | rows)
   */
  compute() {
    // CSS 픽셀 기준 크기 (devicePixelRatio 보정 전)
    const W = this.canvas.clientWidth  || this.canvas.width;
    const H = this.canvas.clientHeight || this.canvas.height;

    // fiducial 여백을 제외한 격자 가용 영역
    const availW = W - FIDUCIAL_MARGIN * 2;
    const availH = H - FIDUCIAL_MARGIN * 2;

    // 공간 부족 시 null 반환
    if (availW < MIN_CELL_PX || availH < MIN_CELL_PX) return null;

    // MIN_CELL_PX 기준 각 축의 이론적 최대 격자 수 (셀이 이보다 작아지면 안 됨)
    const idealCols = Math.floor(availW / MIN_CELL_PX);
    const idealRows = Math.floor(availH / MIN_CELL_PX);

    // 총 셀 수 상한 (폰 디코드 성능 고려, 기존 DEFAULT_GRID×DEFAULT_GRID와 동일)
    const maxCells = DEFAULT_GRID * DEFAULT_GRID;

    // 화면 가로세로 비율에 맞춰 cols/rows를 독립적으로 배분한다.
    // (이전엔 cols·rows를 둘 다 DEFAULT_GRID로 동일하게 clamp했기 때문에, 와이드 화면에서
    //  cellW≫cellH인 직사각형 셀이 나왔고 그 안에 들어가는 정사각형 QR 주변으로 여백이
    //  크게 남았다. aspect ratio를 반영해 셀이 정사각형에 가깝도록 재분배한다.)
    const aspect = availW / availH;
    let cols = Math.max(1, Math.round(Math.sqrt(maxCells * aspect)));
    let rows = Math.max(1, Math.round(maxCells / cols));

    // 총 셀 수가 상한을 넘으면 더 긴 축부터 하나씩 줄여 상한 이내로 맞춘다
    while (cols * rows > maxCells && (cols > 1 || rows > 1)) {
      if (cols >= rows) cols--; else rows--;
    }

    // MIN_CELL_PX 제약 재적용 및 4비트 격자 바이트 범위(0~15) 안전 클램프
    cols = Math.max(1, Math.min(cols, idealCols, 15));
    rows = Math.max(1, Math.min(rows, idealRows, 15));

    // 셀을 정사각형으로 렌더링: 가로/세로 중 더 빡빡한 쪽 기준 공통 크기 산정
    const cellSize = Math.floor(Math.min(availW / cols, availH / rows));
    const cellW = cellSize;
    const cellH = cellSize;

    // 격자 전체 크기가 가용 영역보다 작게 나올 수 있으므로 잔여 공간을 중앙 정렬로 분배
    const gridW = cellW * cols;
    const gridH = cellH * rows;
    const offsetX = FIDUCIAL_MARGIN + Math.floor((availW - gridW) / 2);
    const offsetY = FIDUCIAL_MARGIN + Math.floor((availH - gridH) / 2);

    // 셀 좌표 배열 구성 (row-major 순서: 위 → 아래, 왼 → 오른쪽)
    const cells = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        cells.push({
          x: offsetX + col * cellW,
          y: offsetY + row * cellH,
          w: cellW,
          h: cellH,
        });
      }
    }

    // Fiducial 마커 위치: 실제 격자 바깥 여백의 4모서리 (셀이 덮지 않는 영역)
    // 격자가 중앙 정렬로 오프셋될 수 있으므로 캔버스 고정 좌표가 아닌 격자 경계 기준으로 계산
    const r = FIDUCIAL_RADIUS;
    const gridLeft   = offsetX;
    const gridTop    = offsetY;
    const gridRight  = offsetX + gridW;
    const gridBottom = offsetY + gridH;
    const fiducials = [
      { x: gridLeft  - r - 4, y: gridTop    - r - 4, r }, // 좌상
      { x: gridRight + r + 4, y: gridTop    - r - 4, r }, // 우상
      { x: gridLeft  - r - 4, y: gridBottom + r + 4, r }, // 좌하
      { x: gridRight + r + 4, y: gridBottom + r + 4, r }, // 우하
    ];

    // grid 바이트: 상위 4비트 = cols, 하위 4비트 = rows
    const gridByte = ((cols & 0x0f) << 4) | (rows & 0x0f);

    return { cols, rows, cellW, cellH, cells, fiducials, gridByte };
  }
}
