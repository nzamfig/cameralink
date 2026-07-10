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
 *
 * ASCII-safe(Base64) 디코딩:
 * 송신기가 QR에 Base64로 인코딩해서 싣기 때문에(경로 A의 BarcodeDetector UTF-8 강제
 * 디코딩 대응, qr-safe.ts 참고), binaryData로 원시 바이트를 안전하게 얻은 뒤에도
 * fromAsciiSafe()로 한 번 더 원복해야 실제 심볼 바이트가 나온다. 경로 B는 원래
 * binaryData만으로 문제가 없었지만, 송신기가 두 경로 공용으로 Base64를 싣게 되어
 * 여기서도 동일하게 디코딩한다.
 */

import jsQR from 'jsqr';
import { fromAsciiSafe } from 'shared-protocol/qr-safe';

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

  // binaryData: Uint8ClampedArray — 원시 바이트 보존 (result.data 문자열은 사용 금지)
  // → 이후 Base64 디코딩으로 실제 심볼 바이트 복원 (qr-safe.ts, 형식 오류 시 null)
  const bytes = result ? fromAsciiSafe(new Uint8Array(result.binaryData)) : null;

  const response: WorkerResponse = { id, bytes };

  // Uint8Array의 버퍼를 transferable로 전송하면 복사 없이 이전됨 (성능 향상)
  if (response.bytes) {
    (self as unknown as Worker).postMessage(response, [response.bytes.buffer]);
  } else {
    (self as unknown as Worker).postMessage(response);
  }
};
