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

/** Any raw server message — tool calls, cancellations, resumption updates, goAway. */
async function emitRaw(window: Page, message: object): Promise<void> {
  await window.evaluate((data) => {
    (
      globalThis as unknown as { voiceSocket: { receive: (d: object) => void } }
    ).voiceSocket.receive(data);
  }, message);
}

function sentMessages(window: Page): Promise<string[]> {
  return window.evaluate(
    () => (globalThis as unknown as { voiceMessages: string[] }).voiceMessages,
  );
}

async function openVoice(window: Page): Promise<void> {
  const launcher = window.getByTestId('smith-bubble');
  const modeVoice = window.getByTestId('smith-mode-voice');
  // Floating bubble is lazy-loaded on other screens and omitted on Smith (⌘5),
  // where the mode bar is already mounted. Wait for whichever surface is up.
  await expect(launcher.or(modeVoice)).toBeVisible();
  if (await launcher.isVisible()) {
    if ((await launcher.getAttribute('aria-expanded')) !== 'true') {
      await launcher.click();
    }
  }
  await expect(modeVoice).toBeVisible();
  await modeVoice.click();
}

test('voice: captions, playback, mute, navigation, interruption, disconnect and reconnect', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gemini-live:mintToken');
      ipcMain.handle('gemini-live:mintToken', () => ({
        token: 'test-token',
        model: 'gemini-3.8-live-extended-thinking',
        systemInstruction: 'Test voice.',
      }));
    });
    await controlledMicrophone(window);
    await controlledSocket(window);
    await openVoice(window);
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
    await expect(window.getByTestId('smith-bubble-input')).toBeFocused();
    await window.keyboard.press('Meta+5');
    await openVoice(window);
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Microphone muted');
    await window.getByTestId('smith-voice-mute').click();
    expect(await tracks(window)).toEqual([{ enabled: true, state: 'live' }]);
    await emitRaw(window, { sessionResumptionUpdate: { newHandle: 'resume-handle-1' } });
    await window.evaluate(() =>
      (globalThis as unknown as { voiceSocket: { close: () => void } }).voiceSocket.close(),
    );
    // A dropped socket resumes in place on a fresh token; the mic stays open.
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    expect(await tracks(window)).toEqual([{ enabled: true, state: 'live' }]);
    await expect
      .poll(async () =>
        (await sentMessages(window)).some((message) =>
          message.includes('"handle":"resume-handle-1"'),
        ),
      )
      .toBe(true);
    await window.getByTestId('smith-voice-stop').click();
    expect((await tracks(window)).every((track) => track.state === 'ended')).toBe(true);
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Think out loud');
  } finally {
    await app.close();
  }
});

test('voice: tool calls, missed-call nudge, cancellation, and caption spacing', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const target = globalThis as unknown as { voiceCancelCount: number };
      target.voiceCancelCount = 0;
      ipcMain.removeHandler('gemini-live:mintToken');
      ipcMain.handle('gemini-live:mintToken', () => ({
        token: 'test-token',
        model: 'gemini-3.8-live-extended-thinking',
        systemInstruction: 'Test voice.',
      }));
      ipcMain.removeHandler('smith:send');
      ipcMain.handle('smith:send', (_event, _projectId: unknown, text: string) => ({
        model: 'inherit',
        activeModel: 'inherit',
        reasoningEffort: 'medium',
        activeReasoningEffort: 'medium',
        permissionMode: 'ask',
        running: true,
        error: null,
        transcript: [{ id: 't1', kind: 'text', source: 'operator', text, at: 0 }],
      }));
      ipcMain.removeHandler('smith:cancel');
      ipcMain.handle('smith:cancel', () => {
        target.voiceCancelCount += 1;
        return null;
      });
      ipcMain.removeHandler('smith:proposalsList');
      ipcMain.handle('smith:proposalsList', () => []);
    });
    await controlledMicrophone(window);
    await controlledSocket(window);
    await openVoice(window);
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');

    // A turn that ends on a spoken promise with no tool call earns one text
    // nudge to make the smith_work call late.
    await emit(window, {
      outputTranscription: { text: 'Let me check on that.' },
      turnComplete: true,
    });
    await expect
      .poll(async () =>
        (await sentMessages(window)).some((message) =>
          message.includes('no tool call went through'),
        ),
      )
      .toBe(true);

    // A smith_work call dispatches the send and answers SILENT so the model
    // never repeats the acknowledgment for the receipt.
    await emitRaw(window, {
      toolCall: {
        functionCalls: [{ id: 'c1', name: 'smith_work', args: { text: 'check my runs' } }],
      },
    });
    await expect
      .poll(async () =>
        (await sentMessages(window)).some((message) => message.includes('"toolResponse"')),
      )
      .toBe(true);
    const workResponse = (await sentMessages(window)).find((message) =>
      message.includes('"toolResponse"'),
    );
    expect(workResponse).toContain('"scheduling":"SILENT"');
    expect(workResponse).toContain('"started":true');

    // A second overlapping work call is refused while the first still runs.
    await emitRaw(window, {
      toolCall: {
        functionCalls: [{ id: 'c2', name: 'smith_work', args: { text: 'check my runs again' } }],
      },
    });
    await expect
      .poll(
        async () =>
          (await sentMessages(window)).filter((message) => message.includes('"toolResponse"'))
            .length,
      )
      .toBe(2);
    const refused = (await sentMessages(window)).filter((message) =>
      message.includes('"toolResponse"'),
    )[1];
    expect(refused).toContain('"scheduling":"WHEN_IDLE"');
    expect(refused).toContain('already working');

    // The server retracting the call that started the turn (the operator
    // barged in mid-call) cancels the delegated Smith turn; retracting any
    // other call does not.
    await emitRaw(window, { toolCallCancellation: { ids: ['c2'] } });
    await emitRaw(window, { toolCallCancellation: { ids: ['c1'] } });
    await expect
      .poll(async () =>
        app.evaluate(
          () => (globalThis as unknown as { voiceCancelCount: number }).voiceCancelCount,
        ),
      )
      .toBe(1);

    // Sentence-boundary chunks join with the space the wire leaves out.
    await emit(window, { outputTranscription: { text: 'First sentence.' } });
    await emit(window, { outputTranscription: { text: 'Second one.' } });
    await expect(window.getByTestId('smith-voice-panel')).toContainText(
      'First sentence. Second one.',
    );
    await window.getByTestId('smith-voice-stop').click();
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
    await openVoice(window);
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
    // Both starts captured the mic before minting; teardown must have released them.
    expect((await tracks(window)).every((track) => track.state === 'ended')).toBe(true);
  } finally {
    await app.close();
  }
});

test('voice: stays inside Smith chat across modes and navigation', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gemini-live:mintToken');
      ipcMain.handle('gemini-live:mintToken', () => ({
        token: 'test-token',
        model: 'gemini-3.8-live-extended-thinking',
        systemInstruction: 'Test voice.',
      }));
    });
    await controlledMicrophone(window);
    await controlledSocket(window);
    await window.getByTestId('smith-bubble').click();
    await window.getByTestId('smith-bubble-input').fill('Keep this draft');
    await window.getByTestId('smith-mode-voice').click();
    const popover = window.getByTestId('smith-popover');
    await expect(popover.getByTestId('smith-voice-panel')).toBeVisible();
    await expect(window.getByTestId('smith-voice-launcher')).toHaveCount(0);
    await expect(window.getByTestId('smith-voice-fullscreen')).toHaveCount(0);
    expect(app.windows()).toHaveLength(1);
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    await window.getByTestId('smith-voice-mute').click();
    await window.getByTestId('smith-mode-text').click();
    await expect(window.getByTestId('smith-bubble-input')).toHaveValue('Keep this draft');
    await expect(
      window.getByRole('button', { name: 'Unmute microphone', exact: true }),
    ).toBeVisible();
    await expect(window.getByTestId('smith-bubble-new-chat')).toBeDisabled();
    expect(await tracks(window)).toEqual([{ enabled: false, state: 'live' }]);
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('smith-popover')).toHaveCount(0);
    await expect(window.getByTestId('smith-bubble')).toBeFocused();
    await expect(window.getByTestId('smith-bubble')).toHaveAttribute(
      'aria-label',
      /microphone muted/,
    );
    await window.keyboard.press('Meta+5');
    await expect(window.getByTestId('app-view')).toHaveAttribute('data-view', 'smith');
    await expect(window.getByTestId('smith-input')).toHaveValue('Keep this draft');
    await window.getByTestId('smith-mode-voice').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Microphone muted');
    await expect(window.getByTestId('smith-new-chat')).toBeDisabled();
    await expect(window.getByTestId('smith-voice-panel')).not.toHaveAttribute('role', 'dialog');
    await window.getByTestId('smith-voice-mute').click();
    expect(await tracks(window)).toEqual([{ enabled: true, state: 'live' }]);
    await window.keyboard.press('Meta+1');
    await window.getByTestId('smith-bubble').click();
    await expect(popover.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    expect(await tracks(window)).toEqual([{ enabled: true, state: 'live' }]);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(700, 600));
    await expect(
      window.getByRole('button', { name: 'End voice session', exact: true }),
    ).toBeInViewport();
    await window.getByTestId('smith-mode-text').click();
    await window.getByRole('button', { name: 'End voice session', exact: true }).click();
    expect((await tracks(window)).every((track) => track.state === 'ended')).toBe(true);
    await window.getByTestId('smith-mode-voice').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Think out loud');
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    await window.getByTestId('smith-bubble-close').click();
    await window.getByTestId('nav-settings').click();
    await window.getByTestId('settings-tab-system').click();
    await window.getByTestId('settings-replay-intro').click();
    await expect(window.getByTestId('smith-bubble')).toBeHidden();
    await expect
      .poll(async () => (await tracks(window)).every((track) => track.state === 'ended'))
      .toBe(true);
  } finally {
    await app.close();
  }
});
