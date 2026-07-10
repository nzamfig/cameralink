/**
 * 파일 목적: 비디오 프레임 캡처 루프
 * 책임: requestVideoFrameCallback(또는 rAF 폴백)으로 프레임 캡처,
 *        처리 중 새 프레임이 오면 최신 프레임만 유지 (백프레셔)
 * 관계: CameraController의 video 엘리먼트를 소비, ReceivePipeline에 ImageData 공급
 */

export class FrameLoop {
  private running = false;
  private processing = false;

  /**
   * @param videoEl 캡처할 비디오 엘리먼트
   * @param canvas 픽셀 읽기용 OffscreenCanvas (메인 스레드 DOM 캔버스보다 빠름)
   * @param onFrame 각 프레임의 ImageData를 처리하는 비동기 콜백
   */
  constructor(
    private videoEl: HTMLVideoElement,
    private canvas: OffscreenCanvas,
    private onFrame: (imageData: ImageData) => Promise<void>
  ) {}

  /** 프레임 루프 시작 */
  start(): void {
    this.running = true;
    this.scheduleNext();
  }

  /**
   * 다음 프레임 요청 스케줄링.
   * requestVideoFrameCallback이 지원되면 정확한 비디오 타이밍에 동기화,
   * 미지원 시 requestAnimationFrame으로 폴백.
   */
  private scheduleNext(): void {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in this.videoEl) {
      // requestVideoFrameCallback: 실제 비디오 프레임 도착 시 콜백 (Chrome 83+)
      (this.videoEl as HTMLVideoElement & {
        requestVideoFrameCallback: (cb: () => void) => void;
      }).requestVideoFrameCallback(() => this.captureFrame());
    } else {
      // 폴백: 디스플레이 리프레시마다 캡처 (비디오 실제 업데이트와 무관)
      requestAnimationFrame(() => this.captureFrame());
    }
  }

  /**
   * 현재 비디오 프레임을 캔버스에 그리고 ImageData로 추출하여 콜백에 전달.
   * 이전 프레임 처리 중이면 이 프레임을 건너뜀 (백프레셔: 처리 속도에 맞춤).
   */
  private async captureFrame(): Promise<void> {
    // 이전 프레임 처리 중이면 이 프레임 건너뜀 (디코더가 느리면 자연스럽게 드롭)
    if (!this.processing && this.running) {
      this.processing = true;
      try {
        const ctx = this.canvas.getContext('2d')!;
        // 비디오 크기가 0인 경우 (아직 스트림 미준비) 건너뜀
        if (this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0) {
          this.canvas.width = this.videoEl.videoWidth;
          this.canvas.height = this.videoEl.videoHeight;
          ctx.drawImage(this.videoEl, 0, 0);
          const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
          await this.onFrame(imageData);
        }
      } finally {
        this.processing = false;
      }
    }
    this.scheduleNext();
  }

  /** 프레임 루프 정지 */
  stop(): void {
    this.running = false;
  }
}
