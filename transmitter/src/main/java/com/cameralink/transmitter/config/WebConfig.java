/**
 * @file WebConfig.java
 * @description Spring MVC 웹 설정.
 * 정적 리소스 서빙 경로를 명시적으로 등록한다.
 *
 * 보안 설계:
 *   - server.address=127.0.0.1 설정으로 로컬 전용 바인딩 (application.yml)
 *   - CORS 설정 불필요 — 송신기와 프론트엔드가 동일 Origin(localhost:8080) 서빙
 *   - 외부 접근 차단은 OS/방화벽이 아닌 바인딩 주소 설정으로 처리
 *
 * 관계:
 *   application.yml → server.address, multipart 크기 설정 (이중 보호)
 *   static/         → index.html, css/, js/ 파일들 서빙
 */
package com.cameralink.transmitter.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    /**
     * 정적 리소스 핸들러 등록.
     * /static/** 경로 요청을 classpath:/static/ 디렉터리에서 서빙.
     * index.html은 기본 Welcome 페이지로 자동 서빙 (Spring Boot 기본 동작).
     */
    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry
            .addResourceHandler("/static/**")
            .addResourceLocations("classpath:/static/");
    }
}
