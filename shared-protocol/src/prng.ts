/**
 * @file prng.ts
 * @description Mulberry32 결정론적 의사난수 생성기(PRNG).
 * LT 인코더(송신기)와 LT 디코더(수신기) 양쪽이 동일한 seed를 사용하면
 * 완전히 동일한 난수열을 생성한다. 이를 통해 수신기는 각 심볼이
 * "어떤 블록들을 XOR한 결과인지"를 헤더 정보만으로 역산할 수 있다.
 *
 * 관계: lt-encoder.ts, lt-decoder.ts 양쪽에서 import하여 사용.
 * 이 함수의 구현이 달라지면 인코더-디코더 간 인덱스 불일치로 복원 불가.
 */

/**
 * Mulberry32 결정론적 PRNG.
 * LT 인코더와 디코더가 같은 seed로 완전히 동일한 난수열을 얻어야
 * "어떤 블록들이 XOR되었는지"를 수신 측이 역산할 수 있다.
 * @param seed 32비트 정수 시드
 * @returns 호출할 때마다 [0,1) 실수를 반환하는 함수
 */
export function mulberry32(seed: number): () => number {
  return function () {
    // 32비트 정수 연산 강제 (비트 OR 0)
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    // 비선형 혼합 1단계: 상위 비트로 하위 비트 교란
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    // 비선형 혼합 2단계: 추가 확산
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    // [0, 2^32) 정수를 [0, 1) 실수로 변환 (>>> 0 으로 부호 없는 32비트 보장)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
