/**
 * @file node-fallback.d.ts
 * @description gzip.ts의 Node.js 폴백 경로에서 동적 import하는 node 내장 모듈의 최소 타입 선언.
 * @types/node 전체를 의존성으로 추가하지 않기 위해 실제로 사용하는 시그니처만 선언한다.
 * (이 모듈들은 vitest 등 Node 테스트 환경에서만 로드되며 브라우저 번들에는 포함되지 않는다)
 */

declare module 'node:zlib' {
  export function gzip(
    data: Uint8Array,
    callback: (err: Error | null, result: Uint8Array) => void
  ): void;
  export function gunzip(
    data: Uint8Array,
    callback: (err: Error | null, result: Uint8Array) => void
  ): void;
}

declare module 'node:util' {
  export function promisify(
    fn: (data: Uint8Array, callback: (err: Error | null, result: Uint8Array) => void) => void
  ): (data: Uint8Array) => Promise<Uint8Array>;
}
