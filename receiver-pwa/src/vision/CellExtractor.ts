/**
 * 파일 목적: 격자 좌표로 각 셀 ImageData 추출 (경로 B용)
 * 책임: Homography 변환으로 셀 경계를 이미지 좌표로 매핑 후 크롭
 * 관계: HomographyTransform과 협력하여 셀 이미지를 QrDecoder에 공급
 *
 * OffscreenCanvas를 사용하는 이유:
 * DOM 캔버스를 생성하면 레이아웃 연산이 발생하지만,
 * OffscreenCanvas는 메인 스레드에서도 DOM 없이 픽셀 조작만 수행하여 더 빠름.
 * 단, iOS Safari는 OffscreenCanvas를 제한적으로 지원하므로
 * 일반 Canvas 폴백도 구현.
 */

import type { HomographyTransform } from './Homography';

/** 셀 크롭에 사용할 최소 픽셀 크기 (너무 작으면 jsQR 인식률 저하) */
const MIN_CELL_SIZE = 100;

/** 셀 크롭 목표 크기 (jsQR 권장 입력 크기) */
const TARGET_CELL_SIZE = 300;

export class CellExtractor {
  // 셀 크롭용 재사용 OffscreenCanvas (매번 생성하면 GC 부담)
  private cropCanvas: OffscreenCanvas | HTMLCanvasElement;
  private cropCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

  // 프레임 업로드용 재사용 캔버스: setFrame()에서 프레임당 1회만 putImageData.
  // (이전 구현은 extractCell마다 전체 프레임 캔버스를 재생성해 모바일에서 극심한 부하)
  private srcCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private srcCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  private lastFrame: ImageData | null = null;

  constructor() {
    // OffscreenCanvas 지원 여부 확인 (iOS Safari 16.4+ 에서 지원)
    if (typeof OffscreenCanvas !== 'undefined') {
      this.cropCanvas = new OffscreenCanvas(TARGET_CELL_SIZE, TARGET_CELL_SIZE);
      this.cropCtx = this.cropCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    } else {
      // iOS 구형 폴백: DOM Canvas (보이지 않는 위치에 생성)
      this.cropCanvas = document.createElement('canvas');
      this.cropCtx = (this.cropCanvas as HTMLCanvasElement).getContext('2d')!;
    }
  }

  /**
   * 현재 프레임을 내부 캔버스에 업로드한다.
   * 같은 프레임에 대해 여러 셀을 추출하므로 프레임당 1회만 호출하면 된다
   * (extractCell 내부에서도 동일 프레임이면 재업로드하지 않음).
   */
  setFrame(imageData: ImageData): void {
    if (this.lastFrame === imageData) return;

    // 프레임 크기가 바뀌었거나 최초 호출: 캔버스 (재)생성
    if (
      !this.srcCanvas ||
      this.srcCanvas.width !== imageData.width ||
      this.srcCanvas.height !== imageData.height
    ) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this.srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
        this.srcCtx = this.srcCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      } else {
        this.srcCanvas = document.createElement('canvas');
        this.srcCanvas.width = imageData.width;
        this.srcCanvas.height = imageData.height;
        this.srcCtx = (this.srcCanvas as HTMLCanvasElement).getContext('2d')!;
      }
    }

    this.srcCtx!.putImageData(imageData, 0, 0);
    this.lastFrame = imageData;
  }

  /**
   * 원본 ImageData에서 특정 셀(row, col)을 크롭해 반환.
   * Homography를 통해 정규화 격자 좌표를 픽셀 좌표로 변환한 후
   * 해당 영역을 TARGET_CELL_SIZE로 리샘플링.
   *
   * @param imageData 원본 전체 프레임 ImageData
   * @param homography 정규화→픽셀 변환기
   * @param row 셀 행 인덱스 (0-based)
   * @param col 셀 열 인덱스 (0-based)
   * @param totalRows 총 행 수
   * @param totalCols 총 열 수
   * @returns 크롭된 셀 ImageData (TARGET_CELL_SIZE × TARGET_CELL_SIZE)
   */
  extractCell(
    imageData: ImageData,
    homography: HomographyTransform,
    row: number,
    col: number,
    totalRows: number,
    totalCols: number
  ): ImageData {
    // 셀의 정규화 좌표 범위 계산
    const nx0 = col / totalCols;
    const ny0 = row / totalRows;
    const nx1 = (col + 1) / totalCols;
    const ny1 = (row + 1) / totalRows;

    // 4 모서리의 픽셀 좌표 계산 (Homography 역변환)
    const tl = homography.transform(nx0, ny0); // 좌상
    const tr = homography.transform(nx1, ny0); // 우상
    const bl = homography.transform(nx0, ny1); // 좌하
    const br = homography.transform(nx1, ny1); // 우하

    // 픽셀 좌표의 바운딩 박스 계산 (원본 이미지 경계 내로 클리핑)
    const srcX = Math.max(0, Math.floor(Math.min(tl.x, tr.x, bl.x, br.x)));
    const srcY = Math.max(0, Math.floor(Math.min(tl.y, tr.y, bl.y, br.y)));
    const srcX2 = Math.min(imageData.width, Math.ceil(Math.max(tl.x, tr.x, bl.x, br.x)));
    const srcY2 = Math.min(imageData.height, Math.ceil(Math.max(tl.y, tr.y, bl.y, br.y)));
    const srcW = Math.max(MIN_CELL_SIZE, srcX2 - srcX);
    const srcH = Math.max(MIN_CELL_SIZE, srcY2 - srcY);

    // 프레임 캔버스 준비 (동일 프레임이면 setFrame이 재업로드를 생략)
    this.setFrame(imageData);

    // 목표 캔버스에 셀 영역을 리샘플링하여 그림 (bilinear 보간은 브라우저 기본)
    this.cropCanvas.width = TARGET_CELL_SIZE;
    this.cropCanvas.height = TARGET_CELL_SIZE;
    this.cropCtx.drawImage(
      this.srcCanvas as CanvasImageSource,
      srcX, srcY, srcW, srcH,         // 원본 영역
      0, 0, TARGET_CELL_SIZE, TARGET_CELL_SIZE  // 목표 영역
    );

    return this.cropCtx.getImageData(0, 0, TARGET_CELL_SIZE, TARGET_CELL_SIZE);
  }
}
