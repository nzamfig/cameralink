/**
 * 파일 목적: 앱 진입점 및 상태 오케스트레이션
 * 책임: 뷰 전환(StartView → ReceiveView → ResultView), ReceivePipeline 생성·해제, 저장 트리거
 * 관계: StartView, ReceivePipeline, ResultView, FileSaver를 연결하는 최상위 조율자
 *
 * 상태 흐름:
 * [START] 카메라 버튼 클릭 → [RECEIVE] 파이프라인 시작 → [RESULT] 완료 또는 에러
 * [RESULT] 다시 수신 클릭 → [START]
 */

import { StartView } from './ui/StartView';
import { ResultView } from './ui/ResultView';
import { ReceivePipeline } from './pipeline/ReceivePipeline';
import { FileSaver } from './save/FileSaver';

// ─────────────────────────────────────────────
// 뷰 인스턴스 생성
// ─────────────────────────────────────────────

const startView = new StartView();
const resultView = new ResultView();
const fileSaver = new FileSaver();

// 수신된 파일 데이터 (ResultView → 저장 버튼 클릭 시 사용)
let receivedData: Uint8Array | null = null;
let receivedFilename: string = '';

// 현재 파이프라인 인스턴스 (stop()을 위해 보관)
let pipeline: ReceivePipeline | null = null;

// ─────────────────────────────────────────────
// 뷰 전환 함수
// ─────────────────────────────────────────────

/** 모든 뷰를 숨기고 지정된 뷰만 표시 */
function showView(viewId: 'start-view' | 'receive-view' | 'result-view'): void {
  document.querySelectorAll('.view').forEach(el => {
    el.classList.remove('active');
  });
  document.getElementById(viewId)!.classList.add('active');
}

// ─────────────────────────────────────────────
// 수신 뷰 엘리먼트 (정적 DOM — 뷰 전환은 CSS로만, 재생성되지 않음)
// ─────────────────────────────────────────────

const videoEl = document.getElementById('camera-video') as HTMLVideoElement;
const overlayCanvas = document.getElementById('overlay-canvas') as HTMLCanvasElement;

// 화면 탭 → 그 위치를 기준으로 초점 맞춤.
// video는 object-fit:cover이므로 표시 영역과 실제 프레임 사이에 확대/크롭이 있어
// 탭 좌표를 비디오 원본 해상도 기준 정규화 좌표(0~1)로 환산해야 한다.
// videoEl은 재생성되지 않는 정적 엘리먼트이므로 리스너도 한 번만 등록한다
// (onCameraClick 콜백 안에 두면 다시 수신할 때마다 중복 등록됨).
videoEl.addEventListener('click', (evt) => {
  if (!pipeline) return;
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (vw === 0 || vh === 0) return;

  const rect = videoEl.getBoundingClientRect();
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const cropX = (vw * scale - rect.width) / 2;
  const cropY = (vh * scale - rect.height) / 2;

  const nx = ((evt.clientX - rect.left) + cropX) / (vw * scale);
  const ny = ((evt.clientY - rect.top) + cropY) / (vh * scale);

  pipeline.focusAt(Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny)));
});

// ─────────────────────────────────────────────
// 시작 뷰 초기화
// ─────────────────────────────────────────────

startView.show();

startView.onCameraClick(async () => {
  // 카메라 시작: StartView → ReceiveView 전환
  showView('receive-view');

  // 오버레이 캔버스 크기를 화면에 맞춤
  overlayCanvas.width = window.innerWidth;
  overlayCanvas.height = window.innerHeight;

  pipeline = new ReceivePipeline(videoEl, overlayCanvas, {
    // ProgressView·AimOverlay 갱신은 pipeline 내부의 emitProgress/emitHint가 수행.
    // 이 콜백은 상위 레벨 확장 지점(로깅 등)으로만 남겨둔다.
    onProgress: () => {},
    onHint: () => {},
    onComplete: async (data, filename) => {
      // 수신 완료: 데이터 보관 후 ResultView 표시
      receivedData = data;
      receivedFilename = filename;

      showView('result-view');
      resultView.show(filename);
      await resultView.notifyCompletion();
    },
    onError: (err) => {
      // 에러 발생: StartView로 복귀하여 에러 표시
      console.error('[CameraLink] 파이프라인 오류:', err);
      showView('start-view');
      startView.show();
      startView.showError(`오류: ${err.message}`);
      pipeline = null;
    },
  });

  try {
    await pipeline.start();
  } catch (err) {
    // 카메라 권한 거부 등 초기화 실패
    showView('start-view');
    startView.show();
    startView.showError(
      err instanceof Error
        ? `카메라를 열 수 없습니다: ${err.message}`
        : '카메라를 열 수 없습니다'
    );
    pipeline = null;
  }
});

// ─────────────────────────────────────────────
// 결과 뷰 초기화
// ─────────────────────────────────────────────

resultView.onSaveClick(async () => {
  // 저장 버튼: 반드시 사용자 탭 제스처(click 이벤트) 내에서 호출
  if (!receivedData) return;

  try {
    await fileSaver.save(receivedData, receivedFilename);
  } catch (err) {
    console.error('[CameraLink] 저장 실패:', err);
    alert(`저장에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
});

resultView.onRestartClick(() => {
  // 다시 수신: 데이터 초기화 후 StartView로 복귀
  receivedData = null;
  receivedFilename = '';
  pipeline?.stop();
  pipeline = null;
  resultView.hide();
  showView('start-view');
  startView.show();
});

// ─────────────────────────────────────────────
// Service Worker 등록 (PWA 오프라인 지원)
// ─────────────────────────────────────────────

// vite-plugin-pwa가 빌드 시 sw.js를 자동 생성하고 registerType:'autoUpdate'로 등록함.
// 개발 모드에서는 SW가 없어 registerServiceWorker가 존재하지 않을 수 있으므로 조건 확인.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // vite-plugin-pwa의 virtual:pwa-register 모듈이 자동 처리
    // 별도 등록 코드 불필요
  });
}
