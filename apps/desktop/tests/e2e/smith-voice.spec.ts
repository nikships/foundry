import { expect, test, type Page } from '@playwright/test';
import { seedOnboardedFixture } from './seed.js';
import { launchFoundry } from './harness.js';

/** Drive WebRTC and the data channel without credentials, network, or the physical mic. */
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

async function controlledPeer(window: Page): Promise<void> {
  await window.evaluate(() => {
    const target = globalThis as unknown as {
      voiceChannel: { receive: (data: object) => void; close: () => void };
      voiceMessages: string[];
    };
    target.voiceMessages = [];
    class TestChannel {
      readyState = 'open';
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        target.voiceChannel = this;
      }
      addEventListener(type: string, handler: (event: MessageEvent) => void): void {
        if (type === 'message') this.onmessage = handler;
      }
      receive(data: object): void {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
      }
      send(data: string): void {
        target.voiceMessages.push(data);
      }
      close(): void {
        this.readyState = 'closed';
      }
    }
    class TestPeer {
      localDescription: { type: string; sdp: string } | null = null;
      iceGatheringState = 'complete';
      addTrack(): void {}
      addEventListener(): void {}
      createDataChannel(): TestChannel {
        return new TestChannel();
      }
      async createOffer(): Promise<{ type: string; sdp: string }> {
        return { type: 'offer', sdp: 'test-offer' };
      }
      async setLocalDescription(desc: { type: string; sdp: string }): Promise<void> {
        this.localDescription = desc;
      }
      async setRemoteDescription(): Promise<void> {}
      close(): void {}
    }
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: TestPeer });
  });
}

async function emit(window: Page, event: object): Promise<void> {
  await window.evaluate((payload) => {
    (
      globalThis as unknown as { voiceChannel: { receive: (data: object) => void } }
    ).voiceChannel.receive(payload);
  }, event);
}

async function openVoice(window: Page): Promise<void> {
  const launcher = window.getByTestId('smith-bubble');
  if ((await launcher.isVisible()) && (await launcher.getAttribute('aria-expanded')) === 'false') {
    await launcher.click();
  }
  await window.getByTestId('smith-mode-voice').click();
}

test('voice: captions, playback, mute, navigation, interruption, disconnect and reconnect', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gpt-live:createSession');
      ipcMain.handle('gpt-live:createSession', () => ({
        sessionId: 'live_test',
        sdp: 'test-answer',
      }));
    });
    await controlledMicrophone(window);
    await controlledPeer(window);
    await openVoice(window);
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Think out loud');
    expect(await tracks(window)).toEqual([]);
    await window.getByTestId('smith-voice-start').click();
    await emit(window, { type: 'session.started', session: { id: 'live_test' } });
    await expect(window.getByTestId('smith-voice-status')).toHaveText('I’m listening');
    await emit(window, { type: 'session.input_transcript.delta', delta: 'Help me ' });
    await emit(window, { type: 'session.input_transcript.delta', delta: 'think.' });
    await emit(window, { type: 'session.output_transcript.delta', delta: 'Let’s explore ' });
    await emit(window, { type: 'session.output_transcript.delta', delta: 'your idea.' });
    const panel = window.getByTestId('smith-voice-panel');
    await expect(panel).toContainText('Help me think.');
    await expect(panel).toContainText('Let’s explore your idea.');
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Smith is speaking');
    await window.getByTestId('smith-voice-mute').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Microphone muted');
    expect(await tracks(window)).toEqual([{ enabled: false, state: 'live' }]);
    await expect
      .poll(() =>
        window.evaluate(() =>
          (globalThis as unknown as { voiceMessages: string[] }).voiceMessages.some((message) =>
            message.includes('session.input_audio.mute'),
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
    await window.getByTestId('smith-voice-stop').click();
    expect((await tracks(window)).every((track) => track.state === 'ended')).toBe(true);
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Think out loud');
  } finally {
    await app.close();
  }
});

test('voice: cancelling a pending session cannot revive an old connection', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await controlledMicrophone(window);
    await controlledPeer(window);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gpt-live:createSession');
      const target = globalThis as unknown as { finishVoiceSession: () => void };
      ipcMain.handle(
        'gpt-live:createSession',
        () =>
          new Promise((resolve) => {
            target.finishVoiceSession = () => resolve({ sessionId: 'obsolete', sdp: 'obsolete' });
          }),
      );
    });
    await openVoice(window);
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByTestId('smith-voice-status')).toHaveText('Connecting to Smith');
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (globalThis as unknown as { finishVoiceSession?: () => void })
              .finishVoiceSession,
        ),
      )
      .toBe('function');
    await window.getByTestId('smith-voice-stop').click();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gpt-live:createSession');
      ipcMain.handle('gpt-live:createSession', () => ({ error: 'New attempt failed safely.' }));
    });
    await window.getByTestId('smith-voice-start').click();
    await expect(window.getByRole('alert')).toHaveText('New attempt failed safely.');
    await app.evaluate(() =>
      (globalThis as unknown as { finishVoiceSession: () => void }).finishVoiceSession(),
    );
    await expect(window.getByRole('alert')).toHaveText('New attempt failed safely.');
    expect(await tracks(window)).toEqual([]);
  } finally {
    await app.close();
  }
});

test('voice: stays inside Smith chat across modes and navigation', async () => {
  const { app, window } = await launchFoundry(seedOnboardedFixture().userDataDir);
  try {
    await expect(window.getByTestId('run-composer')).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('gpt-live:createSession');
      ipcMain.handle('gpt-live:createSession', () => ({
        sessionId: 'live_test',
        sdp: 'test-answer',
      }));
    });
    await controlledMicrophone(window);
    await controlledPeer(window);
    await window.getByTestId('smith-bubble').click();
    await window.getByTestId('smith-bubble-input').fill('Keep this draft');
    await window.getByTestId('smith-mode-voice').click();
    const popover = window.getByTestId('smith-popover');
    await expect(popover.getByTestId('smith-voice-panel')).toBeVisible();
    await expect(window.getByTestId('smith-voice-launcher')).toHaveCount(0);
    await expect(window.getByTestId('smith-voice-fullscreen')).toHaveCount(0);
    expect(app.windows()).toHaveLength(1);
    await window.getByTestId('smith-voice-start').click();
    await emit(window, { type: 'session.started', session: { id: 'live_test' } });
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
    await emit(window, { type: 'session.started', session: { id: 'live_test' } });
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
