import { expect, test, type Page } from '@playwright/test';
import { seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

/** Drive the real SDK and audio worklet without credentials, network, or the physical mic. */
async function controlledMicrophone(window: Page): Promise<void> {
  await window.evaluate(() => {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const target = window as unknown as { voiceTracks: MediaStreamTrack[] };
    target.voiceTracks = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = destination.stream.clone();
      target.voiceTracks.push(...stream.getTracks());
      return stream;
    };
  });
}

async function tracks(window: Page): Promise<{ enabled: boolean; state: string }[]> {
  return window.evaluate(() =>
    (window as unknown as { voiceTracks: MediaStreamTrack[] }).voiceTracks.map((track) => ({
      enabled: track.enabled,
      state: track.readyState,
    })),
  );
}

async function controlledSocket(window: Page): Promise<void> {
  await window.evaluate(() => {
    const target = globalThis as unknown as {
      voiceSocket: { receive: (data: object) => void; close: () => void };
      voiceMessages: string[];
    };
    target.voiceMessages = [];
    class TestSocket {
      onopen?: () => void;
      onclose?: () => void;
      onmessage?: (event: MessageEvent) => void;
      constructor() {
        target.voiceSocket = this;
        queueMicrotask(() => this.onopen?.());
      }
      receive(data: object): void {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
      }
      send(data: string): void {
        target.voiceMessages.push(data);
        if (data.includes('"setup"')) queueMicrotask(() => this.receive({ setupComplete: {} }));
      }
      close(): void {
        this.onclose?.();
      }
    }
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: TestSocket });
  });
}

async function emit(window: Page, serverContent: object): Promise<void> {
  await window.evaluate((content) => {
    (
      globalThis as unknown as { voiceSocket: { receive: (data: object) => void } }
    ).voiceSocket.receive({ serverContent: content });
  }, serverContent);
}

test('voice: captions, playback, mute, navigation, interruption, disconnect and reconnect', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gemini-live:mintToken');
      ipcMain.handle('gemini-live:mintToken', () => ({
        token: 'test-token',
        model: 'gemini-3.1-flash-live-preview',
        systemInstruction: 'Test voice.',
      }));
    });
    await controlledMicrophone(window);
    await controlledSocket(window);
    await window.getByTestId('smith-voice-launcher').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Think out loud');
    expect(await tracks(window)).toEqual([]);
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    await emit(window, { inputTranscription: { text: 'Help me ' } });
    await emit(window, {
      inputTranscription: { text: 'think.' },
      outputTranscription: { text: 'Let’s explore ' },
    });
    await emit(window, {
      outputTranscription: { text: 'your idea.' },
      modelTurn: {
        parts: [
          {
            inlineData: {
              data: Buffer.alloc(24000 * 2 * 10).toString('base64'),
              mimeType: 'audio/pcm;rate=24000',
            },
          },
        ],
      },
    });
    const panel = window.getByTestId('smith-voice-panel');
    await expect(panel).toContainText('Help me think.');
    await expect(panel).toContainText('Let’s explore your idea.');
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Smith is speaking');
    await emit(window, { turnComplete: true });
    // Server completion must not end the speaking state before queued playback finishes.
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Smith is speaking');
    await emit(window, { interrupted: true });
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    await window.getByTestId('smith-voice-mute').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Microphone muted');
    expect(await tracks(window)).toEqual([{ enabled: false, state: 'live' }]);
    await expect
      .poll(() =>
        window.evaluate(() =>
          (globalThis as unknown as { voiceMessages: string[] }).voiceMessages.some((message) =>
            message.includes('audioStreamEnd'),
          ),
        ),
      )
      .toBe(true);
    await window.getByTestId('smith-voice-close').click();
    await expect(window.getByTestId('smith-voice-launcher')).toBeFocused();
    await window.keyboard.press('Meta+5');
    await window.getByTestId('smith-voice-launcher').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Microphone muted');
    await window.getByTestId('smith-voice-mute').click();
    expect(await tracks(window)).toEqual([{ enabled: true, state: 'live' }]);
    await window.evaluate(() =>
      (globalThis as unknown as { voiceSocket: { close: () => void } }).voiceSocket.close(),
    );
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Let’s reconnect');
    expect(await tracks(window)).toEqual([{ enabled: true, state: 'ended' }]);
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    await window.getByTestId('smith-voice-stop').click();
    expect((await tracks(window)).every((track) => track.state === 'ended')).toBe(true);
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Think out loud');
  } finally {
    await app.close();
  }
});

test('voice: cancelling a pending token cannot revive an old connection', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await controlledMicrophone(window);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gemini-live:mintToken');
      const target = globalThis as unknown as { finishVoiceMint: () => void };
      ipcMain.handle(
        'gemini-live:mintToken',
        () =>
          new Promise((resolve) => {
            target.finishVoiceMint = () => resolve({ token: 'obsolete-token', model: 'test' });
          }),
      );
    });
    await window.getByTestId('smith-voice-launcher').click();
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Connecting to Smith');
    await expect
      .poll(() =>
        app.evaluate(
          () => typeof (globalThis as unknown as { finishVoiceMint?: () => void }).finishVoiceMint,
        ),
      )
      .toBe('function');
    await window.getByTestId('smith-voice-stop').click();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gemini-live:mintToken');
      ipcMain.handle('gemini-live:mintToken', () => ({ error: 'New attempt failed safely.' }));
    });
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByRole('alert')).toHaveText('New attempt failed safely.');
    await app.evaluate(() =>
      (globalThis as unknown as { finishVoiceMint: () => void }).finishVoiceMint(),
    );
    await expect(window.getByRole('alert')).toHaveText('New attempt failed safely.');
    expect(await tracks(window)).toEqual([]);
  } finally {
    await app.close();
  }
});
