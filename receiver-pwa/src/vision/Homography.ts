/**
 * 파일 목적: 4점 원근보정 (Homography) 자체 경량 구현
 * 책임: 4개의 fiducial 점으로 평면 단응 변환 행렬을 계산,
 *        격자 내 임의의 정규화 좌표를 원본 이미지 픽셀 좌표로 역변환
 * 관계: FiducialDetector의 4점을 받아 CellExtractor에 변환 기능 제공
 *
 * OpenCV.js를 사용하지 않는 이유:
 * - OpenCV.js는 수 MB WASM으로 오프라인 캐시 부담이 크다
 * - 4점 Homography는 8개 미지수의 선형 방정식이므로 직접 구현 가능
 * - DLT(Direct Linear Transform) 알고리즘으로 8×9 행렬에서 SVD 없이 가우스 소거로 H 계산
 */

/** 단응 변환(Homography) 인터페이스 */
export interface HomographyTransform {
  /**
   * 정규화 좌표(0~1)를 픽셀 좌표로 변환.
   * @param nx 정규화 x (0=왼쪽, 1=오른쪽)
   * @param ny 정규화 y (0=위쪽, 1=아래쪽)
   * @returns 원본 이미지에서의 픽셀 좌표
   */
  transform(nx: number, ny: number): { x: number; y: number };
}

/**
 * 4쌍의 대응점으로 단응 변환 행렬 H를 계산.
 * DLT 알고리즘: 각 대응점이 2개 방정식을 만들어 총 8개의 선형 방정식 → H 8자유도 결정.
 *
 * @param src 정규화된 격자 좌표 [[0,0],[1,0],[0,1],[1,1]] (좌상,우상,좌하,우하)
 * @param dst 대응하는 fiducial 위치 픽셀 좌표 (좌상,우상,좌하,우하)
 * @returns 변환 객체
 */
export function computeHomography(
  src: [number, number][],
  dst: [number, number][]
): HomographyTransform {
  // 8×9 행렬 A 구성 (동차 좌표계, DLT)
  // 각 대응점 (x,y) <-> (u,v) 로 2개 방정식:
  //   [-x, -y, -1,  0,  0,  0, u*x, u*y, u]
  //   [ 0,  0,  0, -x, -y, -1, v*x, v*y, v]
  const A: number[][] = [];

  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    A.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }

  // 가우스-조르당 소거로 마지막 열(h)을 구함 (h9 = 1 로 정규화)
  const h = gaussianElimination(A);

  // H 행렬 (3×3) 복원
  // h = [h0,h1,h2,h3,h4,h5,h6,h7,1]
  const H = [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1.0],
  ];

  return {
    transform(nx: number, ny: number): { x: number; y: number } {
      // 동차 변환: [u', v', w'] = H × [nx, ny, 1]
      const wp = H[2][0] * nx + H[2][1] * ny + H[2][2];
      const up = H[0][0] * nx + H[0][1] * ny + H[0][2];
      const vp = H[1][0] * nx + H[1][1] * ny + H[1][2];
      // 동차 나눗셈 (w'로 나눠 실제 픽셀 좌표 복원)
      return { x: up / wp, y: vp / wp };
    }
  };
}

/**
 * 가우스-조르당 소거로 8×9 행렬에서 해를 구함.
 * 마지막 미지수(h8)를 1로 고정하고 나머지 8개를 역대입으로 계산.
 * @param A 8×9 증강 행렬
 * @returns h[0]~h[7] (h8=1 로 정규화된 호모그래피 벡터)
 */
function gaussianElimination(A: number[][]): number[] {
  const n = 8; // 미지수 수 (h0~h7, h8=1로 고정)
  // 마지막 열(h8=1)을 우변으로 이동: b[i] = -A[i][8]
  const mat: number[][] = A.map(row => [...row.slice(0, 8)]);
  const b: number[] = A.map(row => -row[8]);

  // 전방 소거 (피벗팅 포함)
  for (let col = 0; col < n; col++) {
    // 피벗 행 선택 (절댓값 최대)
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(mat[row][col]) > Math.abs(mat[pivotRow][col])) {
        pivotRow = row;
      }
    }
    // 행 교환
    [mat[col], mat[pivotRow]] = [mat[pivotRow], mat[col]];
    [b[col], b[pivotRow]] = [b[pivotRow], b[col]];

    const pivot = mat[col][col];
    if (Math.abs(pivot) < 1e-10) continue; // 거의 0: 특이 행렬

    // 현재 열의 다른 행 소거
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = mat[row][col] / pivot;
      for (let c = col; c < n; c++) {
        mat[row][c] -= factor * mat[col][c];
      }
      b[row] -= factor * b[col];
    }
  }

  // 후방 대입으로 해 추출
  return Array.from({ length: n }, (_, i) =>
    Math.abs(mat[i][i]) > 1e-10 ? b[i] / mat[i][i] : 0
  );
}

/**
 * 단순 쌍선형 보간 단응 변환 (fiducial 미검출 시 폴백).
 * 4점 대응이 정확히 화면 모서리일 때 단순한 선형 보간으로 좌표를 매핑.
 * @param width 화면 너비 (픽셀)
 * @param height 화면 높이 (픽셀)
 */
export function identityHomography(width: number, height: number): HomographyTransform {
  return {
    transform(nx: number, ny: number) {
      return { x: nx * width, y: ny * height };
    }
  };
}
