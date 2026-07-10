/**
 * @file lt-common.ts
 * @description LT 인코더와 디코더가 공통으로 사용하는 유틸리티 함수.
 * lt-encoder.ts와 lt-decoder.ts 양쪽에서 import하여 순환 의존성 방지.
 *
 * 관계:
 *   lt-encoder.ts → sampleDegree, sampleIndices, splitIntoBlocks import
 *   lt-decoder.ts → sampleDegree, sampleIndices import
 *   prng.ts       → mulberry32 import (간접 의존)
 */
// ─────────────────────────────────────────────
// Robust Soliton 분포 유틸리티
// ─────────────────────────────────────────────
/**
 * Ideal Soliton 분포의 확률값.
 * ρ(1) = 1/k, ρ(d) = 1/(d*(d-1)) for d >= 2
 */
function rho(d, k) {
    if (d === 1)
        return 1 / k;
    return 1 / (d * (d - 1));
}
/**
 * Robust Soliton 분포의 스파이크 함수 tau.
 * k/R 지점에 스파이크를 추가하여 실제 디코딩 성공률을 높임.
 * R = c * sqrt(k) * ln(k/delta)
 */
function tau(d, k, c, delta) {
    const R = c * Math.sqrt(k) * Math.log(k / delta);
    const spike = Math.floor(k / R);
    if (d < spike)
        return R / (k * d);
    if (d === spike)
        return (R / k) * Math.log(R / delta);
    return 0;
}
/**
 * Robust Soliton 분포에서 degree 샘플링.
 * mu(d) = rho(d) + tau(d) 를 정규화한 분포에서 CDF 역변환으로 샘플링.
 * @param k 총 블록 수
 * @param c 스파이크 폭 제어 파라미터
 * @param delta 실패 확률 상한
 * @param rand Mulberry32 PRNG 함수
 * @returns 샘플링된 degree (1 이상 k 이하)
 */
export function sampleDegree(k, c, delta, rand) {
    const weights = [];
    let Z = 0;
    for (let d = 1; d <= k; d++) {
        const w = rho(d, k) + tau(d, k, c, delta);
        weights.push(w);
        Z += w;
    }
    const u = rand() * Z;
    let cumulative = 0;
    for (let d = 1; d <= k; d++) {
        cumulative += weights[d - 1];
        if (u <= cumulative)
            return d;
    }
    return k;
}
/**
 * PRNG로 [0, k) 범위에서 중복 없이 d개 인덱스 선택.
 * Fisher-Yates 부분 셔플 방식: O(d)로 효율적.
 * @param k 총 블록 수
 * @param d 선택할 인덱스 수
 * @param rand Mulberry32 PRNG 함수
 */
export function sampleIndices(k, d, rand) {
    const swapped = new Map();
    const get = (i) => swapped.get(i) ?? i;
    for (let i = 0; i < d; i++) {
        const j = i + Math.floor(rand() * (k - i));
        const vi = get(i);
        const vj = get(j);
        swapped.set(i, vj);
        swapped.set(j, vi);
    }
    return Array.from({ length: d }, (_, i) => get(i));
}
/**
 * 데이터를 고정 크기 블록으로 분할.
 * 마지막 블록이 블록 크기에 미달하면 0으로 패딩.
 * @param data 분할할 원본 데이터
 * @param blockSize 각 블록의 바이트 크기
 */
export function splitIntoBlocks(data, blockSize) {
    const blocks = [];
    for (let i = 0; i < data.length; i += blockSize) {
        const end = Math.min(i + blockSize, data.length);
        const block = new Uint8Array(blockSize);
        block.set(data.subarray(i, end));
        blocks.push(block);
    }
    if (blocks.length === 0) {
        blocks.push(new Uint8Array(blockSize));
    }
    return blocks;
}
