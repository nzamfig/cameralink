/**
 * 파일 목적: 수신 완료된 파일 저장
 * 책임: 플랫폼별 최적 저장 방법 선택
 *        - 데스크톱 Chrome: File System Access API 우선
 *        - 모바일 우선: Web Share (파일 공유)
 *        - 최종 폴백: <a download> 링크 클릭
 * 관계: ResultView의 "저장" 버튼 탭 제스처 핸들러에서 호출됨
 *
 * 비제스처 자동 저장이 불가한 이유:
 * 모바일 브라우저(iOS Safari 등)는 파일 다운로드·공유를
 * 사용자 탭 제스처(click 이벤트 핸들러 내부)가 있는 경우에만 허용함.
 * 따라서 완료 즉시 자동 저장이 아니라, "저장" 버튼 클릭 이벤트에서 실행해야 함.
 */

export class FileSaver {
  /**
   * 파일 저장.
   * 반드시 사용자 탭 제스처 핸들러(click 이벤트) 내에서 호출할 것.
   * @param data 저장할 바이트 데이터
   * @param filename 저장 파일명
   */
  async save(data: Uint8Array, filename: string): Promise<void> {
    // Blob 생성 — SharedArrayBuffer 기반 뷰는 사용하지 않으므로 ArrayBuffer 뷰로 단언
    const blob = new Blob([data as Uint8Array<ArrayBuffer>]);

    // 1순위: 데스크톱 Chrome — File System Access API (사용자가 저장 위치 직접 선택)
    if ('showSaveFilePicker' in window && !this.isMobile()) {
      try {
        const handle = await (window as unknown as {
          showSaveFilePicker(opts: { suggestedName: string }): Promise<FileSystemFileHandle>;
        }).showSaveFilePicker({ suggestedName: filename });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e: unknown) {
        // AbortError: 사용자가 취소 → 폴백으로 진행
        // 다른 오류는 재throw
        if (e instanceof Error && e.name !== 'AbortError') throw e;
      }
    }

    // 2순위: 모바일 우선 — Web Share API (iOS 사진첩 등 시스템 공유 시트)
    // canShare({files})로 파일 공유 지원 여부 확인
    const shareFile = new File([blob], filename);
    if (navigator.canShare?.({ files: [shareFile] })) {
      await navigator.share({
        files: [shareFile],
        title: filename,
      });
      return;
    }

    // 3순위 (최종 폴백): <a download> — 모든 브라우저에서 동작하나 저장 위치 선택 불가
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // click()은 사용자 제스처 맥락 내에서 호출됨을 브라우저가 인식
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // URL 객체는 1초 후 해제 (click 완료 후 안전하게 해제)
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * 모바일 기기 여부 판별.
   * Web Share를 우선해야 하는 환경 구분용.
   * @returns Android/iPhone/iPad이면 true
   */
  private isMobile(): boolean {
    return /Android|iPhone|iPad/i.test(navigator.userAgent);
  }
}
