/**
 * @file crc.ts
 * @description CRC(순환 중복 검사) 구현.
 * - CRC16: 개별 심볼의 전송 오염 여부를 빠르게 검출. 손상 심볼은 디코더에서 폐기.
 * - CRC32: 파일 전체 복원 완료 후 최종 무결성 검증.
 *
 * 관계:
 *   codec.ts  → CRC16 사용 (DataSymbol 직렬화/역직렬화 시 검증)
 *   lt-decoder.ts → CRC32 사용 (복원 완료 후 파일 검증)
 *
 * 주의: 테이블 계산 방식으로 루프당 O(1) 처리. 매 프레임 호출되므로 성능 중요.
 */

// ─────────────────────────────────────────────
// CRC16 (CRC-CCITT, 다항식 0x1021)
// ─────────────────────────────────────────────

/**
 * CRC16 룩업 테이블 (다항식 0x1021, CRC-CCITT).
 * 초기화 비용을 런타임 1회로 제한하기 위해 모듈 로드 시 미리 계산.
 * 0x1021 = x^16 + x^12 + x^5 + 1 (CCITT 표준)
 */
const CRC16_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8; // 최상위 바이트에 입력값 배치
    for (let j = 0; j < 8; j++) {
      // 최상위 비트가 1이면 다항식 XOR, 0이면 왼쪽 시프트만
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
    table[i] = crc;
  }
  return table;
})();

/**
 * CRC16-CCITT 계산 (다항식 0x1021, 초기값 0xFFFF).
 * 개별 심볼의 전송 오염 검출에 사용.
 * 단일 비트 오류 및 2바이트 이내 버스트 오류를 100% 검출.
 * @param data 검사할 바이트 배열
 * @returns 16비트 CRC 값
 */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff; // 초기값 0xFFFF (CCITT 표준)
  for (let i = 0; i < data.length; i++) {
    // 현재 CRC 최상위 바이트와 입력 바이트를 XOR하여 테이블 인덱스 생성
    const tableIndex = ((crc >> 8) ^ data[i]) & 0xff;
    // 테이블 값으로 CRC 갱신: 기존 CRC를 1바이트 왼쪽 시프트하고 XOR
    crc = ((crc << 8) ^ CRC16_TABLE[tableIndex]) & 0xffff;
  }
  return crc;
}

// ─────────────────────────────────────────────
// CRC32 (IEEE 802.3, 다항식 0xEDB88320)
// ─────────────────────────────────────────────

/**
 * CRC32 룩업 테이블 (다항식 0xEDB88320, IEEE 802.3 / zip·png 표준).
 * 0xEDB88320 은 0x04C11DB7의 비트 반전(reflected) 표현.
 * 이더넷·zip·PNG 모두 이 다항식을 사용하므로 상호운용성 우수.
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      // 최하위 비트가 1이면 다항식 XOR (reflected 처리)
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[i] = c >>> 0; // 부호 없는 32비트로 저장
  }
  return table;
})();

/**
 * CRC32 계산 (IEEE 802.3, 초기값 0xFFFFFFFF, 결과 비트반전).
 * 파일 전체 복원 완료 후 최종 무결성 검증에 사용.
 * @param data 검사할 바이트 배열
 * @returns 32비트 CRC 값 (부호 없는 정수)
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff; // 초기값 전체 1로 설정 (표준)
  for (let i = 0; i < data.length; i++) {
    // 현재 CRC 최하위 바이트와 입력 바이트를 XOR하여 테이블 인덱스 생성
    const tableIndex = (crc ^ data[i]) & 0xff;
    // 테이블 값으로 CRC 갱신: 기존 CRC를 1바이트 오른쪽 시프트하고 XOR
    crc = (CRC32_TABLE[tableIndex] ^ (crc >>> 8)) >>> 0;
  }
  // 결과 비트반전 (표준 CRC32 최종 처리)
  return (crc ^ 0xffffffff) >>> 0;
}
