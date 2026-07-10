/**
 * @file EncodeClient.js
 * @description Spring Boot /api/encode 엔드포인트 호출 클라이언트.
 * File 객체를 multipart/form-data로 POST하여 EncodeResponse JSON을 수신한다.
 * storedData(Base64) → Uint8Array → 200B 블록 배열 변환을 담당한다.
 *
 * 반환 데이터:
 *   {
 *     filename, originalSize, storedSize, compressed,
 *     payloadSize, totalBlocks, crc32,
 *     storedData,  // Base64 원본 (그대로 보존)
 *     blocks,      // Uint8Array[] — payloadSize 단위로 분할된 블록 배열
 *   }
 *
 * 관계:
 *   main.js        → EncodeClient.encode() 호출
 *   GridRenderer.js → 반환된 blocks로 LtEncoder 초기화
 *   Spring Boot    → POST /api/encode 처리
 */

"use strict";

export class EncodeClient {

  /**
   * 파일을 서버에 업로드하여 LT 인코딩 데이터를 가져온다.
   *
   * @param {File} file 업로드할 파일
   * @returns {Promise<object>} EncodeResponse + blocks 배열
   * @throws {Error} 서버 오류 또는 네트워크 오류 시
   */
  async encode(file) {
    // multipart/form-data 구성
    const formData = new FormData();
    formData.append('file', file);

    // 서버에 업로드
    const res = await fetch('/api/encode', {
      method: 'POST',
      body: formData,
      // Content-Type은 FormData가 자동으로 multipart/form-data로 설정
    });

    // HTTP 오류 처리
    if (!res.ok) {
      const errorText = await res.text().catch(() => `HTTP ${res.status}`);
      throw new Error(`서버 오류 (${res.status}): ${errorText}`);
    }

    // JSON 파싱
    const data = await res.json();

    // storedData(Base64) → Uint8Array 변환
    const storedBytes = base64ToUint8Array(data.storedData);

    // payloadSize 단위로 블록 분할
    // 서버가 이미 마지막 블록을 0 패딩했으므로 단순 분할만 수행
    const blocks = splitIntoBlocks(storedBytes, data.payloadSize);

    return {
      ...data,
      blocks,
    };
  }
}

// ─────────────────────────────────────────────
// 내부 헬퍼 함수
// ─────────────────────────────────────────────

/**
 * Base64 문자열을 Uint8Array로 디코딩한다.
 * atob()는 이진 문자열을 반환하므로 charCodeAt으로 변환.
 *
 * @param {string} base64 Base64 인코딩된 문자열
 * @returns {Uint8Array}
 */
function base64ToUint8Array(base64) {
  // atob: Base64 → 이진 문자열
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Uint8Array를 blockSize 바이트 단위로 분할하여 블록 배열을 반환한다.
 * 마지막 블록이 blockSize보다 짧으면 새로운 배열로 복사 (서버에서 이미 패딩).
 *
 * @param {Uint8Array} data 분할할 데이터
 * @param {number} blockSize 블록 크기(바이트)
 * @returns {Uint8Array[]} 블록 배열
 */
function splitIntoBlocks(data, blockSize) {
  const totalBlocks = Math.ceil(data.length / blockSize);
  const blocks = [];

  for (let i = 0; i < totalBlocks; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, data.length);
    // subarray: 새 배열이 아닌 뷰 반환 — XOR 연산에 충분
    const block = new Uint8Array(blockSize);
    block.set(data.subarray(start, end));
    blocks.push(block);
  }

  return blocks;
}
