/**
 * @file EncodeController.java
 * @description 파일 인코딩 REST API 컨트롤러.
 * POST /api/encode 엔드포인트 하나만 노출하며,
 * MultipartFile을 받아 FileEncoderService에 위임한 후 JSON을 반환한다.
 *
 * 오류 처리:
 *   - 파일 미첨부 또는 빈 파일 → 400 Bad Request
 *   - MultipartException (크기 초과 등) → Spring 기본 처리 위임 (400)
 *   - 서비스 예외 → 500 Internal Server Error + 오류 메시지
 *
 * 관계:
 *   FileEncoderService → 실제 인코딩 처리
 *   EncodeResponse     → JSON 직렬화 후 클라이언트 반환
 */
package com.cameralink.transmitter.controller;

import com.cameralink.transmitter.dto.EncodeResponse;
import com.cameralink.transmitter.service.FileEncoderService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;

@RestController
@RequestMapping("/api")
public class EncodeController {

    private static final Logger log = LoggerFactory.getLogger(EncodeController.class);

    private final FileEncoderService encoderService;

    public EncodeController(FileEncoderService encoderService) {
        this.encoderService = encoderService;
    }

    /**
     * 파일을 수신하여 LT 인코딩에 필요한 메타데이터와 storedData(Base64)를 반환한다.
     *
     * @param file multipart/form-data의 "file" 파트
     * @return 200: EncodeResponse JSON / 400: 파일 없음 또는 빈 파일 / 500: 처리 오류
     */
    @PostMapping("/encode")
    public ResponseEntity<?> encode(@RequestParam("file") MultipartFile file) {
        // ── 입력 검증 ────────────────────────────────────────────────────────
        if (file == null || file.isEmpty()) {
            log.warn("파일이 첨부되지 않았거나 비어있음");
            return ResponseEntity
                    .badRequest()
                    .body("파일을 첨부해주세요. (빈 파일 불가)");
        }

        log.debug("파일 수신: name=[{}], size={} 바이트, contentType=[{}]",
                file.getOriginalFilename(), file.getSize(), file.getContentType());

        // ── 인코딩 처리 ──────────────────────────────────────────────────────
        try {
            EncodeResponse response = encoderService.encode(file);
            log.debug("인코딩 완료: blocks={}, compressed={}, crc32={}",
                    response.getTotalBlocks(), response.isCompressed(), response.getCrc32());
            return ResponseEntity.ok(response);

        } catch (IOException e) {
            log.error("파일 인코딩 중 I/O 오류 발생: {}", e.getMessage(), e);
            return ResponseEntity
                    .internalServerError()
                    .body("파일 처리 중 오류가 발생했습니다: " + e.getMessage());

        } catch (Exception e) {
            log.error("파일 인코딩 중 예상치 못한 오류 발생: {}", e.getMessage(), e);
            return ResponseEntity
                    .internalServerError()
                    .body("서버 오류가 발생했습니다.");
        }
    }
}
