/**
 * @file codec.ts
 * @description 심볼(헤더/데이터) 직렬화(encode) 및 역직렬화(decode) 구현.
 * 송신기는 encode 함수로 바이트 배열을 생성해 QR로 렌더링하고,
 * 수신기는 QR에서 읽은 바이트 배열을 decode 함수로 파싱한다.
 *
 * 모든 다바이트 정수는 big-endian(네트워크 바이트 순서) 저장.
 * 바이너리 안전성: 문자열 변환 없이 Uint8Array + DataView 만 사용.
 *
 * 관계:
 *   lt-encoder.ts → encodeDataSymbol 호출
 *   lt-decoder.ts → decodeSymbol 호출
 *   constants.ts  → SYMBOL_TYPE_HEADER, SYMBOL_TYPE_DATA 참조
 *   crc.ts        → DataSymbol CRC16 검증에 사용
 */

import { SYMBOL_TYPE_HEADER, SYMBOL_TYPE_DATA } from './constants.js';
import { crc16 } from './crc.js';

// ─────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────

/** 헤더 심볼: 파일 메타데이터 전달 */
export interface HeaderSymbol {
  type: 0x01;
  grid: number;       // cols<<4 | rows (패킹된 격자 크기)
  cols: number;       // 격자 열 수
  rows: number;       // 격자 행 수
  flags: number;      // 비트플래그 (bit0=gzip 압축 여부)
  compressed: boolean; // flags bit0를 풀어쓴 편의 필드
  filename: string;   // UTF-8 파일명
  originalSize: number; // 원본 파일 크기(바이트)
  storedSize: number;   // 저장(압축 후) 크기(바이트)
  payloadSize: number;  // 각 LT 심볼의 페이로드 크기
  totalBlocks: number;  // 총 소스 블록 수 (LT 디코더 필수)
  crc32: number;        // 원본 파일 CRC32 (최종 검증용)
}

/** 데이터 심볼: LT 인코딩된 실제 파일 데이터 전달 */
export interface DataSymbol {
  type: 0x02;
  grid: number;       // cols<<4 | rows
  cols: number;
  rows: number;
  seed: number;       // Mulberry32 시드 (인덱스 역산용)
  payloadLen: number; // payload 실제 길이
  payload: Uint8Array; // XOR 결합 결과
  crc16: number;      // 앞 전체(type~payload)에 대한 CRC16
}

/** 심볼 유니온 타입 */
export type Symbol = HeaderSymbol | DataSymbol;

// ─────────────────────────────────────────────
// 헤더 심볼 직렬화
// ─────────────────────────────────────────────

/**
 * 헤더 심볼을 바이트 배열로 직렬화.
 *
 * 바이트 레이아웃:
 * offset  size  field
 * 0       1     type = 0x01
 * 1       1     grid (상위 4비트=cols, 하위 4비트=rows)
 * 2       1     flags (bit0 = gzip 적용 여부)
 * 3       1     filenameLen (L, 최대 100)
 * 4       L     filename (UTF-8)
 * 4+L     4     originalSize (uint32 big-endian)
 * 8+L     4     storedSize   (uint32 big-endian)
 * 12+L    2     payloadSize  (uint16 big-endian)
 * 14+L    4     totalBlocks  (uint32 big-endian)
 * 18+L    4     crc32        (uint32 big-endian)
 *
 * 총 = 22 + L 바이트
 */
export function encodeHeader(
  h: Omit<HeaderSymbol, 'type' | 'cols' | 'rows' | 'compressed'>
): Uint8Array {
  // UTF-8로 파일명 인코딩 (TextEncoder는 브라우저/Node.js 모두 지원)
  const nameBytes = new TextEncoder().encode(h.filename);
  const L = nameBytes.length; // 파일명 바이트 길이

  // 전체 버퍼 크기 계산: 고정 22바이트 + 파일명
  const buf = new Uint8Array(22 + L);
  const view = new DataView(buf.buffer);

  let offset = 0;
  buf[offset++] = SYMBOL_TYPE_HEADER;       // type = 0x01
  buf[offset++] = h.grid & 0xff;            // grid (cols<<4 | rows)
  buf[offset++] = h.flags & 0xff;           // flags
  buf[offset++] = L & 0xff;                 // filenameLen
  buf.set(nameBytes, offset);               // filename (UTF-8)
  offset += L;

  // 이후 필드는 big-endian DataView로 기록
  view.setUint32(offset, h.originalSize, false); offset += 4;
  view.setUint32(offset, h.storedSize, false);   offset += 4;
  view.setUint16(offset, h.payloadSize, false);  offset += 2;
  view.setUint32(offset, h.totalBlocks, false);  offset += 4;
  view.setUint32(offset, h.crc32, false);        offset += 4;

  return buf;
}

// ─────────────────────────────────────────────
// 데이터 심볼 직렬화
// ─────────────────────────────────────────────

/**
 * 데이터 심볼을 바이트 배열로 직렬화 (CRC16 자동 계산·부가).
 *
 * 바이트 레이아웃:
 * offset  size  field
 * 0       1     type = 0x02
 * 1       1     grid
 * 2       4     seed         (uint32 big-endian)
 * 6       2     payloadLen   (uint16 big-endian)
 * 8       N     payload      (XOR 결합 결과)
 * 8+N     2     crc16        (uint16 big-endian, 앞 0~8+N-1 전체 대상)
 *
 * 총 = 10 + N 바이트
 */
export function encodeDataSymbol(
  d: Omit<DataSymbol, 'type' | 'cols' | 'rows' | 'crc16'>
): Uint8Array {
  const N = d.payload.length;
  // CRC16 포함 전체 버퍼: 헤더 8바이트 + 페이로드 N바이트 + CRC16 2바이트
  const buf = new Uint8Array(10 + N);
  const view = new DataView(buf.buffer);

  let offset = 0;
  buf[offset++] = SYMBOL_TYPE_DATA;          // type = 0x02
  buf[offset++] = d.grid & 0xff;             // grid
  view.setUint32(offset, d.seed, false);     // seed (big-endian)
  offset += 4;
  view.setUint16(offset, d.payloadLen, false); // payloadLen (big-endian)
  offset += 2;
  buf.set(d.payload, offset);               // payload
  offset += N;

  // CRC16 계산 대상: type~payload 앞 전체 (CRC 필드 자신 제외)
  const crcTarget = buf.subarray(0, offset);
  const checksum = crc16(crcTarget);
  view.setUint16(offset, checksum, false);  // crc16 (big-endian)

  return buf;
}

// ─────────────────────────────────────────────
// 심볼 역직렬화
// ─────────────────────────────────────────────

/**
 * 바이트 배열을 심볼로 역직렬화.
 * - type 바이트로 헤더/데이터 구분
 * - 데이터 심볼은 CRC16 검증 후 실패 시 null 반환 (손상 심볼 폐기)
 * - 헤더 심볼은 CRC 없음 (QR ECC 자체 오류정정에 의존)
 * @param bytes QR에서 읽은 원시 바이트
 * @returns 파싱된 심볼 또는 null (CRC 실패 / 알 수 없는 타입)
 */
export function decodeSymbol(bytes: Uint8Array): Symbol | null {
  // 최소 2바이트(type + grid) 필요
  if (bytes.length < 2) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[0];

  if (type === SYMBOL_TYPE_HEADER) {
    return decodeHeader(bytes, view);
  } else if (type === SYMBOL_TYPE_DATA) {
    return decodeData(bytes, view);
  }

  // 알 수 없는 타입: 이 시스템의 심볼이 아님
  return null;
}

/**
 * 헤더 심볼 역직렬화 (내부 함수).
 * 헤더는 CRC 없이 QR ECC에만 의존.
 */
function decodeHeader(bytes: Uint8Array, view: DataView): HeaderSymbol | null {
  // 최소 길이: type(1)+grid(1)+flags(1)+filenameLen(1)+고정필드(18) = 22바이트
  if (bytes.length < 22) return null;

  const grid = bytes[1];
  const cols = (grid >> 4) & 0x0f;  // 상위 4비트 = 열 수
  const rows = grid & 0x0f;         // 하위 4비트 = 행 수
  const flags = bytes[2];
  const compressed = (flags & 0x01) !== 0; // bit0 = gzip 여부
  const L = bytes[3]; // 파일명 바이트 길이

  // 파일명 포함 전체 길이 검증
  if (bytes.length < 22 + L) return null;

  // 파일명을 UTF-8로 디코딩 (바이너리 안전)
  const nameBytes = bytes.subarray(4, 4 + L);
  const filename = new TextDecoder('utf-8').decode(nameBytes);

  let offset = 4 + L;
  const originalSize = view.getUint32(offset, false); offset += 4;
  const storedSize   = view.getUint32(offset, false); offset += 4;
  const payloadSize  = view.getUint16(offset, false); offset += 2;
  const totalBlocks  = view.getUint32(offset, false); offset += 4;
  const crc32Value   = view.getUint32(offset, false);

  return {
    type: SYMBOL_TYPE_HEADER,
    grid,
    cols,
    rows,
    flags,
    compressed,
    filename,
    originalSize,
    storedSize,
    payloadSize,
    totalBlocks,
    crc32: crc32Value,
  };
}

/**
 * 데이터 심볼 역직렬화 (내부 함수).
 * CRC16 검증 실패 시 null 반환하여 손상 심볼 폐기.
 */
function decodeData(bytes: Uint8Array, view: DataView): DataSymbol | null {
  // 최소 길이: type(1)+grid(1)+seed(4)+payloadLen(2)+crc16(2) = 10바이트
  if (bytes.length < 10) return null;

  const grid = bytes[1];
  const cols = (grid >> 4) & 0x0f;
  const rows = grid & 0x0f;
  const seed       = view.getUint32(2, false);  // 오프셋 2, big-endian
  const payloadLen = view.getUint16(6, false);  // 오프셋 6, big-endian

  // 전체 길이 검증: 10 + payloadLen 바이트 필요
  if (bytes.length < 10 + payloadLen) return null;

  // CRC16 검증: 마지막 2바이트가 CRC, 그 앞이 대상
  const dataEnd = 8 + payloadLen;       // payload 끝 오프셋
  const storedCrc = view.getUint16(dataEnd, false); // 저장된 CRC16
  const crcTarget = bytes.subarray(0, dataEnd);     // CRC 계산 대상
  const computedCrc = crc16(crcTarget);

  // CRC16 불일치: 전송 중 손상된 심볼 → 폐기
  if (storedCrc !== computedCrc) return null;

  // payload를 복사하여 반환 (원본 버퍼 참조 방지)
  const payload = bytes.slice(8, dataEnd);

  return {
    type: SYMBOL_TYPE_DATA,
    grid,
    cols,
    rows,
    seed,
    payloadLen,
    payload,
    crc16: storedCrc,
  };
}
