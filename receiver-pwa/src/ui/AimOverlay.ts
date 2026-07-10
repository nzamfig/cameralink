/**
 * 파일 목적: 조준 보조 오버레이 캔버스 렌더링
 * 책임: 검출된 격자 경계·성공 셀 하이라이트, 힌트 메시지 표시
 * 관계: ReceivePipeline에서 격자 정보와 수신 상태를 받아 오버레이에 그림
 */

export class AimOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hintEl = document.getElementById('aim-hint')!;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * 힌트 메시지 갱신.
   * @param msg 표시할 힌트 문자열
   */
  setHint(msg: string): void {
    this.hintEl.textContent = msg;
  }

  /**
   * 격자 경계와 수신 성공 셀을 오버레이에 그림.
   * 캔버스는 video 위에 겹쳐 있어 격자를 시각화함.
   * @param cols 격자 열 수
   * @param rows 격자 행 수
   * @param successMask 각 셀의 수신 성공 여부 [row][col]
   */
  drawGrid(cols: number, rows: number, successMask: boolean[][]): void {
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.clearRect(0, 0, w, h);

    const cellW = w / cols;
    const cellH = h / rows;

    // 수신 완료 셀: 녹색 반투명으로 채움
    this.ctx.fillStyle = 'rgba(0, 255, 0, 0.25)';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (successMask[r]?.[c]) {
          this.ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
        }
      }
    }

    // 격자 경계선: 녹색 실선
    this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();

    // 수직선
    for (let c = 1; c < cols; c++) {
      this.ctx.moveTo(c * cellW, 0);
      this.ctx.lineTo(c * cellW, h);
    }
    // 수평선
    for (let r = 1; r < rows; r++) {
      this.ctx.moveTo(0, r * cellH);
      this.ctx.lineTo(w, r * cellH);
    }
    // 외곽 경계
    this.ctx.strokeRect(0, 0, w, h);
    this.ctx.stroke();
  }

  /** 오버레이 전체 초기화 */
  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * 캔버스 크기를 윈도우에 맞게 조정.
   * CSS는 100% 크기이나 내부 픽셀 해상도를 맞춰야 선이 선명하게 그려짐.
   */
  resize(): void {
    this.canvas.width = this.canvas.offsetWidth;
    this.canvas.height = this.canvas.offsetHeight;
  }
}
