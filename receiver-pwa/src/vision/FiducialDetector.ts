/**
 * 파일 목적: fiducial 마커(단색 원) 검출 (경로 B용)
 * 책임: ImageData에서 4개의 fiducial 마커 위치 추정
 * 관계: Homography가 이 4점을 사용해 원근보정 행렬을 계산함
 *
 * fiducial 디자인(단색 원)과 QR finder 패턴(▣)의 차이:
 * QR finder 패턴은 흑-백-흑-백-흑 비율 1:1:3:1:1의 정사각 패턴이다.
 * 단색 원은 이 비율이 없으므로 QR 디코더가 finder 패턴으로 오검출하지 않는다.
 *
 * 검출 방법: 이미지를 4등분한 각 구역에서 가장 어두운 픽셀들의 무게중심을 계산.
 * 완벽한 CV 없이 행별 스캔으로 근사하며, 강건성 > 정확도를 우선함.
 * 어두운 픽셀이 충분히 없으면 null 반환 (fiducial 검출 실패).
 */

export interface Point { x: number; y: number; }

/** 단일 사분면에서 fiducial 검출에 필요한 최소 어두운 픽셀 수 */
const MIN_DARK_PIXELS = 50;

/** 어두운 픽셀 판정 휘도 임계값 (0~255, 낮을수록 더 어두운 것만 선택) */
const DARK_THRESHOLD = 64;

export class FiducialDetector {
  /**
   * 이미지에서 4개의 fiducial 후보점을 찾아 반환.
   * 이미지를 2×2 4사분면으로 나눠 각 구역의 가장 어두운 픽셀 무게중심을 사용.
   * 어느 한 구역에서도 어두운 픽셀이 충분하지 않으면 null 반환.
   *
   * @param imageData 분석할 전체 프레임 ImageData
   * @returns [좌상, 우상, 좌하, 우하] 순서의 4점, 또는 null
   */
  detect(imageData: ImageData): [Point, Point, Point, Point] | null {
    const { data, width, height } = imageData;
    const quadrants: Point[] = [];

    // 4사분면 순서: [좌상(0,0), 우상(1,0), 좌하(0,1), 우하(1,1)]
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        const x0 = Math.round(qx * width / 2);
        const x1 = Math.round((qx + 1) * width / 2);
        const y0 = Math.round(qy * height / 2);
        const y1 = Math.round((qy + 1) * height / 2);

        let sumX = 0, sumY = 0, count = 0;

        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4;
            // 휘도 계산 (BT.601 가중치: R*0.299 + G*0.587 + B*0.114)
            const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            if (lum < DARK_THRESHOLD) {
              sumX += x;
              sumY += y;
              count++;
            }
          }
        }

        // 어두운 픽셀이 충분하지 않으면 fiducial 검출 실패
        if (count < MIN_DARK_PIXELS) return null;

        quadrants.push({ x: sumX / count, y: sumY / count });
      }
    }

    // [좌상, 우상, 좌하, 우하] 반환
    return [quadrants[0], quadrants[1], quadrants[2], quadrants[3]];
  }
}
