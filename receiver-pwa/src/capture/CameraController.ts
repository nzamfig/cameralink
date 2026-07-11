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
   * 사용자가 탭한 지점(정규화 좌표 0~1, 좌상단 원점)을 기준으로 초점을 맞춘다.
   * pointsOfInterest로 초점 영역을 지정하고 초점을 재시도시킨 뒤,
   * 수렴할 시간을 준 다음 그 순간의 거리로 manual 고정한다.
   * 애니메이션 QR 격자처럼 내용이 계속 바뀌는 대상을 연속초점으로 비추면
   * 매 프레임 다시 초점을 찾으려다 실패해 계속 흐릿한 상태가 되는 기기가 있음
   * (실기기 테스트에서 확인) — 그래서 탭한 순간의 초점을 고정해 유지한다.
   * pointsOfInterest·manual 초점 미지원 기기에서는 조용히 무시하고 연속초점 유지.
   */
  async focusAt(nx: number, ny: number): Promise<string> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return '트랙 없음';

    const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & {
      focusMode?: string[];
      pointsOfInterest?: unknown;
    };

    // 진단용: 이 기기의 브라우저가 실제로 무엇을 지원하는지 그대로 보고한다.
    // 초점 제어(pointsOfInterest·manual focusMode)는 표준에 있어도 실기기/브라우저
    // 지원이 매우 들쭉날쭉해서, 조용히 무시하는 대신 무엇이 없어서 안 되는지 알아야 한다.
    const report = `focusMode=${JSON.stringify(capabilities?.focusMode ?? null)} poi=${!!capabilities?.pointsOfInterest}`;

    try {
      const advanced: MediaTrackConstraintSet[] = [];
      if (capabilities?.pointsOfInterest) {
        advanced.push({ pointsOfInterest: [{ x: nx, y: ny }] } as MediaTrackConstraintSet);
      }
      if (capabilities?.focusMode?.includes('single-shot')) {
        advanced.push({ focusMode: 'single-shot' } as MediaTrackConstraintSet);
      } else if (capabilities?.focusMode?.includes('continuous')) {
        advanced.push({ focusMode: 'continuous' } as MediaTrackConstraintSet);
      }
      if (advanced.length === 0) return `미지원 (${report})`;

      await track.applyConstraints({ advanced });

      // 탭한 지점에 초점이 수렴할 시간을 줌
      await new Promise((resolve) => setTimeout(resolve, 800));

      // 그 순간의 초점 거리로 고정 (manual 미지원 기기는 조용히 무시하고 연속초점 유지)
      const settings = track.getSettings?.() as MediaTrackSettings & { focusDistance?: number };
      if (capabilities?.focusMode?.includes('manual') && settings?.focusDistance !== undefined) {
        await track.applyConstraints({
          advanced: [{ focusMode: 'manual', focusDistance: settings.focusDistance } as MediaTrackConstraintSet]
        });
        return `고정됨 d=${settings.focusDistance} (${report})`;
      }
      return `manual 미지원, 연속초점 유지 (${report})`;
    } catch (err) {
      return `실패: ${err instanceof Error ? err.message : String(err)} (${report})`;
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
