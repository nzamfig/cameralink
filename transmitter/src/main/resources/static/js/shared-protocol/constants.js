/**
 * @file constants.ts
 * @description 격자 QR 광학 파일 전송 시스템의 프로토콜 상수 정의.
 * 송신기(Spring Boot)와 수신기(PWA) 양쪽에서 동일하게 참조하며,
 * 이 값들이 달라지면 QR 용량 초과·디코딩 실패·프레임 비동기 등 문제 발생.
 * 변경 시 반드시 양쪽 모두 동시 배포해야 한다.
 */
// PAYLOAD_SIZE = 200: QR 버전10(ECC=M) 최대 용량 ~213바이트에서 심볼 헤더(8바이트) 여유분을 뺀 값
export const PAYLOAD_SIZE = 200;
// QR_ECC_LEVEL = 'M': 카메라 광학 채널은 오염·블러·글레어가 빈번하므로 중간 수준 오류정정 사용
// L=7%, M=15%, Q=25%, H=30% 복원 가능. H로 올리면 용량이 절반 이하로 감소
export const QR_ECC_LEVEL = 'M';
// QUIET_ZONE = 4: QR 규격 필수 여백(모듈 단위). 생략 시 이웃 QR의 패턴이 서로 간섭해 디코딩 실패
export const QUIET_ZONE = 4;
// DEFAULT_GRID = 4: 4×4 격자. 창 크기에 따라 이 값 이하로 자동 축소
export const DEFAULT_GRID = 4;
// MIN_CELL_PX = 200: 셀 최소 렌더 크기(px). 이보다 작으면 모듈당 카메라 픽셀 부족
// QR 버전10은 57x57 모듈 → 200px / 57 ≈ 3.5px/모듈 (최소 허용 수준)
export const MIN_CELL_PX = 200;
// DEFAULT_FPS = 10: 폰 디코드 속도에 맞춘 재생 속도. 빠를수록 손실 증가
// 10fps → 프레임당 100ms. 폰 카메라 1/30s 셔터에서 잔상 없이 캡처 가능한 상한
export const DEFAULT_FPS = 10;
// MAGIC = 0x51: 프레임 식별용 매직바이트 ('Q' = QR의 첫 글자)
// 수신기가 QR 내용 앞부분을 보고 이 시스템의 심볼인지 빠르게 구분
export const MAGIC = 0x51;
// HEADER_INTERVAL = 8: 매 8프레임마다 헤더 심볼 삽입
// 폰이 언제 스캔 시작해도 최대 8프레임(= 0.8초 @ 10fps) 내 헤더 수신 보장
export const HEADER_INTERVAL = 8;
// FILENAME_MAX_BYTES = 100: 헤더 셀 QR 용량(~200B) 초과 방지
// 헤더 고정 필드(18바이트) + 파일명 100바이트 = 118바이트로 200바이트 이내 유지
// 초과 시 확장자 보존하며 앞부분 절단
export const FILENAME_MAX_BYTES = 100;
// SYMBOL_TYPE_HEADER = 0x01: 헤더 심볼 타입 식별자
// 파일명·크기·블록 수·CRC32 등 메타데이터 전달
export const SYMBOL_TYPE_HEADER = 0x01;
// SYMBOL_TYPE_DATA = 0x02: 데이터 심볼 타입 식별자
// LT 코드로 XOR 결합된 실제 파일 데이터 전달
export const SYMBOL_TYPE_DATA = 0x02;
