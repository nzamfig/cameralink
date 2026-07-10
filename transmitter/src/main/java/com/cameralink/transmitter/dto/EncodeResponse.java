/**
 * @file EncodeResponse.java
 * @description 파일 인코딩 결과 DTO.
 * FileEncoderService가 생성하고 EncodeController가 JSON으로 직렬화하여 반환한다.
 *
 * 핵심 설계 결정:
 *   - 블록 배열 대신 storedData(Base64 단일 문자열)로 전송 → JSON 크기 대폭 절감
 *   - 클라이언트(JS)가 payloadSize(200B) 단위로 직접 분할
 *   - crc32: 16진수 문자열 (Java long 범위 이슈 회피 + 가독성)
 *
 * 관계:
 *   FileEncoderService → EncodeResponse 생성
 *   EncodeController   → ResponseEntity<EncodeResponse> 반환
 *   JS EncodeClient    → storedData 디코딩 후 payloadSize 단위로 분할
 */
package com.cameralink.transmitter.dto;

public class EncodeResponse {

    /** 원본 파일명 (sanitize 처리 후, UTF-8 100바이트 이하) */
    private String filename;

    /** 원본 파일 크기(바이트) */
    private long originalSize;

    /** 저장 크기: 압축 적용 시 gzip 크기, 미적용 시 원본 크기 */
    private long storedSize;

    /** gzip 압축 적용 여부 (압축 후가 원본보다 작을 때만 true) */
    private boolean compressed;

    /** 각 LT 심볼 페이로드 크기(바이트) — 항상 PAYLOAD_SIZE(200) */
    private int payloadSize;

    /** 총 소스 블록 수 = ceil(storedSize / payloadSize) */
    private int totalBlocks;

    /** storedBytes 전체의 CRC32 값 (16진수 문자열, 예: "1A2B3C4D") */
    private String crc32;

    /**
     * storedBytes 전체를 Base64 인코딩한 단일 문자열.
     * 클라이언트가 Base64 디코딩 후 payloadSize 단위로 분할하여 LT 인코더에 전달.
     * 마지막 블록은 서버가 이미 0으로 패딩했으므로 클라이언트는 단순 분할만 수행.
     */
    private String storedData;

    // ─────────────────────────────────────────────
    // 기본 생성자 (Jackson 역직렬화용)
    // ─────────────────────────────────────────────

    public EncodeResponse() {}

    // ─────────────────────────────────────────────
    // Getter / Setter (Lombok 미사용 — 표준 방식)
    // ─────────────────────────────────────────────

    public String getFilename() {
        return filename;
    }

    public void setFilename(String filename) {
        this.filename = filename;
    }

    public long getOriginalSize() {
        return originalSize;
    }

    public void setOriginalSize(long originalSize) {
        this.originalSize = originalSize;
    }

    public long getStoredSize() {
        return storedSize;
    }

    public void setStoredSize(long storedSize) {
        this.storedSize = storedSize;
    }

    public boolean isCompressed() {
        return compressed;
    }

    public void setCompressed(boolean compressed) {
        this.compressed = compressed;
    }

    public int getPayloadSize() {
        return payloadSize;
    }

    public void setPayloadSize(int payloadSize) {
        this.payloadSize = payloadSize;
    }

    public int getTotalBlocks() {
        return totalBlocks;
    }

    public void setTotalBlocks(int totalBlocks) {
        this.totalBlocks = totalBlocks;
    }

    public String getCrc32() {
        return crc32;
    }

    public void setCrc32(String crc32) {
        this.crc32 = crc32;
    }

    public String getStoredData() {
        return storedData;
    }

    public void setStoredData(String storedData) {
        this.storedData = storedData;
    }
}
