/**
 * @file main.js
 * @description 앱 진입점 — 화면 전환 및 이벤트 배선 오케스트레이터.
 *
 * 화면 흐름:
 *   [화면 1] 파일 선택 → 서버 인코딩 → [화면 2] QR 격자 전송
 *   [화면 2] 중지/ESC → [화면 1] 복귀
 *
 * 데이터 흐름:
 *   File → EncodeClient → { blocks, headerMeta } → LtEncoder + GridRenderer
 *
 * 헤더 심볼은 반응형 격자에 따라 grid 바이트가 달라지므로 여기서 미리 직렬화하지 않고,
 * 헤더 메타(파일명·크기·CRC 등)만 GridRenderer에 전달한다.
 * GridRenderer가 매 헤더 프레임마다 현재 layout.gridByte로 재인코딩한다
 * (수신기 경로 B가 헤더의 grid로 격자를 lock하므로 실제 격자와 반드시 일치해야 함).
 *
 * 관계:
 *   FileSelectView → 파일 선택 UI
 *   TransmitView   → 전송 뷰
 *   EncodeClient   → 서버 통신
 *   LtEncoder      → LT 인코딩
 *   GridRenderer   → rAF 렌더 루프
 *   LayoutManager  → 격자 레이아웃 계산
 *   PipController  → Document PiP 제어
 *   shared-protocol/ → 프로토콜 단일 소스 (sync-protocol.mjs로 자동 생성, 직접 수정 금지)
 */

"use strict";

import { FileSelectView } from './FileSelectView.js';
import { TransmitView }   from './TransmitView.js';
import { EncodeClient }   from './EncodeClient.js';
import { GridRenderer }   from './GridRenderer.js';
import { LayoutManager }  from './LayoutManager.js';
import { PipController }  from './PipController.js';
import { LtEncoder } from './shared-protocol/index.js';

// ─────────────────────────────────────────────
// DOM 요소 참조
// ─────────────────────────────────────────────

const fileSelectViewEl = document.getElementById('file-select-view');
const transmitViewEl   = document.getElementById('transmit-view');
const canvas           = document.getElementById('qr-canvas');
const pipBtn           = document.getElementById('pip-btn');
const stopBtn          = document.getElementById('stop-btn');
const hintEl           = document.getElementById('visibility-hint');

// ─────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────

let currentRenderer = null; // 현재 실행 중인 GridRenderer
let currentPip      = null; // 현재 PiP 컨트롤러
let encodeClient    = null; // EncodeClient 인스턴스 (재사용)

// ─────────────────────────────────────────────
// 컴포넌트 초기화
// ─────────────────────────────────────────────

/** 화면 1: 파일 선택 뷰 */
const fileSelectView = new FileSelectView(fileSelectViewEl, onFileSelected);

/** 화면 2: 전송 뷰 — transmitViewEl을 직접 전달하여 show/hide 제어 */
const transmitView = new TransmitView(transmitViewEl, canvas, pipBtn, stopBtn, hintEl, onStop);

// ─────────────────────────────────────────────
// 화면 1 → 화면 2: 파일 선택 후 전송 시작
// ─────────────────────────────────────────────

/**
 * 파일이 선택됐을 때 호출된다.
 * 서버에 업로드하여 인코딩 데이터를 받은 후 전송 뷰를 시작한다.
 *
 * @param {File} file
 */
async function onFileSelected(file) {
  // 버튼을 로딩 상태로 변경
  const startBtn = fileSelectViewEl.querySelector('#start-btn');
  const originalText = startBtn.textContent;
  startBtn.textContent = '서버 인코딩 중...';
  startBtn.disabled = true;

  try {
    // ── 1. 서버에 파일 업로드 및 인코딩 ──────────────────────────────────
    encodeClient = encodeClient || new EncodeClient();
    const encodeData = await encodeClient.encode(file);

    // ── 2. LT 인코더 초기화 ──────────────────────────────────────────────
    const encoder = new LtEncoder(encodeData.blocks, encodeData.totalBlocks);

    // ── 3. 헤더 메타 구성 ────────────────────────────────────────────────
    // grid 바이트는 프레임마다 달라질 수 있으므로 여기서 직렬화하지 않고
    // GridRenderer가 현재 레이아웃의 gridByte로 매번 인코딩한다.
    // crc32는 서버에서 16진수 문자열로 반환 → 정수로 변환
    // payloadSize는 반드시 서버가 실제로 블록을 분할한 값(encodeData.payloadSize)을 그대로 써야 한다.
    // 프론트엔드 shared-protocol의 PAYLOAD_SIZE 상수를 따로 쓰면, 서버(Java, 수동 복제값)와
    // 값이 어긋날 때 헤더가 광고하는 payloadSize와 실제 심볼 payload 길이가 달라져
    // 수신기 LtDecoder가 전부 실패한다.
    const headerMeta = {
      flags:        encodeData.compressed ? 0x01 : 0x00,  // bit0 = gzip 여부
      filename:     encodeData.filename,
      originalSize: encodeData.originalSize,
      storedSize:   encodeData.storedSize,
      payloadSize:  encodeData.payloadSize,
      totalBlocks:  encodeData.totalBlocks,
      crc32:        parseInt(encodeData.crc32, 16),
    };

    // ── 4. 레이아웃 매니저 + GridRenderer 초기화 ─────────────────────────
    const layoutManager = new LayoutManager(canvas);
    const renderer = new GridRenderer(canvas, layoutManager, encoder, headerMeta);
    currentRenderer = renderer;

    // ── 5. PiP 컨트롤러 초기화 ───────────────────────────────────────────
    const pipController = new PipController(canvas, renderer, pipBtn);
    currentPip = pipController;

    // PiP 버튼 이벤트 연결
    pipBtn.onclick = async () => {
      await pipController.toggle();
    };

    // PiP 미지원 브라우저: 버튼 비활성화
    if (!pipController.isSupported()) {
      pipBtn.disabled = true;
      pipBtn.title = '이 브라우저는 Document PiP를 지원하지 않습니다 (Chrome 116+ 필요)';
    } else {
      pipBtn.disabled = false;
      pipBtn.title = '';
    }

    // ── 6. 화면 전환: 파일 선택 → 전송 뷰 ──────────────────────────────
    fileSelectView.hide();
    transmitView.show();

    // ── 7. 렌더 루프 시작 ────────────────────────────────────────────────
    await renderer.start();

  } catch (e) {
    // 오류 처리: 사용자에게 메시지 표시
    console.error('[main] 파일 인코딩 실패:', e);
    alert(`파일 처리 중 오류가 발생했습니다:\n${e.message}`);

    // 버튼 복원
    startBtn.textContent = originalText;
    startBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// 화면 2 → 화면 1: 중지 처리
// ─────────────────────────────────────────────

/**
 * 중지 버튼 또는 ESC 키로 전송을 종료하고 파일 선택 화면으로 복귀한다.
 */
function onStop() {
  // PiP 종료
  if (currentPip) {
    currentPip.exit();
    currentPip = null;
  }

  // 렌더 루프 중지
  if (currentRenderer) {
    currentRenderer.stop();
    currentRenderer = null;
  }

  // 화면 전환: 전송 뷰 → 파일 선택
  transmitView.hide();
  fileSelectView.show();

  // 파일 선택 버튼 복원 (disabled 상태 해제)
  const startBtn = fileSelectViewEl.querySelector('#start-btn');
  if (startBtn) {
    startBtn.textContent = '전송 시작';
    startBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────
// 정지 버튼 이벤트 연결
// ─────────────────────────────────────────────

stopBtn.addEventListener('click', onStop);

// ─────────────────────────────────────────────
// 초기 화면: 파일 선택 표시
// ─────────────────────────────────────────────

fileSelectView.show();
transmitView.hide();
