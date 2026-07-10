/**
 * @file TransmitterApplication.java
 * @description CameraLink 송신기 Spring Boot 애플리케이션 진입점.
 * 파일을 수신하여 LT 인코딩 데이터를 반환하는 REST API 서버를 시작한다.
 * 정적 리소스(HTML/CSS/JS)를 함께 서빙하므로 별도 서버가 필요 없다.
 *
 * 관계: application.yml → 포트(8080), 바인딩(127.0.0.1), 업로드 크기 제한 설정.
 */
package com.cameralink.transmitter;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class TransmitterApplication {

    public static void main(String[] args) {
        SpringApplication.run(TransmitterApplication.class, args);
    }
}
