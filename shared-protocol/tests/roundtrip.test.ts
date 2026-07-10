/**
 * @file roundtrip.test.ts
 * @description shared-protocol 모듈 라운드트립 통합 테스트.
 * Phase 0 완료 기준: 아래 모든 테스트가 통과해야 Phase 1로 진행 가능.
 *
 * 테스트 시나리오:
 * 1. 기본 라운드트립 (정상 수신)
 * 2. 30% 심볼 손실 후 복원
 * 3. CRC16 오염 심볼 자동 폐기
 * 4. 헤더 지연 수신 (데이터 선수신 → 헤더 → 재처리)
 * 5. 중복 심볼 강건성
 * 6. gzip 라운드트립
 * 7. CRC 정확성
 * 8. Codec 라운드트립 (헤더/데이터 심볼 직렬화 ↔ 역직렬화)
 */

import { describe, it, expect } from 'vitest';
import { LtEncoder } from '../src/lt-encoder.js';
import { LtDecoder } from '../src/lt-decoder.js';
import { splitIntoBlocks } from '../src/lt-common.js';
import { encodeDataSymbol, encodeHeader, decodeSymbol } from '../src/codec.js';
import { gzipCompress, gzipDecompress } from '../src/gzip.js';
import { crc16, crc32 } from '../src/crc.js';
import type { DecoderMeta } from '../src/lt-decoder.js';
import { PAYLOAD_SIZE, SYMBOL_TYPE_HEADER, SYMBOL_TYPE_DATA } from '../src/constants.js';

// ─────────────────────────────────────────────
// 테스트용 유틸리티
// ─────────────────────────────────────────────

/** 재현 가능한 의사난수 바이트 배열 생성 (테스트용) */
function makeTestData(size: number, seed = 42): Uint8Array {
  const data = new Uint8Array(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    // 간단한 LCG로 결정론적 데이터 생성
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    data[i] = (s >>> 24) & 0xff;
  }
  return data;
}

/**
 * 테스트용 인코딩 → 심볼 바이트 배열 생성 헬퍼.
 * @param data 원본 데이터
 * @param symbolCount 생성할 심볼 수
 * @returns 심볼 바이트 배열 목록과 메타데이터
 */
function encodeToSymbols(
  data: Uint8Array,
  symbolCount: number,
  payloadSize = PAYLOAD_SIZE
): { symbolBytes: Uint8Array[]; meta: DecoderMeta } {
  const blocks = splitIntoBlocks(data, payloadSize);
  const encoder = new LtEncoder(blocks, blocks.length);
  const grid = (4 << 4) | 4; // 4x4 격자 (테스트용)

  const symbolBytes: Uint8Array[] = [];
  for (let i = 0; i < symbolCount; i++) {
    const seed = i + 1; // seed는 0 금지 (Mulberry32 특성)
    const { payload } = encoder.nextSymbol(seed);
    const bytes = encodeDataSymbol({
      grid,
      seed,
      payloadLen: payload.length,
      payload,
    });
    symbolBytes.push(bytes);
  }

  const meta: DecoderMeta = {
    filename: 'test.bin',
    originalSize: data.length,
    storedSize: data.length,
    compressed: false,
    payloadSize,
    totalBlocks: blocks.length,
    crc32: crc32(data),
  };

  return { symbolBytes, meta };
}

/**
 * 디코더에 심볼 목록을 투입하고 복원된 결과 반환.
 * @param symbolBytes 심볼 바이트 배열 목록
 * @param meta 파일 메타데이터 (헤더)
 * @param headerFirst 헤더를 심볼보다 먼저 설정할지 여부
 */
function decode(
  symbolBytes: Uint8Array[],
  meta: DecoderMeta,
  headerFirst = true
): Uint8Array {
  const decoder = new LtDecoder();
  if (headerFirst) decoder.setHeader(meta);
  for (const bytes of symbolBytes) {
    decoder.addSymbol(bytes);
  }
  if (!headerFirst) decoder.setHeader(meta);
  if (!decoder.isComplete()) {
    throw new Error(`디코딩 미완료: ${decoder.progress().toFixed(2)} 진행`);
  }
  return decoder.getResult();
}

// ─────────────────────────────────────────────
// 1. 기본 라운드트립
// ─────────────────────────────────────────────

describe('1. 기본 라운드트립', () => {
  it('1000바이트 데이터를 인코딩→디코딩하면 원본과 일치해야 한다', () => {
    const original = makeTestData(1000);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    // 원본 블록 수의 150% 심볼 생성 (충분한 잉여)
    const symbolCount = Math.ceil(blocks.length * 1.5) + 20;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    const restored = decode(symbolBytes, meta);
    expect(restored).toEqual(original);
  });

  it('소량 데이터(10바이트)도 처리 가능해야 한다', () => {
    const original = makeTestData(10, 99);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = blocks.length * 5 + 20;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    const restored = decode(symbolBytes, meta);
    // storedSize만큼만 비교 (패딩 블록 제외)
    expect(restored.slice(0, original.length)).toEqual(original);
  });

  it('정확히 PAYLOAD_SIZE 배수인 데이터도 처리 가능해야 한다', () => {
    const original = makeTestData(PAYLOAD_SIZE * 3, 7);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 2) + 10;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    const restored = decode(symbolBytes, meta);
    expect(restored).toEqual(original);
  });
});

// ─────────────────────────────────────────────
// 2. 30% 손실 테스트
// ─────────────────────────────────────────────

describe('2. 30% 심볼 손실 테스트', () => {
  it('심볼 30%를 무작위 드롭해도 복원 가능해야 한다', () => {
    const original = makeTestData(2000, 123);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    // 30% 손실을 감안하여 충분히 많은 심볼 생성 (2.5배)
    const symbolCount = Math.ceil(blocks.length * 2.5) + 30;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    // 결정론적으로 30% 드롭 (인덱스 0, 3, 6, ... 에 해당하는 것 제거)
    const dropped = symbolBytes.filter((_, i) => (i % 10) >= 3); // 70% 유지

    const restored = decode(dropped, meta);
    expect(restored).toEqual(original);
  });

  it('무작위 순서로 수신해도 복원 가능해야 한다', () => {
    const original = makeTestData(1500, 77);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 2) + 20;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    // 짝수 인덱스 먼저, 홀수 인덱스 나중에 (순서 섞기)
    const shuffled = [
      ...symbolBytes.filter((_, i) => i % 2 === 0),
      ...symbolBytes.filter((_, i) => i % 2 === 1),
    ];

    const restored = decode(shuffled, meta);
    expect(restored).toEqual(original);
  });
});

// ─────────────────────────────────────────────
// 3. CRC16 폐기 테스트
// ─────────────────────────────────────────────

describe('3. CRC16 오염 심볼 폐기 테스트', () => {
  it('일부 심볼에 랜덤 오염이 있어도 나머지로 복원 가능해야 한다', () => {
    const original = makeTestData(1200, 55);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 3) + 30;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    // 짝수 인덱스 심볼의 마지막 바이트를 뒤집어 오염 (CRC16 오류 유발)
    const corrupted = symbolBytes.map((bytes, i) => {
      if (i % 3 === 0) {
        // 3개 중 1개 오염 (~33%)
        const copy = new Uint8Array(bytes);
        // payload 중간 바이트 반전 (CRC 필드가 아닌 데이터를 건드려야 CRC 불일치)
        if (copy.length > 5) copy[5] ^= 0xff;
        return copy;
      }
      return bytes;
    });

    // 오염된 심볼은 CRC16 검증 실패로 자동 폐기됨
    const restored = decode(corrupted, meta);
    expect(restored).toEqual(original);
  });

  it('CRC16 필드 자체를 변조하면 심볼이 폐기되어야 한다', () => {
    const original = makeTestData(50, 11);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const { symbolBytes, meta } = encodeToSymbols(original, blocks.length * 4 + 10);

    // 첫 번째 심볼의 마지막 2바이트(CRC16 필드)를 0으로 덮어씀
    const tampered = symbolBytes.map((bytes, i) => {
      if (i === 0) {
        const copy = new Uint8Array(bytes);
        // 마지막 2바이트 = CRC16 필드
        copy[copy.length - 2] = 0x00;
        copy[copy.length - 1] = 0x00;
        return copy;
      }
      return bytes;
    });

    // 나머지 심볼로 복원 가능해야 함
    const restored = decode(tampered, meta);
    expect(restored).toEqual(original);
  });
});

// ─────────────────────────────────────────────
// 4. 헤더 지연 수신 테스트
// ─────────────────────────────────────────────

describe('4. 헤더 지연 수신 테스트', () => {
  it('데이터 심볼 수십 개를 먼저 받고 나중에 헤더를 받아도 복원 가능해야 한다', () => {
    const original = makeTestData(800, 33);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 2.5) + 20;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    const decoder = new LtDecoder();

    // 헤더 없이 데이터 심볼 먼저 추가 (버퍼링됨)
    for (const bytes of symbolBytes) {
      decoder.addSymbol(bytes);
    }
    // 이 시점에서는 진행률 0 (헤더 없음)
    expect(decoder.progress()).toBe(0);

    // 나중에 헤더 설정 → 버퍼링된 심볼 일괄 재처리
    decoder.setHeader(meta);

    // 충분한 심볼이 버퍼에 있었으므로 복원 완료되어야 함
    expect(decoder.isComplete()).toBe(true);
    const restored = decoder.getResult();
    expect(restored).toEqual(original);
  });

  it('헤더 이전 데이터 심볼이 버퍼링되다가 헤더 설정 후 진행률이 증가해야 한다', () => {
    // 블록 수를 충분히 늘려(2000바이트 → 10블록) 절반 심볼로도 일부 복원 가능하게 설정
    const original = makeTestData(2000, 22);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    // 충분히 많은 심볼 생성 (블록 수의 4배)
    const symbolCount = Math.ceil(blocks.length * 4);
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    const decoder = new LtDecoder();

    // 심볼의 75%를 헤더 없이 추가 (degree=1 심볼이 포함되어 일부 블록 버퍼링)
    const portion = Math.floor(symbolBytes.length * 0.75);
    for (let i = 0; i < portion; i++) {
      decoder.addSymbol(symbolBytes[i]);
    }
    expect(decoder.progress()).toBe(0);

    // 헤더 설정 → 버퍼링된 심볼 일괄 재처리
    decoder.setHeader(meta);
    // 충분한 수의 심볼이 버퍼링되어 있으므로 진행률 0 초과여야 함
    expect(decoder.progress()).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// 5. 중복 심볼 테스트
// ─────────────────────────────────────────────

describe('5. 중복 심볼 강건성 테스트', () => {
  it('같은 seed 심볼을 여러 번 추가해도 동일한 결과를 반환해야 한다', () => {
    const original = makeTestData(600, 66);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 2) + 15;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    // 심볼 목록 중 일부를 3번씩 중복
    const withDuplicates = [
      ...symbolBytes,
      ...symbolBytes.slice(0, 5), // 처음 5개 중복
      ...symbolBytes.slice(0, 5), // 또 중복
    ];

    const restored = decode(withDuplicates, meta);
    expect(restored).toEqual(original);
  });

  it('모든 심볼을 100% 중복해도 안전하게 처리되어야 한다', () => {
    const original = makeTestData(300, 44);
    const blocks = splitIntoBlocks(original, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 3) + 10;
    const { symbolBytes, meta } = encodeToSymbols(original, symbolCount);

    // 전체를 두 번 반복
    const doubled = [...symbolBytes, ...symbolBytes];

    const restored = decode(doubled, meta);
    expect(restored).toEqual(original);
  });
});

// ─────────────────────────────────────────────
// 6. gzip 라운드트립
// ─────────────────────────────────────────────

describe('6. gzip 라운드트립 테스트', () => {
  it('gzipCompress → gzipDecompress → 원본 일치', async () => {
    const original = makeTestData(1000, 88);
    const compressed = await gzipCompress(original);

    // 압축된 데이터는 원본과 달라야 함 (유효한 gzip)
    expect(compressed).not.toEqual(original);
    // gzip 매직 바이트 확인 (0x1f 0x8b)
    expect(compressed[0]).toBe(0x1f);
    expect(compressed[1]).toBe(0x8b);

    const decompressed = await gzipDecompress(compressed);
    expect(decompressed).toEqual(original);
  });

  it('반복 패턴 데이터는 gzip으로 크게 압축되어야 한다', async () => {
    // 반복 패턴은 gzip으로 잘 압축됨
    const repetitive = new Uint8Array(1000).fill(0xab);
    const compressed = await gzipCompress(repetitive);

    // 압축 후 크기가 원본보다 작아야 함
    expect(compressed.length).toBeLessThan(repetitive.length);

    const decompressed = await gzipDecompress(compressed);
    expect(decompressed).toEqual(repetitive);
  });

  it('빈 데이터도 gzip 처리 가능해야 한다', async () => {
    const empty = new Uint8Array(0);
    const compressed = await gzipCompress(empty);
    const decompressed = await gzipDecompress(compressed);
    expect(decompressed).toEqual(empty);
  });

  it('gzip 압축 후 LT 인코딩/디코딩 통합 테스트', async () => {
    const original = makeTestData(1500, 17);
    const compressed = await gzipCompress(original);

    const blocks = splitIntoBlocks(compressed, PAYLOAD_SIZE);
    const symbolCount = Math.ceil(blocks.length * 2) + 20;
    const { symbolBytes, meta } = encodeToSymbols(compressed, symbolCount);

    // 헤더에 압축 정보 반영
    const compressedMeta: DecoderMeta = {
      ...meta,
      filename: 'test.bin',
      originalSize: original.length,
      storedSize: compressed.length,
      compressed: true,
      crc32: crc32(compressed), // 압축 데이터 기준 CRC
    };

    const restoredCompressed = decode(symbolBytes, compressedMeta);
    const restoredOriginal = await gzipDecompress(restoredCompressed);
    expect(restoredOriginal).toEqual(original);
  });
});

// ─────────────────────────────────────────────
// 7. CRC 정확성 테스트
// ─────────────────────────────────────────────

describe('7. CRC 정확성 테스트', () => {
  describe('CRC16', () => {
    it('동일 데이터에 대해 항상 같은 CRC16 값을 반환해야 한다', () => {
      const data = makeTestData(100, 5);
      const result1 = crc16(data);
      const result2 = crc16(data);
      expect(result1).toBe(result2);
    });

    it('다른 데이터는 다른 CRC16 값을 가져야 한다 (충돌 없음)', () => {
      const data1 = makeTestData(100, 1);
      const data2 = makeTestData(100, 2);
      expect(crc16(data1)).not.toBe(crc16(data2));
    });

    it('1바이트 변경으로 CRC16이 달라져야 한다', () => {
      const data = makeTestData(50, 9);
      const modified = new Uint8Array(data);
      modified[25] ^= 0x01; // 단일 비트 반전
      expect(crc16(data)).not.toBe(crc16(modified));
    });

    it('빈 배열의 CRC16은 0xFFFF (초기값)이어야 한다', () => {
      // 초기값 0xFFFF, 데이터 없음 → 결과 0xFFFF
      expect(crc16(new Uint8Array(0))).toBe(0xffff);
    });

    it('16비트 범위 내여야 한다 (0~65535)', () => {
      for (let seed = 0; seed < 20; seed++) {
        const data = makeTestData(50, seed);
        const result = crc16(data);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xffff);
      }
    });
  });

  describe('CRC32', () => {
    it('동일 데이터에 대해 항상 같은 CRC32 값을 반환해야 한다', () => {
      const data = makeTestData(500, 3);
      expect(crc32(data)).toBe(crc32(data));
    });

    it('다른 데이터는 다른 CRC32 값을 가져야 한다', () => {
      const data1 = makeTestData(200, 10);
      const data2 = makeTestData(200, 20);
      expect(crc32(data1)).not.toBe(crc32(data2));
    });

    it('알려진 CRC32 참조값과 일치해야 한다', () => {
      // "123456789" 문자열의 CRC32 = 0xCBF43926 (표준 참조값)
      const knownData = new TextEncoder().encode('123456789');
      expect(crc32(knownData)).toBe(0xcbf43926);
    });

    it('32비트 범위 내여야 한다 (0~4294967295)', () => {
      for (let seed = 0; seed < 10; seed++) {
        const data = makeTestData(100, seed);
        const result = crc32(data);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(0xffffffff);
      }
    });
  });
});

// ─────────────────────────────────────────────
// 8. Codec 라운드트립 테스트
// ─────────────────────────────────────────────

describe('8. Codec 라운드트립 테스트', () => {
  describe('헤더 심볼', () => {
    it('encodeHeader → decodeSymbol → 필드값 일치해야 한다', () => {
      const original = {
        grid: (4 << 4) | 4, // 4x4
        flags: 0x01,         // gzip 압축됨
        filename: 'hello.txt',
        originalSize: 12345,
        storedSize: 9876,
        payloadSize: PAYLOAD_SIZE,
        totalBlocks: 62,
        crc32: 0xdeadbeef,
      };

      const bytes = encodeHeader(original);
      const decoded = decodeSymbol(bytes);

      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(SYMBOL_TYPE_HEADER);
      if (decoded!.type !== 0x01) throw new Error('타입 불일치');

      expect(decoded.grid).toBe(original.grid);
      expect(decoded.cols).toBe(4);
      expect(decoded.rows).toBe(4);
      expect(decoded.flags).toBe(original.flags);
      expect(decoded.compressed).toBe(true); // flags bit0 = 1
      expect(decoded.filename).toBe(original.filename);
      expect(decoded.originalSize).toBe(original.originalSize);
      expect(decoded.storedSize).toBe(original.storedSize);
      expect(decoded.payloadSize).toBe(original.payloadSize);
      expect(decoded.totalBlocks).toBe(original.totalBlocks);
      expect(decoded.crc32).toBe(original.crc32);
    });

    it('한국어 파일명도 UTF-8로 올바르게 직렬화/역직렬화되어야 한다', () => {
      const original = {
        grid: (2 << 4) | 2,
        flags: 0x00,
        filename: '테스트파일.pdf',
        originalSize: 99999,
        storedSize: 99999,
        payloadSize: 200,
        totalBlocks: 500,
        crc32: 0x12345678,
      };

      const bytes = encodeHeader(original);
      const decoded = decodeSymbol(bytes);

      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(SYMBOL_TYPE_HEADER);
      if (decoded!.type !== 0x01) throw new Error();
      expect(decoded.filename).toBe(original.filename);
    });

    it('gzip 미적용 헤더의 compressed 필드는 false여야 한다', () => {
      const original = {
        grid: (4 << 4) | 4,
        flags: 0x00, // bit0 = 0 → 미압축
        filename: 'raw.bin',
        originalSize: 500,
        storedSize: 500,
        payloadSize: 200,
        totalBlocks: 3,
        crc32: 0xaaaabbbb,
      };

      const bytes = encodeHeader(original);
      const decoded = decodeSymbol(bytes);
      if (decoded!.type !== 0x01) throw new Error();
      expect(decoded.compressed).toBe(false);
    });
  });

  describe('데이터 심볼', () => {
    it('encodeDataSymbol → decodeSymbol → 필드값 일치해야 한다', () => {
      const payload = makeTestData(PAYLOAD_SIZE, 77);
      const original = {
        grid: (4 << 4) | 4,
        seed: 0xdeadbeef,
        payloadLen: PAYLOAD_SIZE,
        payload,
      };

      const bytes = encodeDataSymbol(original);
      const decoded = decodeSymbol(bytes);

      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe(SYMBOL_TYPE_DATA);
      if (decoded!.type !== 0x02) throw new Error('타입 불일치');

      expect(decoded.seed).toBe(original.seed);
      expect(decoded.payloadLen).toBe(original.payloadLen);
      expect(decoded.payload).toEqual(original.payload);
      expect(decoded.grid).toBe(original.grid);
      expect(decoded.cols).toBe(4);
      expect(decoded.rows).toBe(4);
    });

    it('CRC16이 자동으로 계산되어 포함되어야 한다', () => {
      const payload = makeTestData(50, 33);
      const bytes = encodeDataSymbol({
        grid: (2 << 4) | 2,
        seed: 42,
        payloadLen: 50,
        payload,
      });

      // 마지막 2바이트가 CRC16 필드
      const storedCrc =
        (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
      // CRC 계산 대상: 마지막 2바이트 제외한 전체
      const expected = crc16(bytes.subarray(0, bytes.length - 2));
      expect(storedCrc).toBe(expected);
    });

    it('데이터 오염 시 decodeSymbol이 null을 반환해야 한다', () => {
      const payload = makeTestData(PAYLOAD_SIZE, 55);
      const bytes = encodeDataSymbol({
        grid: (4 << 4) | 4,
        seed: 100,
        payloadLen: PAYLOAD_SIZE,
        payload,
      });

      // payload 영역 오염 (CRC16 실패 유발)
      const corrupted = new Uint8Array(bytes);
      corrupted[10] ^= 0xff; // 데이터 영역 비트 반전

      const decoded = decodeSymbol(corrupted);
      expect(decoded).toBeNull();
    });

    it('type=0x02로 시작하지 않는 바이트는 null을 반환해야 한다', () => {
      const invalid = new Uint8Array([0xff, 0x01, 0x02, 0x03]);
      expect(decodeSymbol(invalid)).toBeNull();
    });

    it('너무 짧은 바이트는 null을 반환해야 한다', () => {
      expect(decodeSymbol(new Uint8Array([0x02]))).toBeNull();
      expect(decodeSymbol(new Uint8Array(0))).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────
// 부록: PRNG 결정론적 특성 확인
// ─────────────────────────────────────────────

describe('PRNG 결정론적 특성', () => {
  it('같은 seed로 초기화한 PRNG는 동일한 수열을 생성해야 한다', async () => {
    const { mulberry32 } = await import('../src/prng.js');
    const rng1 = mulberry32(12345);
    const rng2 = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('다른 seed로 초기화한 PRNG는 첫 값부터 달라야 한다', async () => {
    const { mulberry32 } = await import('../src/prng.js');
    const rng1 = mulberry32(1);
    const rng2 = mulberry32(2);
    expect(rng1()).not.toBe(rng2());
  });

  it('PRNG 출력은 [0, 1) 범위여야 한다', async () => {
    const { mulberry32 } = await import('../src/prng.js');
    const rng = mulberry32(999);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
