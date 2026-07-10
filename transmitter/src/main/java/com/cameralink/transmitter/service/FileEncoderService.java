/**
 * @file FileEncoderService.java
 * @description 파일 인코딩 핵심 서비스.
 * MultipartFile을 수신하여 gzip 압축 → CRC32 계산 → 블록 분할 후
 * EncodeResponse를 생성한다. QR 렌더링이나 LT 인코딩은 클라이언트(JS)가 수행.
 *
 * 처리 흐름:
 *   1. 파일명 sanitize (경로 문자 제거, UTF-8 100바이트 절단 — 확장자 보존)
 *   2. 원본 바이트 읽기
 *   3. gzip 압축 시도 → 압축 결과가 원본보다 작으면 사용, 아니면 원본 사용
 *   4. CRC32(storedBytes) 계산
 *   5. totalBlocks = ceil(storedBytes.length / PAYLOAD_SIZE)
 *   6. 마지막 블록 0 패딩 → storedBytes 전체를 Base64 인코딩
 *   7. EncodeResponse 반환
 *
 * 관계:
 *   EncodeController → FileEncoderService.encode() 호출
 *   EncodeResponse   → 반환값
 */
package com.cameralink.transmitter.service;

import com.cameralink.transmitter.dto.EncodeResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.CRC32;
import java.util.zip.GZIPOutputStream;

@Service
public class FileEncoderService {

    private static final Logger log = LoggerFactory.getLogger(FileEncoderService.class);

    /** 각 LT 심볼의 페이로드 크기(바이트) — shared-protocol의 PAYLOAD_SIZE와 동일 */
    private static final int PAYLOAD_SIZE = 200;

    /** 파일명 최대 UTF-8 바이트 수 — 헤더 심볼 QR 용량 초과 방지 */
    private static final int FILENAME_MAX_BYTES = 100;

    /**
     * MultipartFile을 인코딩하여 EncodeResponse를 반환한다.
     *
     * @param file 업로드된 파일 (비어있으면 호출자가 400 반환)
     * @return LT 인코딩에 필요한 메타데이터와 Base64 storedData
     * @throws IOException 파일 읽기 또는 압축 실패 시
     */
    public EncodeResponse encode(MultipartFile file) throws IOException {
        // ── 1. 파일명 sanitize ──────────────────────────────────────────────
        String rawName = file.getOriginalFilename();
        if (rawName == null || rawName.isBlank()) {
            rawName = "unknown";
        }
        String sanitizedName = sanitizeFilename(rawName);
        log.debug("파일명 sanitize: [{}] → [{}]", rawName, sanitizedName);

        // ── 2. 원본 바이트 읽기 ─────────────────────────────────────────────
        byte[] originalBytes = file.getBytes();
        long originalSize = originalBytes.length;
        log.debug("원본 파일 크기: {} 바이트", originalSize);

        // ── 3. gzip 압축 시도 ───────────────────────────────────────────────
        byte[] gzipped = gzip(originalBytes);
        byte[] storedBytes;
        boolean compressed;

        if (gzipped.length < originalBytes.length) {
            // 압축 효과가 있을 때만 gzip 사용
            storedBytes = gzipped;
            compressed = true;
            double savingPct = (1.0 - (double) gzipped.length / originalSize) * 100;
            log.debug("gzip 압축 적용: {} → {} 바이트 ({} 절감)",
                    originalSize, gzipped.length, String.format("%.1f%%", savingPct));
        } else {
            // 이미 압축된 파일(jpg, zip 등)은 원본 그대로 사용
            storedBytes = originalBytes;
            compressed = false;
            log.debug("gzip 압축 미적용 (압축 후 크기가 더 크거나 동일): {} → {} 바이트",
                    originalSize, gzipped.length);
        }

        // ── 4. CRC32 계산 ───────────────────────────────────────────────────
        CRC32 crc32 = new CRC32();
        crc32.update(storedBytes);
        long crc32Value = crc32.getValue();
        // 16진수 문자열로 변환 (대문자, 0 패딩 없음)
        String crc32Hex = Long.toHexString(crc32Value).toUpperCase();
        log.debug("CRC32: 0x{}", crc32Hex);

        // ── 5. 블록 수 계산 ─────────────────────────────────────────────────
        int totalBlocks = (int) Math.ceil((double) storedBytes.length / PAYLOAD_SIZE);
        log.debug("총 블록 수: {} (storedSize={}, PAYLOAD_SIZE={})",
                totalBlocks, storedBytes.length, PAYLOAD_SIZE);

        // ── 6. 마지막 블록 0 패딩 후 Base64 인코딩 ─────────────────────────
        // 마지막 블록이 PAYLOAD_SIZE보다 작으면 0으로 채워 정확히 PAYLOAD_SIZE 배수로 맞춤
        int paddedLength = totalBlocks * PAYLOAD_SIZE;
        byte[] paddedBytes;
        if (paddedLength == storedBytes.length) {
            paddedBytes = storedBytes;
        } else {
            paddedBytes = new byte[paddedLength];
            System.arraycopy(storedBytes, 0, paddedBytes, 0, storedBytes.length);
            // 나머지는 new byte[]의 기본값 0으로 채워짐
        }
        String storedData = Base64.getEncoder().encodeToString(paddedBytes);

        // ── 7. EncodeResponse 구성 및 반환 ──────────────────────────────────
        EncodeResponse response = new EncodeResponse();
        response.setFilename(sanitizedName);
        response.setOriginalSize(originalSize);
        response.setStoredSize(storedBytes.length);
        response.setCompressed(compressed);
        response.setPayloadSize(PAYLOAD_SIZE);
        response.setTotalBlocks(totalBlocks);
        response.setCrc32(crc32Hex);
        response.setStoredData(storedData);

        return response;
    }

    /**
     * 파일명을 안전하게 정리한다.
     *
     * 처리 순서:
     *   1. 경로 구분자 및 위험 문자 제거 (디렉터리 트래버설 방지)
     *   2. 앞뒤 공백·점 제거
     *   3. 빈 문자열이 되면 "unknown"으로 대체
     *   4. UTF-8 인코딩 시 100바이트 초과 → 확장자 보존하며 앞부분 절단
     *
     * @param name 원본 파일명
     * @return sanitize 처리된 파일명
     */
    private String sanitizeFilename(String name) {
        // 1. 경로 구분자 및 위험 문자 제거
        //    Windows: \, /  Unix: /  그 외: null 바이트, 콜론 등
        String sanitized = name
                .replaceAll("[/\\\\:*?\"<>|]", "_")  // 경로·특수 문자 → 밑줄
                .replaceAll("\0", "")                  // null 바이트 제거
                .strip();                              // 앞뒤 공백 제거

        // 2. 앞뒤 점 제거 (숨김 파일이나 상위 디렉터리 참조 방지)
        while (sanitized.startsWith(".")) {
            sanitized = sanitized.substring(1);
        }
        sanitized = sanitized.strip();

        // 3. 빈 문자열 → 기본값
        if (sanitized.isEmpty()) {
            return "unknown";
        }

        // 4. UTF-8 100바이트 제한 — 확장자 보존하며 앞부분 절단
        byte[] nameBytes = sanitized.getBytes(StandardCharsets.UTF_8);
        if (nameBytes.length <= FILENAME_MAX_BYTES) {
            return sanitized;
        }

        return truncateFilenameToBytes(sanitized, FILENAME_MAX_BYTES);
    }

    /**
     * 파일명을 maxBytes 바이트 이내로 절단하되 확장자를 보존한다.
     *
     * 확장자 추출: 마지막 점(.)의 위치를 기준으로 분리.
     * 확장자가 없거나 확장자 자체가 maxBytes를 초과하면 단순 바이트 절단.
     * UTF-8 멀티바이트 문자 경계를 안전하게 처리하기 위해
     * String → bytes → String 변환 시 불완전한 문자는 제거.
     *
     * @param name     원본 파일명
     * @param maxBytes 최대 UTF-8 바이트 수
     * @return 절단된 파일명
     */
    private String truncateFilenameToBytes(String name, int maxBytes) {
        int dotIdx = name.lastIndexOf('.');

        if (dotIdx <= 0) {
            // 확장자 없음 → 단순 바이트 절단
            return truncateByteSafe(name, maxBytes);
        }

        String stem = name.substring(0, dotIdx);     // 확장자 앞부분
        String ext = name.substring(dotIdx);          // "." 포함 확장자

        byte[] extBytes = ext.getBytes(StandardCharsets.UTF_8);
        if (extBytes.length >= maxBytes) {
            // 확장자 자체가 너무 길면 확장자도 절단
            return truncateByteSafe(name, maxBytes);
        }

        // 앞부분을 (maxBytes - 확장자길이) 바이트로 절단 후 확장자 재결합
        int stemMaxBytes = maxBytes - extBytes.length;
        String truncatedStem = truncateByteSafe(stem, stemMaxBytes);
        return truncatedStem + ext;
    }

    /**
     * 문자열을 maxBytes UTF-8 바이트 이내로 안전하게 절단한다.
     * UTF-8 멀티바이트 문자 경계에서 잘리지 않도록 처리.
     *
     * @param s        절단할 문자열
     * @param maxBytes 최대 바이트 수
     * @return 절단된 문자열 (항상 유효한 UTF-8)
     */
    private String truncateByteSafe(String s, int maxBytes) {
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        if (bytes.length <= maxBytes) {
            return s;
        }
        // maxBytes에서 멀티바이트 경계를 거슬러 올라가며 안전한 절단 위치 탐색
        int end = maxBytes;
        // UTF-8 연속 바이트(10xxxxxx)는 단독으로 시작 불가 → 시작 바이트(0xxxxxxx 또는 11xxxxxx)까지 후퇴
        while (end > 0 && (bytes[end] & 0xC0) == 0x80) {
            end--;
        }
        return new String(bytes, 0, end, StandardCharsets.UTF_8);
    }

    /**
     * 바이트 배열을 gzip으로 압축한다.
     *
     * @param data 압축할 원본 바이트
     * @return gzip 압축된 바이트
     * @throws IOException 압축 중 I/O 오류 발생 시
     */
    private byte[] gzip(byte[] data) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (GZIPOutputStream gzos = new GZIPOutputStream(baos)) {
            gzos.write(data);
        }
        return baos.toByteArray();
    }
}
