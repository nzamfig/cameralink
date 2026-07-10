/**
 * @file qr-safe.ts
 * @description QR BYTE 모드 채널을 위한 ASCII-safe 인코딩 (Base64).
 *
 * 왜 필요한가:
 *   Android Chrome의 BarcodeDetector(경로 A)는 QR의 rawValue를 문자열로 반환하는데,
 *   내부적으로 UTF-8로 디코딩하는 것으로 보인다. LT 심볼 페이로드는 사실상 임의
 *   바이트이므로 0x80 이상 바이트가 섞이면 브라우저 네이티브 레이어에서 이미 원본이
 *   손상되어 JS에서 복구가 불가능하다 (CRC16이 항상 실패 → 수신 진행률 0% 고정).
 *   Base64(ASCII 0~127)로 인코딩하면 UTF-8/Latin-1 어느 쪽으로 해석되어도 바이트가
 *   그대로 보존되므로 경로 A/B 모두 안전해진다.
 *
 * 적용 지점 (반드시 QR 입출력 경계에서만 사용 — LT/코덱 계층은 원본 바이트 그대로 유지):
 *   송신기 QrRenderer  → QR 생성 직전 toAsciiSafe()
 *   수신기 두 경로 모두 → decodeSymbol() 호출 전 fromAsciiSafe()
 *
 * btoa/atob(Base64 문자열 코덱)는 브라우저 메인 스레드, Worker, Node.js(18+) 전부에서
 * 전역으로 제공되므로 별도 환경 분기 없이 그대로 사용한다.
 */
/** Uint8Array → btoa가 요구하는 "binary string"(문자 코드 0~255) 변환 */
function bytesToBinaryString(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++)
        s += String.fromCharCode(bytes[i]);
    return s;
}
/** binary string(문자 코드 0~255) → Uint8Array 변환 */
function binaryStringToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++)
        out[i] = s.charCodeAt(i);
    return out;
}
/**
 * 임의 바이트를 Base64 ASCII 바이트로 인코딩한다.
 * 결과는 전부 0~127 범위이므로 어떤 텍스트 인코딩을 거쳐도 손상되지 않는다.
 * @param data 원본 바이트
 * @returns Base64 문자만으로 구성된 ASCII 바이트
 */
export function toAsciiSafe(data) {
    const b64 = btoa(bytesToBinaryString(data));
    return binaryStringToBytes(b64);
}
/**
 * toAsciiSafe()로 인코딩된 바이트를 원본 바이트로 복원한다.
 * @param data QR에서 읽은 Base64 ASCII 바이트
 * @returns 원본 바이트, 형식이 잘못된 경우 null (호출측은 손상된 QR 읽기와 동일하게 폐기)
 */
export function fromAsciiSafe(data) {
    try {
        const binary = atob(bytesToBinaryString(data));
        return binaryStringToBytes(binary);
    }
    catch {
        return null;
    }
}
