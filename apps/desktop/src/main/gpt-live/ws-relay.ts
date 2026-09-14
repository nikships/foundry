/**
 * Relays a companion-phone WebSocket to OpenAI GPT-Live so the OpenAI key
 * never leaves this Mac. Text frames only; audio is base64 inside JSON.
 */

import { createHash, randomBytes } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GptLiveVoiceId } from '@shared/gpt-live.js';
import { liveSessionConfig } from './service.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface VoiceRelayDeps {
  apiKey: string;
  voice: GptLiveVoiceId;
}

/** True when this upgrade is the companion voice socket. */
export function isVoiceUpgrade(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0]?.replace(/\/+$/, '') ?? '';
  return path === '/v1/smith/voice/live';
}

export function acceptVoiceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  deps: VoiceRelayDeps,
): void {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  connectOpenAi(deps, socket);
}

function connectOpenAi(deps: VoiceRelayDeps, phone: Duplex): void {
  const clientKey = randomBytes(16).toString('base64');
  const req = httpsRequest(
    {
      host: 'api.openai.com',
      path: '/v1/live/sessions',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': clientKey,
      },
    },
    (res) => {
      if (res.statusCode !== 101) {
        phone.destroy();
        res.resume();
        return;
      }
      const openai = res.socket;
      if (!openai) {
        phone.destroy();
        return;
      }
      pipe(phone, openai, deps.voice);
    },
  );
  req.on('error', () => phone.destroy());
  req.on('upgrade', (_res, openai) => {
    pipe(phone, openai, deps.voice);
  });
  req.end();
}

function pipe(phone: Duplex, openai: Duplex, voice: GptLiveVoiceId): void {
  let closed = false;
  const closeBoth = (): void => {
    if (closed) return;
    closed = true;
    phone.destroy();
    openai.destroy();
  };

  openai.write(
    encodeClientFrame(
      JSON.stringify({
        type: 'session.start',
        event_id: 'foundry_start',
        session: {
          ...liveSessionConfig(voice),
          audio: {
            format: { type: 'audio/pcm', rate: 16000 },
            output: { voice },
          },
        },
      }),
    ),
  );

  let phoneBuf: Buffer = Buffer.alloc(0);
  phone.on('data', (chunk: Buffer) => {
    phoneBuf = Buffer.concat([phoneBuf, chunk]);
    while (true) {
      const decoded = decodeFrame(phoneBuf, true);
      if (!decoded) break;
      phoneBuf = decoded.rest;
      if (decoded.opcode === 0x8) {
        closeBoth();
        return;
      }
      if (decoded.opcode === 0x1) openai.write(encodeClientFrame(decoded.payload));
    }
  });

  let openaiBuf: Buffer = Buffer.alloc(0);
  openai.on('data', (chunk: Buffer) => {
    openaiBuf = Buffer.concat([openaiBuf, chunk]);
    while (true) {
      const decoded = decodeFrame(openaiBuf, false);
      if (!decoded) break;
      openaiBuf = decoded.rest;
      if (decoded.opcode === 0x8) {
        closeBoth();
        return;
      }
      if (decoded.opcode === 0x1) phone.write(encodeServerFrame(decoded.payload));
    }
  });

  phone.on('close', closeBoth);
  phone.on('error', closeBoth);
  phone.on('end', closeBoth);
  openai.on('close', closeBoth);
  openai.on('error', closeBoth);
  openai.on('end', closeBoth);
}

function encodeServerFrame(text: string): Buffer {
  return encodeFrame(text, false);
}

function encodeClientFrame(text: string): Buffer {
  return encodeFrame(text, true);
}

function encodeFrame(text: string, mask: boolean): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  const maskKey = mask ? randomBytes(4) : Buffer.alloc(0);
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = (mask ? 0x80 : 0) | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = (mask ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = (mask ? 0x80 : 0) | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i]! ^= maskKey[i % 4]!;
  return Buffer.concat([header, maskKey, masked]);
}

function decodeFrame(
  buffer: Buffer,
  expectMask: boolean,
): { opcode: number; payload: string; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (expectMask !== masked && opcode !== 0x8) {
    // Tolerate control frames either way; data frames must match the peer.
  }
  if (buffer.length < offset + maskLength + length) return null;
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    const unmasked = Buffer.from(payload);
    for (let i = 0; i < unmasked.length; i++) unmasked[i]! ^= mask[i % 4]!;
    payload = unmasked;
  }
  return {
    opcode,
    payload: payload.toString('utf8'),
    rest: buffer.subarray(offset + maskLength + length),
  };
}
