/**
 * 파일 목적: jsQR 디코딩 Web Worker (경로 B, iOS Safari용)
 * 책임: 메인 스레드에서 셀 ImageData를 받아 jsQR로 디코드 후 결과 반환
 * 관계: QrDecoder가 이 Worker를 생성하고 메시지를 주고받음
 *
 * Web Worker를 사용하는 이유:
 * jsQR은 CPU 집약적 연산으로 메인 스레드에서 실행 시 UI가 프리즈됨.
 * Worker에서 실행하면 카메라 뷰파인더가 끊기지 않고 부드럽게 유지됨.
 *
 * binaryData vs data:
 * result.data(문자열)는 jsQR이 내부적으로 UTF-8로 해석하여 0x80 이상 바이트가 손상됨.
 * result.binaryData(Uint8ClampedArray)는 원시 바이트를 보존하므로 반드시 이것을 사용.
 */

import jsQR from 'jsqr';

/** Worker 메시지 타입: 메인 스레드 → Worker */
interface WorkerRequest {
  id: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Worker 메시지 타입: Worker → 메인 스레드 */
interface WorkerResponse {
  id: number;
  bytes: Uint8Array | null;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, data, width, height } = e.data;

  // jsQR 디코딩 시도
  // inversionAttempts: 'dontInvert' — 일반 QR(밝은 배경 어두운 모듈)만 처리
  // 반전 처리를 추가하면 느려지므로 송신기가 정상 QR을 생성한다고 가정
  const result = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });

  const response: WorkerResponse = {
    id,
    // binaryData: Uint8ClampedArray — 원시 바이트 보존 (result.data 문자열은 사용 금지)
    bytes: result ? new Uint8Array(result.binaryData) : null,
  };

  // Uint8Array의 버퍼를 transferable로 전송하면 복사 없이 이전됨 (성능 향상)
  if (response.bytes) {
    (self as unknown as Worker).postMessage(response, [response.bytes.buffer]);
  } else {
    (self as unknown as Worker).postMessage(response);
  }
};
