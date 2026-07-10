/**
 * @file gzip.ts
 * @description gzip 압축/해제 래퍼.
 * 환경에 따라 자동으로 최적 구현을 선택:
 *   - 브라우저: CompressionStream / DecompressionStream (Web Streams API)
 *   - Node.js (테스트 환경 등): node:zlib promisify 폴백
 *
 * LT 인코더에서 파일을 블록화하기 전 압축하고,
 * LT 디코더에서 복원 완료 후 해제하는 데 사용.
 *
 * 관계:
 *   lt-encoder.ts (송신기 측) → gzipCompress 호출
 *   lt-decoder.ts (수신기 측) → gzipDecompress 호출
 */

// node 내장 모듈의 최소 타입 선언 (외부 프로젝트에서 이 파일을 직접 참조해도 타입 해석 가능)
/// <reference path="./node-fallback.d.ts" />

// ─────────────────────────────────────────────
// 환경 감지
// ─────────────────────────────────────────────

/** CompressionStream/DecompressionStream 생성자 시그니처 (gzip 포맷 지정) */
type GzipStreamCtor = new (format: 'gzip') => TransformStream<Uint8Array, Uint8Array>;

/**
 * 현재 환경이 CompressionStream을 지원하는지 확인.
 * 브라우저는 true, Node.js < 18은 false.
 */
function hasCompressionStream(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>)['CompressionStream'] !== 'undefined'
  );
}

/** 전역에서 스트림 생성자를 안전하게 가져온다 (hasCompressionStream 확인 후 호출 전제) */
function getStreamCtor(name: 'CompressionStream' | 'DecompressionStream'): GzipStreamCtor {
  return (globalThis as Record<string, unknown>)[name] as GzipStreamCtor;
}

// ─────────────────────────────────────────────
// 브라우저 구현 (CompressionStream)
// ─────────────────────────────────────────────

/**
 * Web Streams API를 사용한 gzip 압축 (브라우저 환경).
 * ReadableStream → CompressionStream('gzip') → Uint8Array 수집.
 */
async function gzipCompressBrowser(data: Uint8Array): Promise<Uint8Array> {
  // 입력 데이터를 ReadableStream으로 래핑 (Blob은 ArrayBufferView를 직접 수용)
  // SharedArrayBuffer 기반 뷰는 사용하지 않으므로 ArrayBuffer 뷰로 단언
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  // CompressionStream으로 파이프
  const compressed = stream.pipeThrough(new (getStreamCtor('CompressionStream'))('gzip'));
  // 스트림에서 ArrayBuffer 수집 후 Uint8Array 변환
  const response = new Response(compressed);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Web Streams API를 사용한 gzip 해제 (브라우저 환경).
 */
async function gzipDecompressBrowser(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream();
  const decompressed = stream.pipeThrough(new (getStreamCtor('DecompressionStream'))('gzip'));
  const response = new Response(decompressed);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

// ─────────────────────────────────────────────
// Node.js 구현 (node:zlib 폴백)
// ─────────────────────────────────────────────

/**
 * node:zlib을 사용한 gzip 압축 (Node.js 환경).
 * 동적 import로 브라우저 번들에 포함되지 않도록 격리.
 */
async function gzipCompressNode(data: Uint8Array): Promise<Uint8Array> {
  // 동적 import: 브라우저 번들러가 이 코드를 번들에 포함하지 않도록 함
  const zlib = await import('node:zlib');
  const util = await import('node:util');
  const gzipFn = util.promisify(zlib.gzip);
  // Buffer로 전달해도 Uint8Array로 자동 처리됨
  const result = await gzipFn(data);
  return new Uint8Array(result);
}

/**
 * node:zlib을 사용한 gzip 해제 (Node.js 환경).
 */
async function gzipDecompressNode(data: Uint8Array): Promise<Uint8Array> {
  const zlib = await import('node:zlib');
  const util = await import('node:util');
  const gunzipFn = util.promisify(zlib.gunzip);
  const result = await gunzipFn(data);
  return new Uint8Array(result);
}

// ─────────────────────────────────────────────
// 공개 API (환경 자동 선택)
// ─────────────────────────────────────────────

/**
 * gzip 압축.
 * 브라우저에서는 CompressionStream, Node.js에서는 node:zlib 자동 선택.
 * @param data 압축할 원본 바이트
 * @returns 압축된 바이트
 */
export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  if (hasCompressionStream()) {
    return gzipCompressBrowser(data);
  }
  return gzipCompressNode(data);
}

/**
 * gzip 해제.
 * 브라우저에서는 DecompressionStream, Node.js에서는 node:zlib 자동 선택.
 * @param data 압축 해제할 gzip 바이트
 * @returns 원본 바이트
 */
export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (hasCompressionStream()) {
    return gzipDecompressBrowser(data);
  }
  return gzipDecompressNode(data);
}
