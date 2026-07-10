# CameraLink — 격자 QR 광학 파일 전송

PC 화면에 **격자 QR 코드 애니메이션**을 재생하고, 스마트폰 카메라로 촬영·디코딩하여
**네트워크 연결 없이(완전 오프라인)** 파일을 전송하는 시스템입니다.

- **전송 방향**: PC → 스마트폰 (단방향, 되먹임 없음)
- **손실 대응**: LT(Luby Transform) 파운틴 코드 — 어떤 심볼을 놓쳐도 원본의 약 105~110%만 모으면 복원
- **오염 대응**: 격자 셀마다 CRC16 → 손상 셀만 폐기, 파일 전체는 CRC32로 최종 검증

## 저장소 구조

```
cameralink/
├── shared-protocol/   # 프로토콜 단일 소스 (TypeScript) — 상수·PRNG·CRC·코덱·LT 인코더/디코더
├── transmitter/       # 송신기 (Spring Boot + 정적 JS) — 파일 인코딩 API + QR 격자 재생
├── receiver-pwa/      # 수신기 (PWA, Vite) — 카메라 캡처 → QR 디코드 → LT 복원 → 저장
├── scripts/           # sync-protocol.mjs: 프로토콜 빌드 산출물을 송신기로 복사
└── .github/           # CI: 테스트 → 수신기 GitHub Pages 배포
```

### 프로토콜 단일 소스 규칙 (중요)

송신기와 수신기의 프로토콜 구현이 어긋나면 디코딩이 **조용히 전체 실패**합니다.
프로토콜 로직은 반드시 `shared-protocol/src/`에서만 수정하세요.

- **수신기**: Vite alias로 `shared-protocol` 소스를 직접 번들링 (자동 반영)
- **송신기**: 번들러가 없으므로 빌드 산출물을 복사해서 사용:

```bash
npm run sync:transmitter   # shared-protocol 빌드 → transmitter 정적 폴더로 복사
npm run check:sync         # 복사본이 최신인지 검증 (CI에서 자동 실행)
```

`transmitter/src/main/resources/static/js/shared-protocol/`은 **자동 생성 폴더**이므로 직접 수정 금지.

## 실행 방법

### 송신기 (PC)

```bash
cd transmitter
./gradlew bootRun        # Windows: .\gradlew.bat bootRun
# → http://127.0.0.1:8080 (localhost 전용 바인딩)
```

### 수신기 (스마트폰)

GitHub Pages로 배포됩니다 (main 브랜치 push 시 자동). 로컬 개발:

```bash
cd receiver-pwa
npm ci
npm run dev              # 개발 서버 (카메라는 HTTPS 또는 localhost 필요)
npm run build            # 프로덕션 빌드 → dist/
```

### 테스트

```bash
npm run test:protocol            # shared-protocol 단위 테스트 (vitest)
npm run typecheck:receiver       # 수신기 타입 검사
cd transmitter && ./gradlew test # 송신기 테스트 (JUnit)
npm test                         # 루트에서 위 검사 일괄 실행 (+ sync 검증)
```

## 데이터 파이프라인

```
원본 파일 → (이득 있을 때만) gzip → 200B 블록 분할 → LT 심볼 (seed 기반 XOR 조합)
  → QR BYTE 모드 인코딩 → 화면 격자 재생 (~10fps, 8프레임마다 헤더 삽입)
  → 폰 카메라 캡처 → QR 디코드 (경로 A: BarcodeDetector / 경로 B: jsQR+Homography)
  → 셀 CRC16 검증 → LT peeling 디코드 → 파일 CRC32 검증 → (gzip 해제) → 저장
```

## 주의 사항

- 빈 파일(0바이트)은 전송 대상이 아니며 서버가 400으로 거부합니다.
- 수신기 GitHub Pages 배포 경로는 `/cameralink/` base를 사용하므로
  저장소 이름이 바뀌면 `receiver-pwa/vite.config.ts`의 `base`를 함께 수정해야 합니다.
- 헤더 심볼의 `grid` 바이트는 현재 레이아웃과 항상 일치하도록 송신기가 프레임마다 관리합니다.
