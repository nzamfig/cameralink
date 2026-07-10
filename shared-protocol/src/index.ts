/**
 * @file index.ts
 * @description shared-protocol 모듈의 공개 API 진입점.
 * 송신기(Spring Boot 프론트엔드)와 수신기(PWA) 양쪽에서
 * 이 파일만 import하면 모든 프로토콜 구성요소에 접근 가능.
 *
 * 수출 구성:
 *   constants.ts  → 프로토콜 상수
 *   prng.ts       → Mulberry32 PRNG
 *   crc.ts        → CRC16, CRC32
 *   codec.ts      → 심볼 직렬화/역직렬화 + 타입
 *   gzip.ts       → gzip 압축/해제
 *   lt-encoder.ts → LT 인코더
 *   lt-decoder.ts → LT 디코더
 */

// 프로토콜 상수
export * from './constants.js';

// 의사난수 생성기
export * from './prng.js';

// CRC 체크섬
export * from './crc.js';

// 심볼 코덱 (타입 + 직렬화/역직렬화)
export * from './codec.js';

// gzip 압축
export * from './gzip.js';

// LT 공통 유틸리티 (sampleDegree, sampleIndices, splitIntoBlocks)
export * from './lt-common.js';

// LT 인코더 (LtEncoder 클래스)
export * from './lt-encoder.js';

// LT 디코더 (LtDecoder 클래스)
export * from './lt-decoder.js';
