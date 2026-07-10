/**
 * @file lt-decoder.ts
 * @description Luby Transform(LT) 코드 디코더 (Belief Propagation / Peeling 알고리즘).
 * 수신된 인코딩 심볼들을 처리하여 원본 소스 블록을 복원한다.
 *
 * 핵심 알고리즘 (BP Peeling):
 * 1. degree=1 심볼 → 해당 블록을 즉시 확정
 * 2. 확정된 블록을 참조하는 다른 심볼들에 XOR 전파 → 새 degree=1 심볼 생성
 * 3. 모든 블록이 확정될 때까지 1-2 반복
 *
 * 헤더 선행 의존성:
 * - totalBlocks 없이는 seed→인덱스 역산 불가
 * - 헤더 전 수신 심볼은 원시 바이트로 버퍼링 → setHeader 호출 시 일괄 재처리
 *
 * 관계:
 *   prng.ts      → mulberry32 (seed→인덱스 역산)
 *   lt-common.ts → sampleDegree, sampleIndices (인코더와 동일 알고리즘)
 *   codec.ts     → decodeSymbol (바이트→심볼 파싱, CRC16 자동 검증)
 *   crc.ts       → crc32 (복원 완료 후 파일 무결성 검증)
 *
 * 주의: lt-encoder.ts를 직접 import하지 않고 lt-common.ts를 통해
 *       공유 함수를 참조하여 순환 의존성을 방지한다.
 */

import { mulberry32 } from './prng.js';
import { sampleDegree, sampleIndices } from './lt-common.js';
import { decodeSymbol } from './codec.js';
import { crc32 } from './crc.js';

/** Robust Soliton 파라미터 (lt-encoder.ts와 반드시 동일해야 함) */
const C = 0.1;
const DELTA = 0.05;

/**
 * 헤더 수신 전 버퍼링할 수 있는 원시 심볼의 최대 개수.
 * 헤더를 오래 못 받는 비정상 상황에서 메모리가 무한히 증가하는 것을 방지.
 * 4096개 × 심볼당 ~210B ≈ 860KB 수준으로 상한.
 */
const MAX_PENDING_RAW = 4096;

// ─────────────────────────────────────────────
// 타입 정의
// ─────────────────────────────────────────────

/** 디코더가 헤더에서 추출한 파일 메타데이터 */
export interface DecoderMeta {
  filename: string;
  originalSize: number;
  storedSize: number;
  compressed: boolean;
  payloadSize: number;    // 각 블록의 바이트 크기
  totalBlocks: number;    // 소스 블록 수 k
  crc32: number;          // 원본 파일(또는 압축본) CRC32
}

/**
 * 내부적으로 관리하는 심볼 엣지 (그래프 구조).
 * 각 수신 심볼은 여러 소스 블록을 가리키는 하이퍼에지.
 */
interface SymbolEdge {
  /** 아직 확정되지 않은 블록 인덱스 집합 */
  pendingIndices: Set<number>;
  /** 현재 XOR 누적값 (확정 블록 XOR 제거 후 남은 값) */
  xorValue: Uint8Array;
}

// ─────────────────────────────────────────────
// LT 디코더 클래스
// ─────────────────────────────────────────────

export class LtDecoder {
  // 헤더 정보 (setHeader 호출 전까지 null)
  private meta: DecoderMeta | null = null;

  // 소스 블록 복원 결과 배열 (null = 미확정)
  private decoded: (Uint8Array | null)[] = [];

  // 복원된 블록 수 카운터
  private resolvedCount = 0;

  // 헤더 수신 전 도착한 심볼들의 원시 바이트 버퍼
  private pendingRaw: Uint8Array[] = [];

  // 수신된 심볼 엣지들 (그래프 구조)
  private edges: SymbolEdge[] = [];

  // 각 블록이 포함된 엣지 인덱스 목록 (블록 확정 시 전파용)
  private blockEdges: number[][] = [];

  // 이미 처리한 seed 집합 (중복 심볼 방지)
  private seenSeeds = new Set<number>();

  // ─────────────────────────────────────────────

  /**
   * 데이터 심볼 추가.
   * - 헤더 미확정 시: 원시 바이트를 버퍼에 보관
   * - 헤더 확정 후: 즉시 처리
   * - CRC16 검증 실패 시 codec.decodeSymbol이 null 반환 → 자동 폐기
   * @param symbolBytes QR에서 읽은 원시 바이트
   * @returns 현재 복원 진행률 [0,1]
   */
  addSymbol(symbolBytes: Uint8Array): number {
    if (this.meta === null) {
      // 헤더 미확정: 원시 바이트 버퍼링 (복사하여 원본 참조 방지)
      // 상한 초과 시 새 심볼은 폐기 — 송신기가 무한 루프로 재생하므로
      // 헤더 수신 후 같은 seed의 심볼을 다시 받을 기회가 있다.
      if (this.pendingRaw.length < MAX_PENDING_RAW) {
        this.pendingRaw.push(new Uint8Array(symbolBytes));
      }
      return 0;
    }

    // 심볼 파싱 + CRC16 검증 (실패 시 null)
    const symbol = decodeSymbol(symbolBytes);
    if (symbol === null || symbol.type !== 0x02) {
      // CRC 실패 또는 헤더 심볼 → 무시
      return this.progress();
    }

    this._processDataSymbol(symbol.seed, symbol.payload);
    return this.progress();
  }

  /**
   * 헤더 확정. 대기 버퍼의 심볼을 일괄 재투입.
   * 진행 중 전송과 crc32/파일명이 다르면 reset() 후 새 전송으로 처리.
   * @param meta 헤더에서 파싱한 메타데이터
   */
  setHeader(meta: DecoderMeta): void {
    // 이미 헤더가 있고 동일 전송인지 확인
    if (this.meta !== null) {
      const same =
        this.meta.crc32 === meta.crc32 &&
        this.meta.filename === meta.filename &&
        this.meta.totalBlocks === meta.totalBlocks;

      if (same) {
        // 동일 전송의 중복 헤더: 무시
        return;
      }
      // 다른 전송 감지: 초기화 후 새 전송으로 처리
      this.reset();
    }

    this.meta = meta;

    // 소스 블록 배열 초기화
    this.decoded = new Array(meta.totalBlocks).fill(null);
    this.resolvedCount = 0;

    // 블록별 엣지 인덱스 목록 초기화
    this.blockEdges = Array.from({ length: meta.totalBlocks }, () => []);

    // 버퍼링된 심볼 일괄 재처리
    const buffered = this.pendingRaw;
    this.pendingRaw = [];

    for (const raw of buffered) {
      const symbol = decodeSymbol(raw);
      if (symbol !== null && symbol.type === 0x02) {
        this._processDataSymbol(symbol.seed, symbol.payload);
      }
      // CRC 실패 심볼은 자동 폐기
    }
  }

  /**
   * 데이터 심볼 내부 처리.
   * seed로 인덱스를 재현하고 그래프에 엣지를 추가한 후 BP 전파.
   */
  private _processDataSymbol(seed: number, payload: Uint8Array): void {
    // 중복 seed 심볼 방지
    if (this.seenSeeds.has(seed)) return;
    this.seenSeeds.add(seed);

    const meta = this.meta!;

    // seed로 PRNG 초기화 (인코더와 동일)
    const rand = mulberry32(seed);

    // 인코더와 동일한 알고리즘으로 degree와 인덱스 재현
    const degree = sampleDegree(meta.totalBlocks, C, DELTA, rand);
    const indices = sampleIndices(meta.totalBlocks, degree, rand);

    // XOR 누적값 초기화
    let xorAccum: Uint8Array = new Uint8Array(payload);

    // 이미 확정된 블록을 XOR 제거 (그래프 단순화)
    const pending = new Set<number>();
    for (const idx of indices) {
      const resolved = this.decoded[idx];
      if (resolved !== null) {
        // 이미 확정된 블록: XOR로 제거
        xorAccum = xorBytes(xorAccum, resolved);
      } else {
        // 아직 미확정 블록: pending에 추가
        pending.add(idx);
      }
    }

    if (pending.size === 0) {
      // 모든 블록이 이미 확정됨
      return;
    }

    if (pending.size === 1) {
      // degree=1: 마지막 남은 블록 즉시 확정
      const [idx] = pending;
      this._resolveBlock(idx, xorAccum);
      return;
    }

    // degree>1: 그래프에 엣지 추가 후 대기
    const edgeIdx = this.edges.length;
    this.edges.push({ pendingIndices: pending, xorValue: xorAccum });

    // 각 미확정 블록의 엣지 목록에 이 엣지 등록
    for (const idx of pending) {
      this.blockEdges[idx].push(edgeIdx);
    }
  }

  /**
   * 블록 확정 및 BP 전파.
   * 확정된 블록을 참조하는 모든 엣지에 XOR 전파 → 새 degree=1 발생 시 연쇄 처리.
   */
  private _resolveBlock(blockIdx: number, value: Uint8Array): void {
    // 이미 확정된 블록 중복 처리 방지
    if (this.decoded[blockIdx] !== null) return;

    // 블록 확정 기록
    this.decoded[blockIdx] = new Uint8Array(value);
    this.resolvedCount++;

    // 이 블록을 참조하는 모든 엣지에 전파
    const affectedEdges = this.blockEdges[blockIdx] ?? [];
    for (const edgeIdx of affectedEdges) {
      const edge = this.edges[edgeIdx];
      if (!edge) continue;

      // 이 블록을 pending에서 제거
      edge.pendingIndices.delete(blockIdx);
      // XOR 누적값에서 확정된 블록 제거
      edge.xorValue = xorBytes(edge.xorValue, value);

      if (edge.pendingIndices.size === 1) {
        // 새로운 degree=1 발생: 남은 블록 즉시 확정 (연쇄 전파)
        const [remaining] = edge.pendingIndices;
        this._resolveBlock(remaining, edge.xorValue);
      }
    }
  }

  /** 모든 블록 복원 완료 여부 */
  isComplete(): boolean {
    return this.meta !== null && this.resolvedCount >= this.meta.totalBlocks;
  }

  /**
   * 복원 진행률 [0,1].
   * 헤더 미수신이면 0 반환.
   */
  progress(): number {
    if (this.meta === null || this.meta.totalBlocks === 0) return 0;
    return Math.min(1, this.resolvedCount / this.meta.totalBlocks);
  }

  /**
   * 복원된 storedBytes 반환.
   * isComplete() == true일 때만 유효한 결과 반환.
   * CRC32 검증 실패 시 오류 발생.
   */
  getResult(): Uint8Array {
    if (!this.isComplete()) {
      throw new Error('LT 디코딩 미완료: 블록이 아직 복원되지 않음');
    }

    const meta = this.meta!;
    const totalBytes = meta.storedSize;
    const result = new Uint8Array(totalBytes);

    let offset = 0;
    for (let i = 0; i < meta.totalBlocks; i++) {
      const block = this.decoded[i];
      if (!block) {
        throw new Error(`블록 ${i} 복원 실패 (내부 오류)`);
      }
      const copyLen = Math.min(block.length, totalBytes - offset);
      if (copyLen <= 0) break;
      result.set(block.subarray(0, copyLen), offset);
      offset += copyLen;
    }

    // CRC32 무결성 검증
    const computedCrc = crc32(result);
    if (computedCrc !== meta.crc32) {
      throw new Error(
        `CRC32 불일치: 기대값 0x${meta.crc32.toString(16)}, ` +
        `계산값 0x${computedCrc.toString(16)} — 데이터 손상`
      );
    }

    return result;
  }

  /** 디코더 초기화 (새 전송 감지 시 또는 오류 복구 시 호출) */
  reset(): void {
    this.meta = null;
    this.decoded = [];
    this.resolvedCount = 0;
    this.pendingRaw = [];
    this.edges = [];
    this.blockEdges = [];
    this.seenSeeds = new Set();
  }
}

// ─────────────────────────────────────────────
// 내부 유틸리티
// ─────────────────────────────────────────────

/**
 * 두 Uint8Array를 바이트 단위로 XOR.
 * 결과는 새 Uint8Array로 반환 (입력 불변).
 */
function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.min(a.length, b.length);
  const result = new Uint8Array(Math.max(a.length, b.length));
  result.set(a);
  for (let i = 0; i < len; i++) {
    result[i] ^= b[i];
  }
  return result;
}
