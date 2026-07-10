/**
 * @file lt-encoder.ts
 * @description Luby Transform(LT) 코드 인코더.
 * 소스 데이터를 고정 크기 블록으로 분할하고,
 * Robust Soliton 분포에 따라 선택한 블록들을 XOR하여
 * 이론적으로 무한히 생성 가능한 인코딩 심볼을 만든다.
 *
 * 핵심 특성:
 * - 각 심볼은 seed 하나로 완전히 결정(결정론적)
 * - 수신기가 seed를 알면 어떤 블록들이 XOR됐는지 동일하게 재현 가능
 * - 원본 블록 수 k의 약 1.05배만 수신해도 복원 가능 (이상적 조건)
 *
 * 관계:
 *   prng.ts      → mulberry32 PRNG 사용
 *   lt-common.ts → sampleDegree, sampleIndices, splitIntoBlocks (공유 로직)
 *   codec.ts     → encodeDataSymbol로 바이트 직렬화
 *   lt-decoder.ts와 쌍을 이룸 (같은 seed → 같은 인덱스 보장)
 */
import { mulberry32 } from './prng.js';
import { sampleDegree, sampleIndices } from './lt-common.js';
/** Robust Soliton 파라미터 */
const C = 0.1;
const DELTA = 0.05;
/**
 * Luby Transform 인코더.
 * 소스 블록 배열을 받아 임의의 seed로 인코딩 심볼을 무한 생성.
 */
export class LtEncoder {
    blocks;
    totalBlocks;
    blockSize;
    /**
     * @param blocks 균일한 크기로 분할된 소스 블록 배열 (마지막 블록은 제로패딩 허용)
     * @param totalBlocks 총 블록 수 (blocks.length와 일치해야 함)
     */
    constructor(blocks, totalBlocks) {
        this.blocks = blocks;
        this.totalBlocks = totalBlocks;
        this.blockSize = blocks.length > 0 ? blocks[0].length : 0;
    }
    /**
     * 주어진 seed로 LT 심볼 1개를 생성.
     * seed만으로 결정론적으로 생성되므로 인코더 상태 최소화.
     *
     * 과정:
     * 1. seed로 PRNG 초기화
     * 2. PRNG로 degree 샘플링 (Robust Soliton)
     * 3. PRNG로 degree개의 블록 인덱스 선택 (Fisher-Yates)
     * 4. 선택한 블록들을 XOR하여 payload 생성
     *
     * @param seed uint32 시드 (DataSymbol의 seed 필드와 동일)
     * @returns payload (XOR 결합 Uint8Array)와 사용된 블록 인덱스들
     */
    nextSymbol(seed) {
        const rand = mulberry32(seed);
        // Robust Soliton 분포에서 degree 샘플링
        const degree = sampleDegree(this.totalBlocks, C, DELTA, rand);
        // degree개의 블록 인덱스를 중복 없이 선택
        const indices = sampleIndices(this.totalBlocks, degree, rand);
        // 선택한 블록들을 XOR하여 인코딩 심볼 payload 생성
        const payload = new Uint8Array(this.blockSize);
        for (const idx of indices) {
            const block = this.blocks[idx];
            if (!block)
                continue;
            for (let i = 0; i < this.blockSize; i++) {
                payload[i] ^= block[i];
            }
        }
        return { payload, indices };
    }
}
