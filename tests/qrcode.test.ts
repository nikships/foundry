import { describe, expect, it } from 'vitest';
import { generateQrMatrix } from '../src/renderer/components/qr-matrix.js';

describe('QR code matrix generation', () => {
  it('generates a valid QR matrix for a small string', () => {
    const { matrix, size, version } = generateQrMatrix('hello', 'M');
    expect(version).toBe(1);
    expect(size).toBe(21);
    expect(matrix).toHaveLength(21);
    expect(matrix[0]).toHaveLength(21);

    // Top-left finder pattern 7x7
    // row 0 should have 7 dark modules: [true, true, true, true, true, true, true]
    for (let c = 0; c < 7; c++) {
      expect(matrix[0]![c]).toBe(true);
      expect(matrix[6]![c]).toBe(true);
    }
    // row 1 should have dark-light-light-light-light-light-dark
    expect(matrix[1]![0]).toBe(true);
    expect(matrix[1]![1]).toBe(false);
    expect(matrix[1]![5]).toBe(false);
    expect(matrix[1]![6]).toBe(true);
  });

  it('generates a valid QR matrix for a full CompanionPairingPayload JSON', () => {
    const payload = JSON.stringify({
      protocolVersion: 1,
      origin: 'http://192.168.1.150:52810',
      desktopId: 'desk_a1b2c3d4e5f60718',
      desktopName: 'Nik’s MacBook Pro',
      secret: 'random_generated_secret_base64url_string_here_123',
      expiresAt: '2026-08-19T12:00:00.000Z',
    });

    const { matrix, size, version, mask } = generateQrMatrix(payload, 'M');
    expect(version).toBeGreaterThanOrEqual(7);
    expect(size).toBe(17 + 4 * version);
    expect(matrix).toHaveLength(size);
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(mask).toBeLessThanOrEqual(7);

    // Top-left finder
    expect(matrix[0]![0]).toBe(true);
    expect(matrix[0]![6]).toBe(true);
    expect(matrix[6]![0]).toBe(true);
    expect(matrix[6]![6]).toBe(true);

    // Top-right finder
    expect(matrix[0]![size - 7]).toBe(true);
    expect(matrix[0]![size - 1]).toBe(true);
    expect(matrix[6]![size - 7]).toBe(true);
    expect(matrix[6]![size - 1]).toBe(true);

    // Bottom-left finder
    expect(matrix[size - 7]![0]).toBe(true);
    expect(matrix[size - 7]![6]).toBe(true);
    expect(matrix[size - 1]![0]).toBe(true);
    expect(matrix[size - 1]![6]).toBe(true);
  });

  it('generates a valid QR matrix for a compact pairing URI', () => {
    const uri =
      'foundry://pair?origin=http%3A%2F%2F192.168.1.150%3A52810&secret=random_generated_secret_base64url_string_here_123';
    const { matrix, size, version, mask } = generateQrMatrix(uri, 'M');
    expect(version).toBe(7);
    expect(size).toBe(17 + 4 * version);
    expect(matrix).toHaveLength(size);
    expect(mask).toBeGreaterThanOrEqual(0);
    expect(mask).toBeLessThanOrEqual(7);
  });

  it('supports various error correction levels (L, M, Q, H)', () => {
    const text = 'https://foundry.build';
    const l = generateQrMatrix(text, 'L');
    const m = generateQrMatrix(text, 'M');
    const q = generateQrMatrix(text, 'Q');
    const h = generateQrMatrix(text, 'H');

    expect(l.matrix.length).toBeGreaterThan(0);
    expect(m.matrix.length).toBeGreaterThan(0);
    expect(q.matrix.length).toBeGreaterThan(0);
    expect(h.matrix.length).toBeGreaterThan(0);
  });

  it('throws on data exceeding capacity', () => {
    const huge = 'x'.repeat(20000);
    expect(() => generateQrMatrix(huge, 'H')).toThrow(/too long/);
  });
});
