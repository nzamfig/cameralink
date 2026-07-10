/**
 * @file LayoutManager.js
 * @description 캔버스 크기 → 격자 수·셀 좌표·fiducial 위치 계산.
 * 창이나 PiP 크기가 변경될 때마다 호출하여 현재 레이아웃을 계산한다.
 * 렌더링이나 DOM 조작은 하지 않으며 순수하게 좌표만 계산한다.
 *
 * 격자 계산 규칙:
 *   - 캔버스 4변에 FIDUCIAL_MARGIN 여백을 예약하고 남은 영역을 격자로 사용
 *   - cols = floor(가용너비 / MIN_CELL_PX), rows = floor(가용높이 / MIN_CELL_PX)
 *   - DEFAULT_GRID(4)를 상한으로 clamp
 *   - 최소 1×1, 0이면 null 반환
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

    // 가능한 최대 격자 수 계산 (MIN_CELL_PX 기준)
    let cols = Math.floor(availW / MIN_CELL_PX);
    let rows = Math.floor(availH / MIN_CELL_PX);

    // DEFAULT_GRID(4)를 상한으로 clamp
    cols = Math.min(cols, DEFAULT_GRID);
    rows = Math.min(rows, DEFAULT_GRID);

    // 공간 부족 시 null 반환
    if (cols < 1 || rows < 1) return null;

    // 셀 크기 계산 (정수 픽셀)
    const cellW = Math.floor(availW / cols);
    const cellH = Math.floor(availH / rows);

    // 셀 좌표 배열 구성 (row-major 순서: 위 → 아래, 왼 → 오른쪽)
    // 여백만큼 안쪽으로 오프셋하여 fiducial과 겹치지 않게 함
    const cells = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        cells.push({
          x: FIDUCIAL_MARGIN + col * cellW,
          y: FIDUCIAL_MARGIN + row * cellH,
          w: cellW,
          h: cellH,
        });
      }
    }

    // Fiducial 마커 위치: 격자 바깥 여백의 4모서리 (셀이 덮지 않는 영역)
    const r = FIDUCIAL_RADIUS;
    const gridRight  = FIDUCIAL_MARGIN + cols * cellW;
    const gridBottom = FIDUCIAL_MARGIN + rows * cellH;
    const fiducials = [
      { x: r + 4,             y: r + 4,              r }, // 좌상
      { x: gridRight + r + 4, y: r + 4,              r }, // 우상
      { x: r + 4,             y: gridBottom + r + 4, r }, // 좌하
      { x: gridRight + r + 4, y: gridBottom + r + 4, r }, // 우하
    ];

    // grid 바이트: 상위 4비트 = cols, 하위 4비트 = rows
    const gridByte = ((cols & 0x0f) << 4) | (rows & 0x0f);

    return { cols, rows, cellW, cellH, cells, fiducials, gridByte };
  }
}
