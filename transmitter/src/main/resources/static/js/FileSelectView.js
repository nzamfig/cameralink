/**
 * @file FileSelectView.js
 * @description 화면 1: 파일 선택 UI 컴포넌트.
 * 드래그&드롭과 파일 선택 버튼을 모두 지원하며,
 * 파일 선택 시 파일명·크기·예상 전송 시간을 표시한다.
 *
 * 예상 전송 시간 계산:
 *   서버 응답 전이므로 원본 파일 크기 기준 추정:
 *   totalCells = DEFAULT_GRID^2 = 16 (최대)
 *   throughput = DEFAULT_FPS × PAYLOAD_SIZE × totalCells = 10 × 200 × 16 = 32,000 B/s
 *   estimatedSeconds = originalSize / throughput
 *   (실제 압축·격자 크기에 따라 달라지므로 "약 N초" 표시)
 *
 * 관계:
 *   main.js → FileSelectView 인스턴스 생성, onFileSelected 콜백 수신
 *   index.html → #file-select-view, #drop-zone, #file-info 등 DOM 요소
 */

"use strict";

import { DEFAULT_FPS, PAYLOAD_SIZE, DEFAULT_GRID } from './shared-protocol/index.js';

export class FileSelectView {

  /**
   * @param {HTMLElement} el #file-select-view 요소
   * @param {(file: File) => void} onFileSelected 파일 선택 완료 콜백
   */
  constructor(el, onFileSelected) {
    this.el = el;
    this.onFileSelected = onFileSelected;

    // DOM 요소 참조
    this.dropZone  = el.querySelector('#drop-zone');
    this.fileBtn   = el.querySelector('#file-btn');
    this.fileInput = el.querySelector('#file-input');
    this.fileInfo  = el.querySelector('#file-info');
    this.fileName  = el.querySelector('#file-name');
    this.fileSize  = el.querySelector('#file-size');
    this.estTime   = el.querySelector('#est-time');
    this.startBtn  = el.querySelector('#start-btn');

    this._selectedFile = null;

    this._bindEvents();
  }

  // ─────────────────────────────────────────────
  // 공개 API
  // ─────────────────────────────────────────────

  show() {
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }

  // ─────────────────────────────────────────────
  // 이벤트 바인딩
  // ─────────────────────────────────────────────

  _bindEvents() {
    // 파일 선택 버튼 클릭 → input[type=file] 트리거
    this.fileBtn.addEventListener('click', () => {
      this.fileInput.click();
    });

    // input[type=file] 변경 이벤트
    this.fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) this._handleFile(file);
    });

    // 드래그&드롭 — dragover: 기본 동작 차단 + 스타일
    this.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.dropZone.classList.add('dragover');
    });

    this.dropZone.addEventListener('dragleave', (e) => {
      // relatedTarget이 dropZone 내부면 무시 (자식 요소 경유)
      if (!this.dropZone.contains(e.relatedTarget)) {
        this.dropZone.classList.remove('dragover');
      }
    });

    this.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files?.[0];
      if (file) this._handleFile(file);
    });

    // 드롭존 클릭 → 파일 선택 (버튼 영역 제외)
    this.dropZone.addEventListener('click', (e) => {
      if (e.target !== this.fileBtn) {
        this.fileInput.click();
      }
    });

    // 전송 시작 버튼
    this.startBtn.addEventListener('click', () => {
      if (this._selectedFile) {
        this.onFileSelected(this._selectedFile);
      }
    });
  }

  // ─────────────────────────────────────────────
  // 파일 처리
  // ─────────────────────────────────────────────

  /**
   * 파일이 선택/드롭됐을 때 UI를 업데이트한다.
   * @param {File} file
   */
  _handleFile(file) {
    this._selectedFile = file;

    // 파일명 표시 (길면 말줄임표)
    this.fileName.textContent = file.name;

    // 파일 크기 표시 (사람이 읽기 좋은 형식)
    this.fileSize.textContent = formatBytes(file.size);

    // 예상 전송 시간 추정 (원본 크기 기준, 압축 미반영 보수적 추정)
    const totalCells = DEFAULT_GRID * DEFAULT_GRID; // 최대 16개 셀
    const throughputBps = DEFAULT_FPS * PAYLOAD_SIZE * totalCells; // ~32,000 B/s
    const estimatedSec = file.size / throughputBps;
    this.estTime.textContent = `예상 전송 시간: 약 ${formatDuration(estimatedSec)}`;

    // 파일 정보 영역 표시
    this.fileInfo.hidden = false;
  }
}

// ─────────────────────────────────────────────
// 유틸리티 함수
// ─────────────────────────────────────────────

/**
 * 바이트 수를 사람이 읽기 좋은 형식으로 변환한다.
 * @param {number} bytes
 * @returns {string} 예: "1.2 MB", "345 KB"
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * 초를 사람이 읽기 좋은 시간 형식으로 변환한다.
 * @param {number} seconds
 * @returns {string} 예: "3분 20초", "45초"
 */
function formatDuration(seconds) {
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}초`;
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return sec > 0 ? `${min}분 ${sec}초` : `${min}분`;
}
