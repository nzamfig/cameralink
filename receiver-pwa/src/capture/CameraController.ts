/**
 * 파일 목적: 카메라 스트림 획득 및 초기화
 * 책임: getUserMedia 호출, 연속 초점 설정, Wake Lock 획득으로 화면 꺼짐 방지
 * 관계: FrameLoop가 이 클래스가 설정한 video 엘리먼트를 소비
 */

export class CameraController {
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  /**
   * 후면 카메라 + 고해상도 + 연속초점으로 스트림 시작.
   * 연속초점은 일부 기기에서 applyConstraints로만 지원되므로
   * getUserMedia 후 별도 시도.
   * @param videoEl 스트림을 연결할 video 엘리먼트
   */
  async start(videoEl: HTMLVideoElement): Promise<void> {
    // 후면 카메라(environment) + 고해상도 요청
    // ideal로 지정하여 미지원 기기에서도 폴백 허용
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      }
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();

    // 연속 초점 시도: QR 인식률을 높이기 위해 필수
    // advanced 배열은 일부 기기에서만 지원하며 미지원 시 Promise reject
    try {
      const track = this.stream.getVideoTracks()[0];
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet]
      });
    } catch {
      // 연속 초점 미지원 기기: 조용히 무시하고 기본 초점 유지
    }

    // Wake Lock: 수신 중 폰 화면 꺼짐으로 인한 수신 중단 방지
    // 미지원 기기(iOS 구형 등)에서 조용히 무시
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // Wake Lock 미지원 — 수신은 계속 진행
    }
  }

  /**
   * 연속 자동초점이 수렴시킨 현재 초점 거리로 고정(manual)한다.
   * 애니메이션 QR 격자처럼 내용이 계속 바뀌는 대상을 비추면 연속 자동초점이
   * 매 프레임 다시 초점을 찾으려다 실패해 계속 흐릿한 상태가 되는 기기가 있음
   * (실기기 테스트에서 확인). 정적인 화면을 잠깐 비추게 한 뒤 이 메서드로
   * 그 순간의 초점 거리를 고정하면 이후 애니메이션 중에는 초점이 흔들리지 않는다.
   * focusDistance manual 모드 미지원 기기는 조용히 무시하고 연속초점 유지.
   */
  async lockFocus(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;

    try {
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & { focusMode?: string[]; focusDistance?: { min: number; max: number; step: number } };
      const settings = track.getSettings?.() as MediaTrackSettings & { focusDistance?: number };

      if (!capabilities?.focusMode?.includes('manual') || settings?.focusDistance === undefined) {
        return; // manual 초점 미지원 — 연속초점 유지
      }

      await track.applyConstraints({
        advanced: [{ focusMode: 'manual', focusDistance: settings.focusDistance } as MediaTrackConstraintSet]
      });
    } catch {
      // 초점 고정 실패: 조용히 무시하고 연속초점 유지
    }
  }

  /**
   * 카메라 스트림 정지 및 자원 해제.
   * Wake Lock도 함께 해제하여 배터리 소모를 줄임.
   */
  stop(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.wakeLock?.release().catch(() => {});
    this.stream = null;
    this.wakeLock = null;
  }

  /** 현재 활성 스트림 반환 (없으면 null) */
  getStream(): MediaStream | null {
    return this.stream;
  }
}
