/**
 * @file qr-safe.test.ts
 * @description qr-safe.ts(ASCII-safe Base64 인코딩) 라운드트립 및 경계 조건 테스트.
 * Android BarcodeDetector의 UTF-8 강제 디코딩으로부터 임의 바이트를 보호하는지 검증한다.
 */

import { describe, it, expect } from 'vitest';
import { toAsciiSafe, fromAsciiSafe } from '../src/qr-safe.js';

/** 결정론적 의사난수 바이트 배열 생성 (0~255 전 범위 포함) */
function makeRandomBytes(size: number, seed = 7): Uint8Array {
  const data = new Uint8Array(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    data[i] = (s >>> 24) & 0xff;
  }
  return data;
}

describe('qr-safe: toAsciiSafe/fromAsciiSafe 라운드트립', () => {
  it('임의 바이트(0~255 전 범위 포함)를 인코딩→디코딩하면 원본과 일치해야 한다', () => {
    const original = makeRandomBytes(220);
    const encoded = toAsciiSafe(original);
    const decoded = fromAsciiSafe(encoded);
    expect(decoded).toEqual(original);
  });

  it('인코딩 결과는 전부 ASCII(0~127) 범위여야 한다 — UTF-8/Latin-1 어느 쪽으로 해석돼도 무손실', () => {
    const original = makeRandomBytes(220);
    const encoded = toAsciiSafe(original);
    for (const b of encoded) {
      expect(b).toBeLessThan(128);
    }
  });

  it('0x80 이상 바이트만으로 구성된 페이로드도 무손실 왕복해야 한다 (버그 재현 시나리오)', () => {
    const original = new Uint8Array(200).fill(0).map((_, i) => 0x80 + (i % 128));
    const encoded = toAsciiSafe(original);
    const decoded = fromAsciiSafe(encoded);
    expect(decoded).toEqual(original);
  });

  it('빈 배열도 라운드트립해야 한다', () => {
    const original = new Uint8Array(0);
    const encoded = toAsciiSafe(original);
    const decoded = fromAsciiSafe(encoded);
    expect(decoded).toEqual(original);
  });

  it('길이가 1, 2, 3의 배수+나머지인 다양한 크기에서 라운드트립해야 한다 (Base64 패딩 경계)', () => {
    for (const len of [1, 2, 3, 4, 5, 6, 7, 199, 200, 201]) {
      const original = makeRandomBytes(len, len);
      const decoded = fromAsciiSafe(toAsciiSafe(original));
      expect(decoded).toEqual(original);
    }
  });

  it('형식이 잘못된 Base64 바이트는 null을 반환해야 한다 (손상된 QR 읽기로 처리)', () => {
    // Base64 알파벳에 속하지 않는 문자('!')로만 구성 — 공백은 forgiving-base64에서 제거되므로 사용 금지
    const garbage = new Uint8Array([0x21, 0x21, 0x21, 0x21]);
    expect(fromAsciiSafe(garbage)).toBeNull();
  });
});
