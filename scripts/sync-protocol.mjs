/**
 * @file sync-protocol.mjs
 * @description shared-protocol 빌드 산출물(dist/*.js)을 송신기 정적 리소스로 복사한다.
 *
 * 왜 필요한가:
 *   송신기 프론트엔드는 번들러 없이 Spring Boot 정적 리소스로 서빙되는 순수 ES 모듈이다.
 *   프로토콜 로직을 손으로 복제하면 수신기(shared-protocol 직접 참조)와 드리프트가 발생해
 *   디코딩이 조용히 전체 실패하므로, 반드시 이 스크립트로만 동기화한다.
 *
 * 사용법:
 *   node scripts/sync-protocol.mjs          # dist → transmitter 정적 폴더로 복사
 *   node scripts/sync-protocol.mjs --check  # 복사본이 최신인지 검증 (CI용, 불일치 시 exit 1)
 *
 * 전제: shared-protocol이 먼저 빌드되어 있어야 한다 (npm run build:protocol).
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'shared-protocol', 'dist');
const destDir = join(root, 'transmitter', 'src', 'main', 'resources', 'static', 'js', 'shared-protocol');

const checkMode = process.argv.includes('--check');

if (!existsSync(srcDir)) {
  console.error(`[sync-protocol] 빌드 산출물이 없습니다: ${srcDir}`);
  console.error('먼저 "npm run build:protocol"을 실행하세요.');
  process.exit(1);
}

// 브라우저 런타임에 필요한 .js만 복사 (.d.ts는 제외)
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js'));

if (files.length === 0) {
  console.error('[sync-protocol] dist에 .js 파일이 없습니다.');
  process.exit(1);
}

if (checkMode) {
  let dirty = false;
  for (const f of files) {
    const srcContent = readFileSync(join(srcDir, f), 'utf-8');
    const destPath = join(destDir, f);
    if (!existsSync(destPath) || readFileSync(destPath, 'utf-8') !== srcContent) {
      console.error(`[sync-protocol] 불일치: ${f}`);
      dirty = true;
    }
  }
  // 복사본에만 있는 잔여 파일(구버전 흔적)도 실패 처리
  if (existsSync(destDir)) {
    for (const f of readdirSync(destDir).filter((f) => f.endsWith('.js'))) {
      if (!files.includes(f)) {
        console.error(`[sync-protocol] 잔여 파일: ${f}`);
        dirty = true;
      }
    }
  }
  if (dirty) {
    console.error('[sync-protocol] 송신기 프로토콜 복사본이 최신이 아닙니다. "npm run sync:transmitter"를 실행하세요.');
    process.exit(1);
  }
  console.log(`[sync-protocol] OK — ${files.length}개 파일 동기화 상태 확인됨`);
} else {
  // 기존 복사본을 지우고 새로 복사 (잔여 파일 방지)
  if (existsSync(destDir)) rmSync(destDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });

  for (const f of files) {
    writeFileSync(join(destDir, f), readFileSync(join(srcDir, f)));
  }
  writeFileSync(
    join(destDir, 'README.md'),
    '# 자동 생성 폴더 — 직접 수정 금지\n\n' +
      '이 폴더는 `shared-protocol` 빌드 산출물의 복사본입니다.\n' +
      '수정은 `shared-protocol/src/`에서 하고, 루트에서 `npm run sync:transmitter`로 재생성하세요.\n'
  );
  console.log(`[sync-protocol] ${files.length}개 파일 복사 완료 → ${destDir}`);
}
