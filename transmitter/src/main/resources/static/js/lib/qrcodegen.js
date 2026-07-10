/**
 * @file qrcodegen.js
 * @description QR 코드 생성 라이브러리 — nayuki QR Code Generator 포트.
 * MIT 라이선스 (원본: https://github.com/nayuki/QR-Code-generator)
 * TypeScript 소스를 ES 모듈 순수 JS로 변환.
 *
 * 이 파일은 QrCode, QrSegment 두 클래스와 보조 타입을 export한다.
 * 사용측: QrSegment.makeBytes(uint8Array) → QrCode.encodeSegments([seg], Ecc.MEDIUM)
 *
 * 관계:
 *   qr-encoder.js → 이 라이브러리를 import하여 사용
 */

"use strict";

// ─────────────────────────────────────────────
// QrCode 클래스
// ─────────────────────────────────────────────

export class QrCode {

  /** 에러 정정 레벨 열거형 */
  static Ecc = {
    LOW:      { ordinal: 0, formatBits: 1 },
    MEDIUM:   { ordinal: 1, formatBits: 0 },
    QUARTILE: { ordinal: 2, formatBits: 3 },
    HIGH:     { ordinal: 3, formatBits: 2 },
  };

  /** QR 버전 범위 */
  static MIN_VERSION = 1;
  static MAX_VERSION = 40;

  /**
   * 세그먼트 배열로부터 QR 코드를 생성한다.
   * @param {QrSegment[]} segs 인코딩할 세그먼트 배열
   * @param {object} ecl 에러 정정 레벨 (QrCode.Ecc.*)
   * @param {number} minVersion 최소 버전 (1~40)
   * @param {number} maxVersion 최대 버전 (1~40)
   * @param {number} mask 마스크 패턴 (-1 = 자동)
   * @param {boolean} boostEcl 여유 있으면 ECC 레벨 자동 향상
   * @returns {QrCode}
   */
  static encodeSegments(segs, ecl, minVersion=1, maxVersion=40, mask=-1, boostEcl=true) {
    if (minVersion < QrCode.MIN_VERSION || minVersion > maxVersion || maxVersion > QrCode.MAX_VERSION || mask < -1 || mask > 7)
      throw new RangeError("잘못된 버전 또는 마스크 값");

    // 버전 탐색: 데이터가 들어갈 수 있는 가장 작은 버전
    let version, dataUsedBits;
    for (version = minVersion; ; version++) {
      const dataCapacityBits = QrCode._getNumDataCodewords(version, ecl) * 8;
      dataUsedBits = QrSegment.getTotalBits(segs, version);
      if (dataUsedBits <= dataCapacityBits) break;
      if (version >= maxVersion)
        throw new RangeError("데이터가 너무 커서 QR 코드에 들어가지 않습니다");
    }

    // ECC 레벨 향상 (여유 공간이 있을 때)
    for (const newEcl of [QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) {
      if (boostEcl && dataUsedBits <= QrCode._getNumDataCodewords(version, newEcl) * 8)
        ecl = newEcl;
    }

    // 데이터 비트스트림 구성
    const bb = new _BitBuffer();
    for (const seg of segs) {
      bb.appendBits(seg.mode.modeBits, 4);
      bb.appendBits(seg.numChars, seg.mode.numCharCountBits(version));
      for (const b of seg.getData()) bb.appendBits(b, 1);
    }
    const dataCapacityBits = QrCode._getNumDataCodewords(version, ecl) * 8;
    bb.appendBits(0, Math.min(4, dataCapacityBits - bb.length));
    bb.appendBits(0, (8 - (bb.length & 7)) & 7);
    // 패딩 코드워드
    for (let padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11)
      bb.appendBits(padByte, 8);

    // QrCode 인스턴스 반환 (마스크 자동 선택)
    const dc = new Uint8Array(bb.length / 8);
    for (let i = 0; i < dc.length; i++)
      dc[i] = bb.getByte(i);

    return new QrCode(version, ecl, dc, mask);
  }

  // ── 내부 생성자 ──────────────────────────────────────────────────────────

  constructor(version, errorCorrectionLevel, dataCodewords, msk) {
    this.version = version;
    this.errorCorrectionLevel = errorCorrectionLevel;

    if (version < QrCode.MIN_VERSION || version > QrCode.MAX_VERSION)
      throw new RangeError("버전 범위 오류");

    this.size = version * 4 + 17;
    // modules[y][x] : true=검정, false=흰색
    this.modules    = Array.from({length: this.size}, () => new Array(this.size).fill(false));
    this.isFunction = Array.from({length: this.size}, () => new Array(this.size).fill(false));

    // 기능 패턴 배치
    this._drawFunctionPatterns();

    // 데이터 코드워드 + 에러 정정 코드워드 배치
    const allCodewords = this._addEccAndInterleave(dataCodewords);
    this._drawCodewords(allCodewords);

    // 마스크 패턴 적용
    if (msk === -1) {
      let minPenalty = Infinity;
      for (let m = 0; m < 8; m++) {
        this._applyMask(m);
        this._drawFormatBits(m);
        const penalty = this._getPenaltyScore();
        if (penalty < minPenalty) {
          msk = m;
          minPenalty = penalty;
        }
        this._applyMask(m); // 되돌리기
      }
    }
    this.mask = msk;
    this._applyMask(msk);
    this._drawFormatBits(msk);
    this.isFunction = [];
  }

  // ── 모듈 접근자 ──────────────────────────────────────────────────────────

  /** (x, y) 위치의 모듈 색상: true=검정, false=흰색 */
  getModule(x, y) {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
  }

  // ── 기능 패턴 그리기 ────────────────────────────────────────────────────

  _drawFunctionPatterns() {
    // 파인더 패턴 + 구분자
    for (const [x, y] of [[3, 3], [this.size - 4, 3], [3, this.size - 4]]) {
      this._drawFinderPattern(x, y);
    }
    // 포맷 비트 예약
    this._drawFormatBits(0);
    // 타이밍 패턴
    for (let i = 0; i < this.size; i++) {
      this._setFunctionModule(6, i, i % 2 === 0);
      this._setFunctionModule(i, 6, i % 2 === 0);
    }
    // 얼라인먼트 패턴
    const alignPatPos = QrCode._getAlignmentPatternPositions(this.version);
    const numAlign = alignPatPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if (i === 0 && j === 0 || i === 0 && j === numAlign-1 || i === numAlign-1 && j === 0)
          continue; // 파인더 패턴 위치 스킵
        this._drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
      }
    }
    // 버전 비트 (버전 7 이상)
    if (this.version >= 7) this._drawVersion();
  }

  _drawFormatBits(mask) {
    const data = this.errorCorrectionLevel.formatBits << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (data << 10 | rem) ^ 0x5412;
    // 수평
    for (let i = 0; i <= 5; i++) this._setFunctionModule(8, i, QrCode._getBit(bits, i));
    this._setFunctionModule(8, 7, QrCode._getBit(bits, 6));
    this._setFunctionModule(8, 8, QrCode._getBit(bits, 7));
    this._setFunctionModule(7, 8, QrCode._getBit(bits, 8));
    for (let i = 9; i < 15; i++) this._setFunctionModule(14-i, 8, QrCode._getBit(bits, i));
    // 수직
    for (let i = 0; i < 8; i++) this._setFunctionModule(this.size-1-i, 8, QrCode._getBit(bits, i));
    for (let i = 8; i < 15; i++) this._setFunctionModule(8, this.size-15+i, QrCode._getBit(bits, i));
    this._setFunctionModule(8, this.size-8, true);
  }

  _drawVersion() {
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = this.version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const bit = QrCode._getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this._setFunctionModule(a, b, bit);
      this._setFunctionModule(b, a, bit);
    }
  }

  _drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          this._setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  _drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this._setFunctionModule(x+dx, y+dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  _setFunctionModule(x, y, isDark) {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  // ── ECC 및 인터리브 ──────────────────────────────────────────────────────

  _addEccAndInterleave(data) {
    const ver = this.version;
    const ecl = this.errorCorrectionLevel;
    if (data.length !== QrCode._getNumDataCodewords(ver, ecl))
      throw new RangeError("데이터 길이 불일치");

    const numBlocks     = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    const blockEccLen   = QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
    const rawCodewords  = Math.floor(QrCode._getNumRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockLen  = Math.floor(rawCodewords / numBlocks);

    // 데이터 블록 분할 및 ECC 계산
    // shortBlock 길이 = shortBlockLen - blockEccLen (데이터 부분만)
    // longBlock 길이  = shortBlockLen - blockEccLen + 1
    const shortDataLen = shortBlockLen - blockEccLen;
    const blocks = [];
    const rsDiv = QrCode._reedSolomonComputeDivisor(blockEccLen);
    let k = 0;
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortDataLen + (i < numShortBlocks ? 0 : 1);
      const dat = data.subarray(k, k + datLen);
      k += datLen;
      const ecc = QrCode._reedSolomonComputeRemainder(dat, rsDiv);
      // 각 블록: [data..., ecc...] (패딩 없음)
      const block = new Uint8Array(datLen + blockEccLen);
      block.set(dat, 0);
      block.set(ecc, datLen);
      blocks.push(block);
    }

    // 인터리브: 데이터 코드워드 → ECC 코드워드 순서로 열 방향 인터리브
    const result = new Uint8Array(rawCodewords);
    let idx = 0;

    // 데이터 인터리브: shortBlock 길이까지는 모든 블록, longBlock 추가 바이트는 longBlock만
    for (let col = 0; col < shortDataLen; col++) {
      for (const block of blocks) result[idx++] = block[col];
    }
    // longBlock의 추가 데이터 바이트 (shortBlock에는 없음)
    for (let i = numShortBlocks; i < numBlocks; i++) {
      result[idx++] = blocks[i][shortDataLen];
    }

    // ECC 인터리브
    for (let col = 0; col < blockEccLen; col++) {
      for (let i = 0; i < numBlocks; i++) {
        // ECC는 블록 내 데이터 뒤에 위치
        const eccOffset = (i < numShortBlocks ? shortDataLen : shortDataLen + 1) + col;
        result[idx++] = blocks[i][eccOffset];
      }
    }

    return result;
  }

  // ── 코드워드 배치 ────────────────────────────────────────────────────────

  _drawCodewords(data) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = QrCode._getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  // ── 마스크 ───────────────────────────────────────────────────────────────

  _applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y] && this.isFunction[y][x]) continue;
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
          default: throw new RangeError("마스크 값 오류");
        }
        this.modules[y][x] = this.modules[y][x] !== invert;
      }
    }
  }

  // ── 페널티 점수 ──────────────────────────────────────────────────────────

  _getPenaltyScore() {
    let result = 0;
    const size = this.size;
    const modules = this.modules;

    // 규칙 1: 같은 색 연속 5개+
    for (let y = 0; y < size; y++) {
      for (let x = 0, runColor = false, runX = 0; x < size; x++) {
        if (modules[y][x] === runColor) { runX++; if (runX === 5) result += 3; else if (runX > 5) result++; }
        else { runColor = modules[y][x]; runX = 1; }
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0, runColor = false, runY = 0; y < size; y++) {
        if (modules[y][x] === runColor) { runY++; if (runY === 5) result += 3; else if (runY > 5) result++; }
        else { runColor = modules[y][x]; runY = 1; }
      }
    }

    // 규칙 2: 2×2 블록
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x+1] && c === modules[y+1][x] && c === modules[y+1][x+1])
          result += 3;
      }
    }

    // 규칙 3: 파인더 패턴 유사 패턴
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const bits = Array.from({length: 11}, (_, i) => x+i < size ? modules[y][x+i] : false);
        if (bits.length === 11) {
          const pat1 = [true,false,true,true,true,false,true,false,false,false,false];
          const pat2 = [false,false,false,false,true,false,true,true,true,false,true];
          if (bits.every((b,i) => b === pat1[i]) || bits.every((b,i) => b === pat2[i]))
            result += 40;
        }
        const bitsV = Array.from({length: 11}, (_, i) => y+i < size ? modules[y+i][x] : false);
        if (bitsV.length === 11) {
          const pat1 = [true,false,true,true,true,false,true,false,false,false,false];
          const pat2 = [false,false,false,false,true,false,true,true,true,false,true];
          if (bitsV.every((b,i) => b === pat1[i]) || bitsV.every((b,i) => b === pat2[i]))
            result += 40;
        }
      }
    }

    // 규칙 4: 검정 모듈 비율
    let dark = 0;
    for (const row of modules) for (const cell of row) if (cell) dark++;
    const percent = dark / (size * size);
    const k = Math.ceil(Math.abs(percent * 20 - 10)) - 1;
    result += k * 10;

    return result;
  }

  // ── 정적 헬퍼 ───────────────────────────────────────────────────────────

  static _getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  static _getNumDataCodewords(ver, ecl) {
    return Math.floor(QrCode._getNumRawDataModules(ver) / 8)
      - QrCode.ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver]
        * QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  }

  static _getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step)
      result.splice(1, 0, pos);
    return result;
  }

  static _getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  static _reedSolomonComputeDivisor(degree) {
    if (degree < 1 || degree > 255) throw new RangeError("차수 오류");
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = QrCode._reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = QrCode._reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  static _reedSolomonComputeRemainder(data, divisor) {
    // Uint8Array에는 shift()/push()가 없으므로 레지스터 방식으로 구현
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
      // 최상위 바이트를 꺼내고 입력 바이트와 XOR → 승수(factor)
      const factor = b ^ result[0];
      // 레지스터를 한 칸씩 왼쪽으로 이동
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      // 각 위치에 divisor[i] * factor를 XOR
      divisor.forEach((coef, i) => { result[i] ^= QrCode._reedSolomonMultiply(coef, factor); });
    }
    return result;
  }

  static _reedSolomonMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
}

// ─────────────────────────────────────────────
// ECC 테이블 (버전 1~40)
// ─────────────────────────────────────────────

// 블록당 ECC 코드워드 수 [ecl.ordinal][version]
QrCode.ECC_CODEWORDS_PER_BLOCK = [
  // LOW
  [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  // MEDIUM
  [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  // QUARTILE
  [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  // HIGH
  [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
];

// 블록 수 [ecl.ordinal][version]
QrCode.NUM_ERROR_CORRECTION_BLOCKS = [
  // LOW
  [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  // MEDIUM
  [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  // QUARTILE
  [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  // HIGH
  [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
];

// ─────────────────────────────────────────────
// QrSegment 클래스
// ─────────────────────────────────────────────

export class QrSegment {

  static Mode = {
    NUMERIC:      { modeBits: 0x1, numCharCountBits: (v) => v < 10 ? 10 : v < 27 ? 12 : 14 },
    ALPHANUMERIC: { modeBits: 0x2, numCharCountBits: (v) => v < 10 ?  9 : v < 27 ? 11 : 13 },
    BYTE:         { modeBits: 0x4, numCharCountBits: (v) => v < 10 ?  8 : 16 },
    KANJI:        { modeBits: 0x8, numCharCountBits: (v) => v < 10 ?  8 : v < 27 ? 10 : 12 },
    ECI:          { modeBits: 0x7, numCharCountBits: (v) => 0 },
  };

  /**
   * 바이트 배열을 BYTE 모드 세그먼트로 인코딩한다.
   * @param {Uint8Array} data 인코딩할 바이트
   * @returns {QrSegment}
   */
  static makeBytes(data) {
    const bb = new _BitBuffer();
    for (const b of data) bb.appendBits(b, 8);
    return new QrSegment(QrSegment.Mode.BYTE, data.length, bb.getData());
  }

  /**
   * 세그먼트 배열의 총 비트 수를 계산한다.
   * @param {QrSegment[]} segs
   * @param {number} version
   * @returns {number}
   */
  static getTotalBits(segs, version) {
    let result = 0;
    for (const seg of segs) {
      const ccbits = seg.mode.numCharCountBits(version);
      if (seg.numChars >= (1 << ccbits)) return Infinity;
      result += 4 + ccbits + seg.bitData.length;
    }
    return result;
  }

  constructor(mode, numChars, bitData) {
    this.mode = mode;
    this.numChars = numChars;
    this.bitData = bitData;
  }

  getData() { return this.bitData.slice(); }
}

// ─────────────────────────────────────────────
// 내부 비트 버퍼
// ─────────────────────────────────────────────

class _BitBuffer {
  constructor() {
    this.data = [];
    this.length = 0;
  }

  appendBits(val, len) {
    if (len < 0 || len > 31 || val >>> len !== 0)
      throw new RangeError("값/길이 범위 오류");
    for (let i = len - 1; i >= 0; i--) {
      this.data.push((val >>> i) & 1);
      this.length++;
    }
  }

  getByte(index) {
    let result = 0;
    for (let i = 0; i < 8; i++) result = (result << 1) | (this.data[index * 8 + i] || 0);
    return result;
  }

  getData() { return this.data.slice(); }
}
