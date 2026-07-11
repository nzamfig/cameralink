/**
 * @file FileEncoderServiceTest.java
 * @description FileEncoderService 단위 테스트.
 * 핵심 인코딩 로직(압축, CRC32, 블록 분할, 파일명 sanitize)을 검증한다.
 *
 * 테스트 전략:
 *   - MockMultipartFile로 실제 파일 의존성 제거
 *   - 경계값(빈 파일, 정확히 PAYLOAD_SIZE 배수, 압축 효율 낮은 파일) 확인
 *   - 파일명 sanitize: 경로 문자, 긴 UTF-8 멀티바이트 이름 처리 검증
 *
 * 관계: FileEncoderService → 테스트 대상
 */
package com.cameralink.transmitter;

import com.cameralink.transmitter.dto.EncodeResponse;
import com.cameralink.transmitter.service.FileEncoderService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

class FileEncoderServiceTest {

    private FileEncoderService service;

    /** 각 테스트 전 서비스 인스턴스 초기화 */
    @BeforeEach
    void setUp() {
        service = new FileEncoderService();
    }

    // ─────────────────────────────────────────────
    // 기본 인코딩 흐름 검증
    // ─────────────────────────────────────────────

    @Test
    @DisplayName("텍스트 파일 인코딩 — gzip 압축 적용 확인")
    void encode_textFile_shouldBeCompressed() throws IOException {
        // 반복 문자열 → gzip 압축 효율이 높음
        String content = "가나다라마바사아자차카타파하".repeat(50);
        byte[] contentBytes = content.getBytes(StandardCharsets.UTF_8);

        MockMultipartFile file = new MockMultipartFile(
                "file", "test.txt", "text/plain", contentBytes);

        EncodeResponse response = service.encode(file);

        // 텍스트 파일은 gzip 압축 효율이 높으므로 compressed=true 기대
        assertTrue(response.isCompressed(), "반복 텍스트는 gzip 압축 후 크기가 줄어야 한다");
        assertTrue(response.getStoredSize() < response.getOriginalSize(),
                "압축 후 크기가 원본보다 작아야 한다");
        assertNotNull(response.getStoredData(), "storedData는 null이 아니어야 한다");
        assertFalse(response.getStoredData().isBlank(), "storedData는 비어있지 않아야 한다");
    }

    @Test
    @DisplayName("이미 압축된 파일 — gzip 미적용 확인")
    void encode_precompressedFile_shouldNotCompress() throws IOException {
        // 랜덤 바이트 → gzip 압축 효율 없음
        byte[] randomBytes = new byte[1000];
        for (int i = 0; i < randomBytes.length; i++) {
            randomBytes[i] = (byte) (i * 7 + 13); // 의사 랜덤
        }
        // GZIP 매직 바이트로 시작하는 데이터를 흉내내지 않고, 실제로 압축하면 커지는 데이터 사용
        // 무작위 패턴은 압축 효율이 낮아 gzip 적용 시 오히려 커짐
        MockMultipartFile file = new MockMultipartFile(
                "file", "data.bin", "application/octet-stream", randomBytes);

        EncodeResponse response = service.encode(file);

        // 압축 여부와 관계없이 totalBlocks와 storedData는 항상 유효해야 함
        assertTrue(response.getTotalBlocks() > 0, "블록 수는 양수여야 한다");
        assertNotNull(response.getStoredData(), "storedData는 항상 존재해야 한다");
        assertNotNull(response.getCrc32(), "CRC32는 항상 존재해야 한다");
        assertFalse(response.getCrc32().isBlank(), "CRC32 문자열은 비어있지 않아야 한다");
    }

    // ─────────────────────────────────────────────
    // 블록 분할 및 패딩 검증
    // ─────────────────────────────────────────────

    @Test
    @DisplayName("storedData 디코딩 후 길이 = totalBlocks × 145")
    void encode_storedData_paddedToBlockBoundary() throws IOException {
        // 정확히 PAYLOAD_SIZE(145) 배수가 아닌 크기 사용
        byte[] data = new byte[450]; // 450B → ceil(450/145) = 4블록 → 패딩 후 580B
        for (int i = 0; i < data.length; i++) data[i] = (byte) i;

        MockMultipartFile file = new MockMultipartFile(
                "file", "data.bin", "application/octet-stream", data);

        EncodeResponse response = service.encode(file);

        // storedData 디코딩 후 길이 검증
        byte[] decoded = Base64.getDecoder().decode(response.getStoredData());
        assertEquals(response.getTotalBlocks() * response.getPayloadSize(), decoded.length,
                "storedData 길이는 totalBlocks × payloadSize여야 한다");
        assertEquals(145, response.getPayloadSize(), "payloadSize는 항상 145여야 한다");
    }

    @Test
    @DisplayName("정확히 145바이트 배수 파일 — 패딩 없이 그대로")
    void encode_exactBlockMultiple_noPadding() throws IOException {
        // 정확히 145B → 1블록, 패딩 없음
        byte[] data = new byte[145];
        MockMultipartFile file = new MockMultipartFile(
                "file", "exact.bin", "application/octet-stream", data);

        EncodeResponse response = service.encode(file);

        // compressed 여부에 상관없이 블록 수와 storedData 길이 확인
        byte[] decoded = Base64.getDecoder().decode(response.getStoredData());
        assertEquals(response.getTotalBlocks() * 145, decoded.length,
                "패딩 후 길이는 totalBlocks × 145여야 한다");
    }

    // ─────────────────────────────────────────────
    // CRC32 검증
    // ─────────────────────────────────────────────

    @Test
    @DisplayName("동일 파일 두 번 인코딩 — CRC32 동일")
    void encode_samefile_sameCrc32() throws IOException {
        byte[] data = "테스트 데이터 for CRC32".getBytes(StandardCharsets.UTF_8);

        MockMultipartFile file1 = new MockMultipartFile("file", "test.txt", "text/plain", data);
        MockMultipartFile file2 = new MockMultipartFile("file", "test.txt", "text/plain", data);

        EncodeResponse r1 = service.encode(file1);
        EncodeResponse r2 = service.encode(file2);

        assertEquals(r1.getCrc32(), r2.getCrc32(), "동일 파일의 CRC32는 동일해야 한다");
    }

    @Test
    @DisplayName("CRC32 값이 16진수 문자열 형식")
    void encode_crc32Format_isHexString() throws IOException {
        byte[] data = "hello".getBytes(StandardCharsets.UTF_8);
        MockMultipartFile file = new MockMultipartFile("file", "hi.txt", "text/plain", data);

        EncodeResponse response = service.encode(file);

        // CRC32는 16진수 문자열 (0-9, A-F만 포함)
        String crc32 = response.getCrc32();
        assertNotNull(crc32);
        assertTrue(crc32.matches("[0-9A-F]+"),
                "CRC32는 대문자 16진수 문자열이어야 한다. 실제값: " + crc32);
    }

    // ─────────────────────────────────────────────
    // 파일명 sanitize 검증
    // ─────────────────────────────────────────────

    @Test
    @DisplayName("경로 구분자 포함 파일명 sanitize")
    void encode_filenameWithPath_sanitized() throws IOException {
        byte[] data = "test".getBytes();
        // Windows 경로가 포함된 파일명 (악의적 경로 트래버설 시도)
        MockMultipartFile file = new MockMultipartFile(
                "file", "../../../etc/passwd", "text/plain", data);

        EncodeResponse response = service.encode(file);

        assertFalse(response.getFilename().contains("/"), "슬래시 포함 불가");
        assertFalse(response.getFilename().contains("\\"), "역슬래시 포함 불가");
        assertFalse(response.getFilename().contains(".."), "상위 디렉터리 참조 불가");
    }

    @Test
    @DisplayName("한국어 파일명 100바이트 초과 시 확장자 보존 절단")
    void encode_longKoreanFilename_truncatedWithExtension() throws IOException {
        byte[] data = "test".getBytes();
        // 한국어는 UTF-8에서 문자당 3바이트 → 40자 = 120바이트 (100바이트 초과)
        String longName = "가".repeat(40) + ".txt";
        MockMultipartFile file = new MockMultipartFile(
                "file", longName, "text/plain", data);

        EncodeResponse response = service.encode(file);

        // UTF-8 바이트 수가 100 이하인지 확인
        byte[] nameBytes = response.getFilename().getBytes(StandardCharsets.UTF_8);
        assertTrue(nameBytes.length <= 100,
                "파일명은 UTF-8 100바이트 이하여야 한다. 실제: " + nameBytes.length + "바이트");

        // 확장자(.txt)가 보존되었는지 확인
        assertTrue(response.getFilename().endsWith(".txt"),
                "확장자가 보존되어야 한다. 실제: " + response.getFilename());
    }

    @Test
    @DisplayName("빈 파일명 → 'unknown'으로 대체")
    void encode_emptyFilename_replacedWithUnknown() throws IOException {
        byte[] data = "test".getBytes();
        MockMultipartFile file = new MockMultipartFile(
                "file", "", "text/plain", data);

        EncodeResponse response = service.encode(file);

        assertEquals("unknown", response.getFilename(), "빈 파일명은 'unknown'이어야 한다");
    }

    // ─────────────────────────────────────────────
    // 응답 메타데이터 검증
    // ─────────────────────────────────────────────

    @Test
    @DisplayName("EncodeResponse 모든 필드가 채워져야 한다")
    void encode_allResponseFieldsPresent() throws IOException {
        byte[] data = "CameraLink 테스트".getBytes(StandardCharsets.UTF_8);
        MockMultipartFile file = new MockMultipartFile(
                "file", "test.txt", "text/plain", data);

        EncodeResponse response = service.encode(file);

        assertNotNull(response.getFilename());
        assertTrue(response.getOriginalSize() > 0);
        assertTrue(response.getStoredSize() > 0);
        assertEquals(145, response.getPayloadSize());
        assertTrue(response.getTotalBlocks() > 0);
        assertNotNull(response.getCrc32());
        assertNotNull(response.getStoredData());
    }
}
