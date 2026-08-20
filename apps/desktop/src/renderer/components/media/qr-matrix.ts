/**
 * Self-contained, zero-dependency QR code generator (ISO/IEC 18004).
 * Supports Byte mode (UTF-8), error correction levels L/M/Q/H, versions 1–20,
 * and outputs a 2D boolean matrix for clean SVG rendering.
 */

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

const EC_INDICATORS: Record<ErrorCorrectionLevel, number> = {
  M: 0,
  L: 1,
  H: 2,
  Q: 3,
};

// Galois Field GF(256) tables with primitive polynomial 0x11D (285)
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  LOG_TABLE[0] = 0; // Log of 0 is undefined, but 0 simplifies lookup
})();

function gfMultiply(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return EXP_TABLE[LOG_TABLE[x]! + LOG_TABLE[y]!];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const alpha = EXP_TABLE[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMultiply(poly[j]!, alpha);
      next[j + 1] ^= poly[j]!;
    }
    poly = next;
  }
  return poly;
}

function rsCalculateRemainder(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGeneratorPoly(degree);
  const remainder = new Uint8Array(degree);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ remainder[0]!;
    for (let j = 0; j < degree - 1; j++) {
      remainder[j] = remainder[j + 1]! ^ gfMultiply(gen[degree - 1 - j]!, factor);
    }
    remainder[degree - 1] = gfMultiply(gen[0]!, factor);
  }
  return remainder;
}

/**
 * QR Code capacity and block structure table per version (1–20) and EC Level.
 * Format: [totalCodewords, ecCodewordsPerBlock, numBlocksG1, dataPerBlockG1, numBlocksG2, dataPerBlockG2]
 */
interface VersionTableEntry {
  totalCodewords: number;
  ecPerBlock: number;
  g1Blocks: number;
  g1Data: number;
  g2Blocks: number;
  g2Data: number;
}

const VERSION_TABLE: Record<ErrorCorrectionLevel, VersionTableEntry[]> = {
  L: [
    { totalCodewords: 26, ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0 }, // v1
    { totalCodewords: 44, ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0 }, // v2
    { totalCodewords: 70, ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0 }, // v3
    { totalCodewords: 100, ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0 }, // v4
    { totalCodewords: 134, ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0 }, // v5
    { totalCodewords: 172, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0 }, // v6
    { totalCodewords: 196, ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0 }, // v7
    { totalCodewords: 242, ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0 }, // v8
    { totalCodewords: 292, ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0 }, // v9
    { totalCodewords: 346, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69 }, // v10
    { totalCodewords: 404, ecPerBlock: 20, g1Blocks: 4, g1Data: 81, g2Blocks: 0, g2Data: 0 }, // v11
    { totalCodewords: 466, ecPerBlock: 24, g1Blocks: 2, g1Data: 92, g2Blocks: 2, g2Data: 93 }, // v12
    { totalCodewords: 532, ecPerBlock: 26, g1Blocks: 4, g1Data: 107, g2Blocks: 0, g2Data: 0 }, // v13
    { totalCodewords: 581, ecPerBlock: 30, g1Blocks: 3, g1Data: 115, g2Blocks: 1, g2Data: 116 }, // v14
    { totalCodewords: 655, ecPerBlock: 22, g1Blocks: 5, g1Data: 87, g2Blocks: 1, g2Data: 88 }, // v15
    { totalCodewords: 733, ecPerBlock: 24, g1Blocks: 5, g1Data: 98, g2Blocks: 1, g2Data: 99 }, // v16
    { totalCodewords: 815, ecPerBlock: 28, g1Blocks: 1, g1Data: 107, g2Blocks: 5, g2Data: 108 }, // v17
    { totalCodewords: 901, ecPerBlock: 30, g1Blocks: 5, g1Data: 120, g2Blocks: 1, g2Data: 121 }, // v18
    { totalCodewords: 991, ecPerBlock: 28, g1Blocks: 3, g1Data: 113, g2Blocks: 4, g2Data: 114 }, // v19
    { totalCodewords: 1085, ecPerBlock: 28, g1Blocks: 3, g1Data: 107, g2Blocks: 5, g2Data: 108 }, // v20
  ],
  M: [
    { totalCodewords: 26, ecPerBlock: 10, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 }, // v1
    { totalCodewords: 44, ecPerBlock: 16, g1Blocks: 1, g1Data: 28, g2Blocks: 0, g2Data: 0 }, // v2
    { totalCodewords: 70, ecPerBlock: 26, g1Blocks: 1, g1Data: 44, g2Blocks: 0, g2Data: 0 }, // v3
    { totalCodewords: 100, ecPerBlock: 18, g1Blocks: 2, g1Data: 32, g2Blocks: 0, g2Data: 0 }, // v4
    { totalCodewords: 134, ecPerBlock: 24, g1Blocks: 2, g1Data: 43, g2Blocks: 0, g2Data: 0 }, // v5
    { totalCodewords: 172, ecPerBlock: 16, g1Blocks: 4, g1Data: 27, g2Blocks: 0, g2Data: 0 }, // v6
    { totalCodewords: 196, ecPerBlock: 18, g1Blocks: 4, g1Data: 31, g2Blocks: 0, g2Data: 0 }, // v7
    { totalCodewords: 242, ecPerBlock: 22, g1Blocks: 2, g1Data: 38, g2Blocks: 2, g2Data: 39 }, // v8
    { totalCodewords: 292, ecPerBlock: 22, g1Blocks: 3, g1Data: 36, g2Blocks: 2, g2Data: 37 }, // v9
    { totalCodewords: 346, ecPerBlock: 26, g1Blocks: 4, g1Data: 43, g2Blocks: 1, g2Data: 44 }, // v10
    { totalCodewords: 404, ecPerBlock: 30, g1Blocks: 1, g1Data: 50, g2Blocks: 4, g2Data: 51 }, // v11
    { totalCodewords: 466, ecPerBlock: 22, g1Blocks: 6, g1Data: 36, g2Blocks: 2, g2Data: 37 }, // v12
    { totalCodewords: 532, ecPerBlock: 22, g1Blocks: 8, g1Data: 37, g2Blocks: 1, g2Data: 38 }, // v13
    { totalCodewords: 581, ecPerBlock: 24, g1Blocks: 4, g1Data: 40, g2Blocks: 5, g2Data: 41 }, // v14
    { totalCodewords: 655, ecPerBlock: 24, g1Blocks: 5, g1Data: 41, g2Blocks: 5, g2Data: 42 }, // v15
    { totalCodewords: 733, ecPerBlock: 28, g1Blocks: 7, g1Data: 45, g2Blocks: 3, g2Data: 46 }, // v16
    { totalCodewords: 815, ecPerBlock: 28, g1Blocks: 10, g1Data: 46, g2Blocks: 1, g2Data: 47 }, // v17
    { totalCodewords: 901, ecPerBlock: 26, g1Blocks: 9, g1Data: 43, g2Blocks: 4, g2Data: 44 }, // v18
    { totalCodewords: 991, ecPerBlock: 26, g1Blocks: 3, g1Data: 44, g2Blocks: 11, g2Data: 45 }, // v19
    { totalCodewords: 1085, ecPerBlock: 26, g1Blocks: 3, g1Data: 41, g2Blocks: 13, g2Data: 42 }, // v20
  ],
  Q: [
    { totalCodewords: 26, ecPerBlock: 13, g1Blocks: 1, g1Data: 13, g2Blocks: 0, g2Data: 0 },
    { totalCodewords: 44, ecPerBlock: 22, g1Blocks: 1, g1Data: 22, g2Blocks: 0, g2Data: 0 },
    { totalCodewords: 70, ecPerBlock: 18, g1Blocks: 2, g1Data: 17, g2Blocks: 0, g2Data: 0 },
    { totalCodewords: 100, ecPerBlock: 26, g1Blocks: 2, g1Data: 24, g2Blocks: 0, g2Data: 0 },
    { totalCodewords: 134, ecPerBlock: 18, g1Blocks: 2, g1Data: 15, g2Blocks: 2, g2Data: 16 },
    { totalCodewords: 172, ecPerBlock: 24, g1Blocks: 4, g1Data: 19, g2Blocks: 0, g2Data: 0 },
    { totalCodewords: 196, ecPerBlock: 18, g1Blocks: 2, g1Data: 14, g2Blocks: 4, g2Data: 15 },
    { totalCodewords: 242, ecPerBlock: 22, g1Blocks: 4, g1Data: 18, g2Blocks: 2, g2Data: 19 },
    { totalCodewords: 292, ecPerBlock: 20, g1Blocks: 4, g1Data: 16, g2Blocks: 4, g2Data: 17 },
    { totalCodewords: 346, ecPerBlock: 24, g1Blocks: 6, g1Data: 19, g2Blocks: 2, g2Data: 20 },
    { totalCodewords: 404, ecPerBlock: 28, g1Blocks: 4, g1Data: 22, g2Blocks: 4, g2Data: 23 },
    { totalCodewords: 466, ecPerBlock: 26, g1Blocks: 4, g1Data: 20, g2Blocks: 6, g2Data: 21 },
    { totalCodewords: 532, ecPerBlock: 24, g1Blocks: 8, g1Data: 20, g2Blocks: 4, g2Data: 21 },
    { totalCodewords: 581, ecPerBlock: 20, g1Blocks: 11, g1Data: 16, g2Blocks: 5, g2Data: 17 },
    { totalCodewords: 655, ecPerBlock: 30, g1Blocks: 5, g1Data: 24, g2Blocks: 7, g2Data: 25 },
    { totalCodewords: 733, ecPerBlock: 24, g1Blocks: 15, g1Data: 19, g2Blocks: 2, g2Data: 20 },
    { totalCodewords: 815, ecPerBlock: 28, g1Blocks: 1, g1Data: 22, g2Blocks: 15, g2Data: 23 },
    { totalCodewords: 901, ecPerBlock: 28, g1Blocks: 17, g1Data: 22, g2Blocks: 1, g2Data: 23 },
    { totalCodewords: 991, ecPerBlock: 26, g1Blocks: 17, g1Data: 21, g2Blocks: 4, g2Data: 22 },
    { totalCodewords: 1085, ecPerBlock: 30, g1Blocks: 15, g1Data: 24, g2Blocks: 5, g2Data: 25 },
  ],
  H: [
    { totalCodewords: 26, ecPerBlock: 17, g1Blocks: 1, g1Data: 9, g2Blocks: 0, g2Data: 0 }, // v1
    { totalCodewords: 44, ecPerBlock: 28, g1Blocks: 1, g1Data: 16, g2Blocks: 0, g2Data: 0 }, // v2
    { totalCodewords: 70, ecPerBlock: 22, g1Blocks: 2, g1Data: 13, g2Blocks: 0, g2Data: 0 }, // v3
    { totalCodewords: 100, ecPerBlock: 16, g1Blocks: 4, g1Data: 9, g2Blocks: 0, g2Data: 0 }, // v4
    { totalCodewords: 134, ecPerBlock: 22, g1Blocks: 2, g1Data: 11, g2Blocks: 2, g2Data: 12 }, // v5
    { totalCodewords: 172, ecPerBlock: 28, g1Blocks: 4, g1Data: 15, g2Blocks: 0, g2Data: 0 }, // v6
    { totalCodewords: 196, ecPerBlock: 26, g1Blocks: 4, g1Data: 13, g2Blocks: 1, g2Data: 14 }, // v7
    { totalCodewords: 242, ecPerBlock: 26, g1Blocks: 4, g1Data: 14, g2Blocks: 2, g2Data: 15 }, // v8
    { totalCodewords: 292, ecPerBlock: 24, g1Blocks: 4, g1Data: 12, g2Blocks: 4, g2Data: 13 }, // v9
    { totalCodewords: 346, ecPerBlock: 28, g1Blocks: 6, g1Data: 15, g2Blocks: 2, g2Data: 16 }, // v10
    { totalCodewords: 404, ecPerBlock: 24, g1Blocks: 3, g1Data: 12, g2Blocks: 8, g2Data: 13 }, // v11
    { totalCodewords: 466, ecPerBlock: 28, g1Blocks: 7, g1Data: 14, g2Blocks: 4, g2Data: 15 }, // v12
    { totalCodewords: 532, ecPerBlock: 22, g1Blocks: 12, g1Data: 11, g2Blocks: 4, g2Data: 12 }, // v13
    { totalCodewords: 581, ecPerBlock: 24, g1Blocks: 11, g1Data: 12, g2Blocks: 5, g2Data: 13 }, // v14
    { totalCodewords: 655, ecPerBlock: 24, g1Blocks: 11, g1Data: 12, g2Blocks: 7, g2Data: 13 }, // v15
    { totalCodewords: 733, ecPerBlock: 30, g1Blocks: 3, g1Data: 15, g2Blocks: 13, g2Data: 16 }, // v16
    { totalCodewords: 815, ecPerBlock: 28, g1Blocks: 2, g1Data: 14, g2Blocks: 17, g2Data: 15 }, // v17
    { totalCodewords: 901, ecPerBlock: 28, g1Blocks: 2, g1Data: 14, g2Blocks: 19, g2Data: 15 }, // v18
    { totalCodewords: 991, ecPerBlock: 26, g1Blocks: 9, g1Data: 13, g2Blocks: 16, g2Data: 14 }, // v19
    { totalCodewords: 1085, ecPerBlock: 28, g1Blocks: 15, g1Data: 15, g2Blocks: 10, g2Data: 16 }, // v20
  ],
};

const ALIGNMENT_PATTERN_POSITIONS: number[][] = [
  [], // v1
  [6, 18], // v2
  [6, 22], // v3
  [6, 26], // v4
  [6, 30], // v5
  [6, 34], // v6
  [6, 22, 38], // v7
  [6, 24, 42], // v8
  [6, 26, 46], // v9
  [6, 28, 50], // v10
  [6, 30, 54], // v11
  [6, 32, 58], // v12
  [6, 34, 62], // v13
  [6, 26, 46, 66], // v14
  [6, 26, 48, 70], // v15
  [6, 26, 50, 74], // v16
  [6, 30, 54, 78], // v17
  [6, 30, 56, 82], // v18
  [6, 30, 58, 86], // v19
  [6, 34, 62, 90], // v20
];

const FORMAT_MASK = 0x5412;
const FORMAT_POLY = 0x537;

function getFormatInfo(ec: ErrorCorrectionLevel, mask: number): number {
  const data = (EC_INDICATORS[ec] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) {
      rem ^= FORMAT_POLY << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ FORMAT_MASK;
}

const VERSION_POLY = 0x1f25;

function getVersionInfo(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if (rem & (1 << i)) {
      rem ^= VERSION_POLY << (i - 12);
    }
  }
  return (version << 12) | rem;
}

class BitBuffer {
  private buffer: number[] = [];
  private length = 0;

  put(num: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      const bit = ((num >>> i) & 1) === 1;
      const byteIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= byteIndex) this.buffer.push(0);
      if (bit) this.buffer[byteIndex]! |= 0x80 >>> (this.length % 8);
      this.length++;
    }
  }

  get bitLength(): number {
    return this.length;
  }

  getBytes(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}

function selectVersion(dataLen: number, ec: ErrorCorrectionLevel): number {
  const table = VERSION_TABLE[ec];
  for (let v = 1; v <= table.length; v++) {
    const entry = table[v - 1]!;
    const totalData = entry.g1Blocks * entry.g1Data + entry.g2Blocks * entry.g2Data;
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    const requiredBits = headerBits + dataLen * 8;
    const requiredBytes = Math.ceil(requiredBits / 8);
    if (requiredBytes <= totalData) return v;
  }
  throw new Error(`Data is too long to fit in QR code (length: ${dataLen} bytes)`);
}

function encodeData(data: string, version: number, ec: ErrorCorrectionLevel): Uint8Array {
  const utf8 = new TextEncoder().encode(data);
  const entry = VERSION_TABLE[ec][version - 1]!;
  const totalDataBytes = entry.g1Blocks * entry.g1Data + entry.g2Blocks * entry.g2Data;

  const bb = new BitBuffer();
  // Byte mode indicator: 0100
  bb.put(0x4, 4);
  // Character count indicator: 8 bits for v1-9, 16 bits for v10+
  bb.put(utf8.length, version <= 9 ? 8 : 16);
  // Data bytes
  for (let i = 0; i < utf8.length; i++) {
    bb.put(utf8[i]!, 8);
  }

  // Terminator (up to 4 bits)
  const remainingBits = totalDataBytes * 8 - bb.bitLength;
  bb.put(0, Math.min(4, Math.max(0, remainingBits)));

  // Pad to byte boundary
  const padBits = (8 - (bb.bitLength % 8)) % 8;
  bb.put(0, padBits);

  // Pad bytes alternating 0xEC and 0x11
  let padByte = 0xec;
  while (bb.bitLength < totalDataBytes * 8) {
    bb.put(padByte, 8);
    padByte = padByte === 0xec ? 0x11 : 0xec;
  }

  const rawData = bb.getBytes();

  // Split into blocks and compute Reed-Solomon error correction
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let offset = 0;

  for (let b = 0; b < entry.g1Blocks; b++) {
    const blockData = rawData.slice(offset, offset + entry.g1Data);
    offset += entry.g1Data;
    const ec = rsCalculateRemainder(blockData, entry.ecPerBlock);
    blocks.push({ data: blockData, ec });
  }

  for (let b = 0; b < entry.g2Blocks; b++) {
    const blockData = rawData.slice(offset, offset + entry.g2Data);
    offset += entry.g2Data;
    const ec = rsCalculateRemainder(blockData, entry.ecPerBlock);
    blocks.push({ data: blockData, ec });
  }

  // Interleave data codewords
  const result = new Uint8Array(entry.totalCodewords);
  let resIdx = 0;
  const maxDataLen = Math.max(entry.g1Data, entry.g2Data);

  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blocks[b]!.data.length) {
        result[resIdx++] = blocks[b]!.data[i]!;
      }
    }
  }

  // Interleave error correction codewords
  for (let i = 0; i < entry.ecPerBlock; i++) {
    for (let b = 0; b < blocks.length; b++) {
      result[resIdx++] = blocks[b]!.ec[i]!;
    }
  }

  return result;
}

export function generateQrMatrix(
  text: string,
  ec: ErrorCorrectionLevel = 'M',
): { matrix: boolean[][]; size: number; version: number; mask: number } {
  const version = selectVersion(new TextEncoder().encode(text).length, ec);
  const size = 17 + 4 * version;

  // Initialize matrix: null = unset, true = dark, false = light
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array<boolean | null>(size).fill(null),
  );
  const isFunctionModule: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false),
  );

  function setFunction(r: number, c: number, val: boolean) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r]![c] = val;
      isFunctionModule[r]![c] = true;
    }
  }

  // 1. Finder patterns (7x7) + separators
  const finders = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];

  for (const [row, col] of finders) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row! + r;
        const nc = col! + c;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
          const isDark =
            r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setFunction(nr, nc, isDark);
        } else {
          setFunction(nr, nc, false); // Separator
        }
      }
    }
  }

  // 2. Timing patterns (row 6 and col 6)
  for (let i = 8; i < size - 8; i++) {
    const isDark = i % 2 === 0;
    if (matrix[6]![i] === null) setFunction(6, i, isDark);
    if (matrix[i]![6] === null) setFunction(i, 6, isDark);
  }

  // 3. Alignment patterns (version >= 2)
  if (version >= 2) {
    const positions = ALIGNMENT_PATTERN_POSITIONS[version - 1]!;
    for (let i = 0; i < positions.length; i++) {
      for (let j = 0; j < positions.length; j++) {
        // Skip finder pattern corners (top-left, top-right, bottom-left)
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === positions.length - 1) ||
          (i === positions.length - 1 && j === 0)
        ) {
          continue;
        }
        const r = positions[i]!;
        const c = positions[j]!;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunction(r + dr, c + dc, isDark);
          }
        }
      }
    }
  }

  // 4. Dark module (row 4*version + 9, col 8)
  setFunction(4 * version + 9, 8, true);

  // 5. Reserve format info modules
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      if (matrix[8]![i] === null) matrix[8]![i] = false;
      if (matrix[i]![8] === null) matrix[i]![8] = false;
      isFunctionModule[8]![i] = true;
      isFunctionModule[i]![8] = true;
    }
  }
  for (let i = size - 8; i < size; i++) {
    if (matrix[8]![i] === null) matrix[8]![i] = false;
    isFunctionModule[8]![i] = true;
  }
  for (let i = size - 7; i < size; i++) {
    if (matrix[i]![8] === null) matrix[i]![8] = false;
    isFunctionModule[i]![8] = true;
  }

  // 6. Reserve version info modules (version >= 7)
  if (version >= 7) {
    for (let r = 0; r < 6; r++) {
      for (let c = size - 11; c < size - 8; c++) {
        isFunctionModule[r]![c] = true;
        isFunctionModule[c]![r] = true;
      }
    }
  }

  // 7. Place data bits in zig-zag columns
  const encodedBytes = encodeData(text, version, ec);
  let byteIndex = 0;
  let bitIndex = 7;
  let upwards = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Skip vertical timing pattern
    const rows = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rows) {
      for (let colOffset = 0; colOffset < 2; colOffset++) {
        const c = right - colOffset;
        if (!isFunctionModule[r]![c]) {
          let bit = false;
          if (byteIndex < encodedBytes.length) {
            bit = ((encodedBytes[byteIndex]! >>> bitIndex) & 1) === 1;
            bitIndex--;
            if (bitIndex < 0) {
              bitIndex = 7;
              byteIndex++;
            }
          }
          matrix[r]![c] = bit;
        }
      }
    }
    upwards = !upwards;
  }

  // 8. Mask evaluation and selection
  const maskConditions = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number, _c: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  let bestMask = 0;
  let minPenalty = Infinity;
  let bestMatrix: boolean[][] = [];

  for (let maskIdx = 0; maskIdx < 8; maskIdx++) {
    const testMatrix: boolean[][] = Array.from({ length: size }, (_, r) =>
      Array.from({ length: size }, (_, c) => {
        const original = matrix[r]![c] ?? false;
        if (isFunctionModule[r]![c]) return original;
        const maskBit = maskConditions[maskIdx]!(r, c);
        return maskBit ? !original : original;
      }),
    );

    // Write format info for testing
    const formatInfo = getFormatInfo(ec, maskIdx);
    applyFormatInfo(testMatrix, formatInfo, size);

    if (version >= 7) {
      const versionInfo = getVersionInfo(version);
      applyVersionInfo(testMatrix, versionInfo, size);
    }

    const penalty = calculatePenalty(testMatrix, size);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = maskIdx;
      bestMatrix = testMatrix;
    }
  }

  return { matrix: bestMatrix, size, version, mask: bestMask };
}

function applyFormatInfo(matrix: boolean[][], formatInfo: number, size: number): void {
  for (let i = 0; i < 15; i++) {
    const bit = ((formatInfo >>> i) & 1) === 1;
    // Vertical format info around top-left finder and bottom-left
    if (i < 6) {
      matrix[i]![8] = bit;
    } else if (i < 8) {
      matrix[i + 1]![8] = bit;
    } else {
      matrix[size - 15 + i]![8] = bit;
    }

    // Horizontal format info around top-left finder and top-right
    if (i < 8) {
      matrix[8]![size - i - 1] = bit;
    } else if (i < 9) {
      matrix[8]![15 - i - 1 + 1] = bit;
    } else {
      matrix[8]![15 - i - 1] = bit;
    }
  }
}

function applyVersionInfo(matrix: boolean[][], versionInfo: number, size: number): void {
  for (let i = 0; i < 18; i++) {
    const bit = ((versionInfo >>> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = (i % 3) + size - 11;
    matrix[r]![c] = bit;
    matrix[c]![r] = bit;
  }
}

function calculatePenalty(matrix: boolean[][], size: number): number {
  let penalty = 0;

  // N1: 5 or more consecutive same color in row/col
  for (let r = 0; r < size; r++) {
    let count = 0;
    let prev = !matrix[r]![0];
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c] === prev) {
        count++;
      } else {
        if (count >= 5) penalty += 3 + (count - 5);
        prev = matrix[r]![c]!;
        count = 1;
      }
    }
    if (count >= 5) penalty += 3 + (count - 5);
  }

  for (let c = 0; c < size; c++) {
    let count = 0;
    let prev = !matrix[0]![c];
    for (let r = 0; r < size; r++) {
      if (matrix[r]![c] === prev) {
        count++;
      } else {
        if (count >= 5) penalty += 3 + (count - 5);
        prev = matrix[r]![c]!;
        count = 1;
      }
    }
    if (count >= 5) penalty += 3 + (count - 5);
  }

  // N2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = matrix[r]![c];
      if (
        matrix[r + 1]![c] === color &&
        matrix[r]![c + 1] === color &&
        matrix[r + 1]![c + 1] === color
      ) {
        penalty += 3;
      }
    }
  }

  // N3: 1:1:3:1:1 pattern with 4 light modules before or after
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size - 10; c++) {
      if (
        matrix[r]![c] &&
        !matrix[r]![c + 1] &&
        matrix[r]![c + 2] &&
        matrix[r]![c + 3] &&
        matrix[r]![c + 4] &&
        !matrix[r]![c + 5] &&
        matrix[r]![c + 6]
      ) {
        if (
          c >= 4 &&
          !matrix[r]![c - 1] &&
          !matrix[r]![c - 2] &&
          !matrix[r]![c - 3] &&
          !matrix[r]![c - 4]
        ) {
          penalty += 40;
        }
        if (
          c + 10 < size &&
          !matrix[r]![c + 7] &&
          !matrix[r]![c + 8] &&
          !matrix[r]![c + 9] &&
          !matrix[r]![c + 10]
        ) {
          penalty += 40;
        }
      }
    }
  }

  // N4: Balance of dark vs light modules
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c]) darkCount++;
    }
  }
  const total = size * size;
  const ratio = (darkCount * 100) / total;
  const step = Math.floor(Math.abs(ratio - 50) / 5);
  penalty += step * 10;

  return penalty;
}
