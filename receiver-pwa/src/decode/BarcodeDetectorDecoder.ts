/**
 * 파일 목적: 네이티브 BarcodeDetector API를 이용한 QR 디코딩 (경로 A)
 * 책임: 프레임 내 다중 QR을 한 번에 검출, rawValue를 바이트로 복원
 * 관계: ReceivePipeline에서 BarcodeDetector 지원 기기에서 우선 선택됨
 *
 * rawValue 복원 2단계:
 * 1. Latin-1(ISO-8859-1) 역변환: rawValue(문자열)의 각 code point를 1:1로 바이트로 변환.
 * 2. ASCII-safe(Base64) 디코딩: Android의 BarcodeDetector 구현은 rawValue를 만들 때
 *    내부적으로 UTF-8로 디코딩하는 것으로 보여, 0x80 이상 바이트가 섞인 원본은 네이티브
 *    레이어에서 이미 손상되어 1단계만으로는 복구 불가능하다. 송신기가 QR에 Base64(ASCII
 *    0~127)로 인코딩해서 싣기 때문에, 이 경로에서도 fromAsciiSafe()로 원복해야 한다.
 *
 * 지원 환경: Chrome 83+, Android WebView, Samsung Internet
 * 미지원: Firefox, iOS Safari (→ 경로 B로 폴백)
 */

import { fromAsciiSafe } from 'shared-protocol/qr-safe';

/** BarcodeDetector 전역 타입 (TypeScript 라이브러리 미포함) */
interface BarcodeDetectorLike {
  detect(source: ImageBitmap | ImageData | HTMLVideoElement | HTMLCanvasElement): Promise<{ rawValue: string }[]>;
}

interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

export class BarcodeDetectorDecoder {
  private detector: BarcodeDetectorLike | null = null;

  /**
   * 현재 브라우저에서 BarcodeDetector API 지원 여부 확인.
   * @returns 지원하면 true, 미지원이면 false
   */
  static isSupported(): boolean {
    return 'BarcodeDetector' in window;
  }

  /**
   * BarcodeDetector 초기화.
   * qr_code 형식이 지원되는지 확인 후 인스턴스 생성.
   * @throws qr_code 포맷 미지원 시 에러
   */
  async init(): Promise<void> {
    const BarcodeDetectorClass = (window as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector;

    // 지원 포맷 목록 확인 (qr_code가 없는 기기 대응)
    const supported = await BarcodeDetectorClass.getSupportedFormats();
    if (!supported.includes('qr_code')) {
      throw new Error('이 기기의 BarcodeDetector가 qr_code 포맷을 지원하지 않습니다');
    }

    this.detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
  }

  /**
   * 프레임에서 모든 QR 코드 검출.
   * rawValue를 Latin-1 역변환 후 Base64 디코딩하여 원본 심볼 바이트로 복원.
   * @param imageData 분석할 프레임 ImageData
   * @returns 각 QR의 바이트 배열 목록 (빈 목록이면 QR 없음, 손상된 읽기는 제외됨)
   */
  async detect(imageData: ImageData): Promise<Uint8Array[]> {
    if (!this.detector) throw new Error('BarcodeDetectorDecoder.init() 미호출');
    const results = await this.detector.detect(imageData);

    const bytesList: Uint8Array[] = [];
    for (const r of results) {
      const decoded = fromAsciiSafe(latin1ToBytes(r.rawValue));
      if (decoded) bytesList.push(decoded);
    }
    return bytesList;
  }
}

/**
 * Latin-1 문자열 → Uint8Array 변환.
 * BarcodeDetector.rawValue의 각 문자는 코드포인트 0~255이며,
 * 이를 그대로 바이트값으로 변환하면 원래 QR 바이너리 데이터가 복원됨.
 * TextEncoder('latin1')는 브라우저 미지원 경우가 있으므로 수동 변환 사용.
 */
function latin1ToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    // charCodeAt은 항상 0~65535 범위; QR 바이너리 모드에서는 0~255만 사용됨
    bytes[i] = s.charCodeAt(i) & 0xFF;
  }
  return bytes;
}
