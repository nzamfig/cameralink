/**
 * 파일 목적: 전체 수신 파이프라인 조율
 * 책임: 카메라 → 프레임 → QR 디코드 → LT 디코더 → 완료 알림.
 *        경로 A(BarcodeDetector, Chrome/Android)와 경로 B(jsQR, iOS Safari)를 자동 선택.
 * 관계: CameraController, FrameLoop, BarcodeDetectorDecoder/QrDecoder,
 *        LtDecoder, GridLock, CellExtractor, FiducialDetector, AimOverlay, ProgressView를 연결
 *
 * 경로 A (BarcodeDetector):
 * 네이티브 API가 전체 프레임에서 다중 QR을 한 번에 검출.
 * fiducial / 격자 크롭 불필요. Chrome 83+, Android에서 사용 가능.
 *
 * 경로 B (jsQR):
 * iOS Safari에서 BarcodeDetector 미지원 시 사용.
 * FiducialDetector로 마커 검출 → Homography로 원근보정 → CellExtractor로 셀 크롭
 * → QrDecoder(Worker)로 각 셀 디코딩.
 * GridLock으로 격자 크기를 동적으로 결정.
 */

import { LtDecoder } from 'shared-protocol/lt-decoder';
import { decodeSymbol } from 'shared-protocol/codec';
import { gzipDecompress } from 'shared-protocol/gzip';
import { SYMBOL_TYPE_HEADER, SYMBOL_TYPE_DATA } from 'shared-protocol/constants';

import { CameraController } from '../capture/CameraController';
import { FrameLoop } from '../capture/FrameLoop';
import { BarcodeDetectorDecoder } from '../decode/BarcodeDetectorDecoder';
import { QrDecoder } from '../decode/QrDecoder';
import { GridLock } from '../decode/GridLock';
import { FiducialDetector } from '../vision/FiducialDetector';
import { computeHomography, identityHomography } from '../vision/Homography';
import { CellExtractor } from '../vision/CellExtractor';
import { AimOverlay } from '../ui/AimOverlay';
import { ProgressView } from '../ui/ProgressView';

/** 파이프라인 이벤트 콜백 */
export type PipelineCallbacks = {
  /** 수신 진행률 갱신 (0~1) */
  onProgress: (ratio: number) => void;
  /** 조준 힌트 메시지 갱신 */
  onHint: (msg: string) => void;
  /** 수신 완료: 복원된 파일 데이터와 파일명 전달 */
  onComplete: (data: Uint8Array, filename: string) => void;
  /** 에러 발생 */
  onError: (err: Error) => void;
};

export class ReceivePipeline {
  private camera = new CameraController();
  private frameLoop: FrameLoop | null = null;
  private ltDecoder = new LtDecoder();
  private barcodeDecoder: BarcodeDetectorDecoder | null = null;
  private qrDecoder: QrDecoder | null = null;
  private gridLock = new GridLock();
  private fiducialDetector = new FiducialDetector();
  private cellExtractor = new CellExtractor();
  private overlay: AimOverlay;
  private progress: ProgressView;
  private offscreenCanvas: OffscreenCanvas;
  private completed = false;

  // 격자 성공 마스크: [row][col] = 해당 셀에서 심볼이 수신됐는지
  private successMask: boolean[][] = [];

  constructor(
    private videoEl: HTMLVideoElement,
    private overlayCanvas: HTMLCanvasElement,
    private callbacks: PipelineCallbacks
  ) {
    this.overlay = new AimOverlay(overlayCanvas);
    this.progress = new ProgressView();
    // OffscreenCanvas를 미리 생성하여 FrameLoop에 전달
    this.offscreenCanvas = new OffscreenCanvas(1280, 720);
  }

  /**
   * 파이프라인 시작.
   * 카메라를 열고, 경로 A/B를 선택한 후 프레임 루프를 시작.
   */
  async start(): Promise<void> {
    this.ltDecoder.reset();
    this.completed = false;
    this.successMask = [];
    this.gridLock.unlock();

    // 오버레이 캔버스·진행률 초기화
    this.overlay.resize();
    this.progress.reset();

    try {
      // 1. 카메라 시작
      await this.camera.start(this.videoEl);

      // 1-1. 초점 고정: 연속 자동초점이 수렴할 시간을 준 뒤 그 거리로 고정.
      // QR 애니메이션처럼 내용이 계속 바뀌는 대상을 비추면 연속초점이 매 프레임
      // 다시 초점을 잡으려다 실패해 계속 흐릿해지는 기기가 있음 (실기기 확인).
      this.emitHint('초점을 맞추는 중입니다. 화면을 향해 고정해주세요');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await this.camera.lockFocus();
      this.emitHint('카메라를 QR 격자에 맞춰주세요');

      // 2. 경로 선택: BarcodeDetector 지원 여부로 A/B 결정
      if (BarcodeDetectorDecoder.isSupported()) {
        await this.startPathA();
      } else {
        await this.startPathB();
      }
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      this.stop();
    }
  }

  // ─────────────────────────────────────────────
  // 경로 A: BarcodeDetector (Chrome/Android)
  // ─────────────────────────────────────────────

  /**
   * 경로 A 초기화 및 프레임 루프 시작.
   * BarcodeDetector가 전체 프레임에서 다중 QR을 검출하므로
   * 격자 크롭/Homography 불필요.
   */
  private async startPathA(): Promise<void> {
    this.barcodeDecoder = new BarcodeDetectorDecoder();
    await this.barcodeDecoder.init();

    this.frameLoop = new FrameLoop(
      this.videoEl,
      this.offscreenCanvas,
      (imageData) => this.processFrameA(imageData)
    );
    this.frameLoop.start();
  }

  /**
   * 경로 A 프레임 처리.
   * BarcodeDetector로 전체 프레임에서 QR 검출 후 각 심볼을 LT 디코더에 투입.
   */
  private async processFrameA(imageData: ImageData): Promise<void> {
    if (this.completed || !this.barcodeDecoder) return;

    const bytesList = await this.barcodeDecoder.detect(imageData);

    for (const bytes of bytesList) {
      await this.processSymbolBytes(bytes);
      if (this.completed) return;
    }

    // 힌트: 아무것도 검출 안 되면 안내
    if (bytesList.length === 0) {
      this.emitHint('QR 코드가 화면 안에 들어오도록 맞춰주세요');
    }
  }

  // ─────────────────────────────────────────────
  // 경로 B: jsQR + GridLock + CellExtractor (iOS Safari)
  // ─────────────────────────────────────────────

  /**
   * 경로 B 초기화 및 프레임 루프 시작.
   * jsQR Worker를 생성하고 프레임 루프 시작.
   */
  private async startPathB(): Promise<void> {
    this.qrDecoder = new QrDecoder();

    this.frameLoop = new FrameLoop(
      this.videoEl,
      this.offscreenCanvas,
      (imageData) => this.processFrameB(imageData)
    );
    this.frameLoop.start();
  }

  /**
   * 경로 B 프레임 처리.
   * GridLock 상태에 따라:
   * - 미lock: 격자 크기 후보를 순차 시도
   * - lock: 해당 격자로 모든 셀 디코딩 시도
   */
  private async processFrameB(imageData: ImageData): Promise<void> {
    if (this.completed || !this.qrDecoder) return;

    // 프레임을 셀 추출기에 1회만 업로드 (셀마다 재생성 방지)
    this.cellExtractor.setFrame(imageData);

    // Homography 계산 (fiducial 검출 성공 시)
    const fiducials = this.fiducialDetector.detect(imageData);
    let homography;

    if (fiducials) {
      const [tl, tr, bl, br] = fiducials;
      // 정규화 격자 좌표 (4 모서리) ↔ fiducial 픽셀 좌표 매핑
      homography = computeHomography(
        [[0, 0], [1, 0], [0, 1], [1, 1]],
        [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], [br.x, br.y]]
      );
    } else {
      // fiducial 미검출: 전체 화면을 격자로 사용 (폴백)
      homography = identityHomography(imageData.width, imageData.height);
    }

    if (!this.gridLock.isLocked()) {
      // 격자 크기 미확정: 1×1 부터 순차 시도 (최초 셀(0,0)에서만)
      await this.bootstrapGrid(imageData, homography);
    } else {
      // 격자 크기 확정: 모든 셀 디코딩
      const grid = this.gridLock.getGrid()!;
      await this.decodeAllCells(imageData, homography, grid.cols, grid.rows);
    }
  }

  /**
   * 격자 크기 부트스트랩: 후보 격자 크기를 순차 시도.
   * 셀(0,0)에서 QR 디코딩에 성공하면 grid 바이트로 lock.
   */
  private async bootstrapGrid(
    imageData: ImageData,
    homography: ReturnType<typeof computeHomography>
  ): Promise<void> {
    const candidates = this.gridLock.getCandidates();

    for (const { cols, rows } of candidates) {
      if (!this.qrDecoder) break;

      // 셀(0,0) 크롭 시도
      const cellImage = this.cellExtractor.extractCell(
        imageData, homography, 0, 0, rows, cols
      );
      const bytes = await this.qrDecoder.decode(cellImage);

      if (bytes) {
        const symbol = decodeSymbol(bytes);
        if (symbol && (symbol.type === SYMBOL_TYPE_HEADER || symbol.type === SYMBOL_TYPE_DATA)) {
          // 성공: grid 바이트로 lock
          this.gridLock.lock(symbol.grid);
          await this.processSymbolBytes(bytes);
          this.emitHint(`${cols}×${rows} 격자 인식됨`);
          return;
        }
      }
    }

    this.emitHint('격자를 화면 중앙에 맞춰주세요');
  }

  /**
   * lock된 격자 크기로 모든 셀 디코딩.
   * 병렬 디코딩은 하지 않고 순차 처리 (Worker 과부하 방지).
   */
  private async decodeAllCells(
    imageData: ImageData,
    homography: ReturnType<typeof computeHomography>,
    cols: number,
    rows: number
  ): Promise<void> {
    // 성공 마스크 초기화 (크기 맞춤)
    if (this.successMask.length !== rows) {
      this.successMask = Array.from({ length: rows }, () => new Array(cols).fill(false));
    }

    let anySuccess = false;

    for (let r = 0; r < rows && !this.completed; r++) {
      for (let c = 0; c < cols && !this.completed; c++) {
        if (!this.qrDecoder) return;

        const cellImage = this.cellExtractor.extractCell(
          imageData, homography, r, c, rows, cols
        );
        const bytes = await this.qrDecoder.decode(cellImage);

        if (bytes) {
          const symbol = decodeSymbol(bytes);
          if (symbol) {
            // grid 바이트 변경 = 송신기 창 리사이즈로 격자만 바뀐 것.
            // 같은 전송이므로 디코더는 유지하고 격자 lock만 갱신한다.
            // (새 전송 감지는 헤더의 crc32/파일명 비교로 LtDecoder.setHeader가 수행)
            if (symbol.grid !== ((this.gridLock.getGrid()!.cols << 4) | this.gridLock.getGrid()!.rows)) {
              this.gridLock.updateGrid(symbol.grid);
              this.successMask = []; // 격자 크기가 바뀌었으므로 마스크 재생성
              await this.processSymbolBytes(bytes); // 심볼 자체는 유효하므로 적립
              return; // 현재 루프의 cols/rows가 무효화됨 → 다음 프레임부터 새 격자로
            }

            this.successMask[r][c] = true;
            anySuccess = true;
            await this.processSymbolBytes(bytes);
          }
        }
      }
    }

    if (anySuccess) {
      this.gridLock.onSuccess();
      this.overlay.drawGrid(cols, rows, this.successMask);
    } else {
      this.gridLock.onFailure();
      this.overlay.clear();
      this.emitHint('격자를 화면 안에 들어오도록 맞춰주세요');
    }
  }

  // ─────────────────────────────────────────────
  // 공통: 심볼 처리
  // ─────────────────────────────────────────────

  /**
   * 수신된 QR 바이트를 파싱하여 LT 디코더에 투입.
   * 헤더 심볼은 setHeader, 데이터 심볼은 addSymbol로 처리.
   * 완료되면 storedBytes를 재조립하고 (필요 시 gzip 해제) onComplete 호출.
   */
  private async processSymbolBytes(bytes: Uint8Array): Promise<void> {
    const symbol = decodeSymbol(bytes);
    if (!symbol) return; // CRC16 실패 or 알 수 없는 타입

    if (symbol.type === SYMBOL_TYPE_HEADER) {
      // totalBlocks=0인 헤더는 유효한 전송이 아님 (빈 파일은 송신기가 거부)
      // → 손상된 헤더일 가능성이 높으므로 폐기
      if (symbol.totalBlocks === 0) return;

      // 헤더 심볼: 파일 메타데이터 전달 및 캐시 저장
      this.cachedFilename = symbol.filename;
      this.cachedCompressed = symbol.compressed;
      this.ltDecoder.setHeader({
        filename: symbol.filename,
        originalSize: symbol.originalSize,
        storedSize: symbol.storedSize,
        compressed: symbol.compressed,
        payloadSize: symbol.payloadSize,
        totalBlocks: symbol.totalBlocks,
        crc32: symbol.crc32,
      });
      this.emitHint(`수신 중: ${symbol.filename}`);
    } else if (symbol.type === SYMBOL_TYPE_DATA) {
      // 데이터 심볼: LT 디코더에 투입 후 진행률 갱신
      const ratio = this.ltDecoder.addSymbol(bytes);
      this.emitProgress(ratio);

      // 수신 완료 확인
      if (this.ltDecoder.isComplete() && !this.completed) {
        this.completed = true;
        await this.finalize();
      }
    }
  }

  /**
   * 수신 완료 후 처리.
   * storedBytes 재조립 → CRC32 검증 → (gzip이면) 압축 해제 → onComplete 호출.
   */
  private async finalize(): Promise<void> {
    try {
      // LtDecoder.getResult()가 내부적으로 CRC32 검증 수행 (불일치 시 throw)
      let data = this.ltDecoder.getResult();

      // 헤더의 compressed 플래그 확인 (LtDecoder 내부 meta에서 가져옴)
      // getResult()가 storedBytes를 반환하므로, 압축 여부를 파악하기 위해
      // 헤더에서 가져온 meta를 직접 참조할 수 없음.
      // 대신: storedSize vs originalSize 비교로 압축 여부 추론 가능하나
      // 명시적 flags가 더 정확하므로 LtDecoder에 meta getter 추가가 이상적.
      // 현재 구현에서는 addSymbol 반환 후 isComplete() 시 header의 compressed 필드 참조 필요.
      // 임시 해결: lt-decoder의 meta를 직접 접근하는 대신 getResult 전에 헤더 파싱을 별도 보관.
      const filename = this.cachedFilename ?? 'received_file';
      const compressed = this.cachedCompressed ?? false;

      if (compressed) {
        data = await gzipDecompress(data);
      }

      this.stop();
      this.emitProgress(1);
      this.callbacks.onComplete(data, filename);
    } catch (err) {
      this.completed = false; // 재시도 허용
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // 헤더에서 파싱한 메타 캐시 (finalize에서 참조용)
  private cachedFilename: string | null = null;
  private cachedCompressed: boolean | null = null;

  // ─────────────────────────────────────────────
  // UI 갱신 + 콜백 통지 (단일 경로)
  // ─────────────────────────────────────────────

  /** 진행률 바 갱신 후 외부 콜백 통지 */
  private emitProgress(ratio: number): void {
    this.progress.update(ratio);
    this.callbacks.onProgress(ratio);
  }

  /** 조준 힌트 갱신 후 외부 콜백 통지 */
  private emitHint(msg: string): void {
    this.overlay.setHint(msg);
    this.callbacks.onHint(msg);
  }

  /** 파이프라인 정지 및 자원 해제 */
  stop(): void {
    this.frameLoop?.stop();
    this.frameLoop = null;
    this.camera.stop();
    this.qrDecoder?.terminate();
    this.qrDecoder = null;
    this.barcodeDecoder = null;
    this.overlay.clear();
  }
}
