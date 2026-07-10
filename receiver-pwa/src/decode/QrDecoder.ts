/**
 * 파일 목적: jsQR 기반 단일 셀 QR 디코더 (경로 B 폴백)
 * 책임: Worker에 ImageData 전송, binaryData 수신, 프로미스 기반 인터페이스 제공
 * 관계: decode.worker.ts를 생성하고, GridLock·CellExtractor와 협력
 *
 * ImageData.data 버퍼를 Worker로 전달(transfer)하는 이유:
 * 고해상도 셀 이미지 복사는 수 MB 복사 비용이 발생함.
 * ArrayBuffer를 transferable로 넘기면 복사 없이 소유권만 이전되어 빠름.
 * 단, 전달 후 메인 스레드에서 해당 버퍼를 재사용할 수 없으므로 주의.
 */

export class QrDecoder {
  private worker: Worker;
  private pending = new Map<number, (bytes: Uint8Array | null) => void>();
  private nextId = 0;

  constructor() {
    // Vite의 Worker URL 처리: type:'module'로 ES 모듈 Worker 생성
    this.worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });

    // Worker 응답 수신
    this.worker.onmessage = (e: MessageEvent<{ id: number; bytes: Uint8Array | null }>) => {
      const { id, bytes } = e.data;
      const resolve = this.pending.get(id);
      if (resolve) {
        resolve(bytes);
        this.pending.delete(id);
      }
    };

    // Worker 에러 처리 (예외 발생 시 대기 중인 프로미스에 null 반환)
    this.worker.onerror = (e) => {
      console.error('[QrDecoder] Worker 오류:', e.message);
      // 대기 중인 모든 요청을 null로 해결 (파이프라인 막힘 방지)
      for (const [id, resolve] of this.pending) {
        resolve(null);
        this.pending.delete(id);
      }
    };
  }

  /**
   * 셀 ImageData를 Worker에 전달하여 QR 디코딩.
   * ImageData.data 버퍼를 transferable로 넘겨 복사 비용 절약.
   * @param imageData 디코딩할 셀 이미지
   * @returns 디코딩된 바이트 배열, 실패 시 null
   */
  decode(imageData: ImageData): Promise<Uint8Array | null> {
    return new Promise(resolve => {
      const id = this.nextId++;
      this.pending.set(id, resolve);

      // ImageData.data(Uint8ClampedArray)의 ArrayBuffer를 transferable로 이전
      // 이전 후 imageData.data는 빈 버퍼가 되므로 재사용 금지
      this.worker.postMessage(
        { id, data: imageData.data, width: imageData.width, height: imageData.height },
        [imageData.data.buffer]
      );
    });
  }

  /** Worker 종료 및 자원 해제 */
  terminate(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
