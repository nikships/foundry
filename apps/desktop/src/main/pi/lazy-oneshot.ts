/**
 * An `OneShotFactory` that loads the real factory on first `send`.
 *
 * Construction of `AppContext` used to import `pi-oneshot.ts`, which pulled
 * the vendor package before a window existed. The wrapper answers `abort()`
 * immediately and only pays for the runtime when a turn actually starts.
 */
import type { OneShotFactory, OneShotOptions, OneShotSession } from './oneshot.js';

export function lazyOneShots(load: () => Promise<OneShotFactory>): OneShotFactory {
  let factory: OneShotFactory | null = null;
  let pending: Promise<OneShotFactory> | null = null;

  const ready = async (): Promise<OneShotFactory> => {
    if (factory) return factory;
    pending ??= load().then((next) => {
      factory = next;
      return next;
    });
    return pending;
  };

  return (opts: OneShotOptions): OneShotSession => {
    let inner: OneShotSession | null = null;
    let aborted = false;
    return {
      abort(): void {
        aborted = true;
        inner?.abort();
      },
      async send(prompt: string) {
        const session = (inner ??= (await ready())(opts));
        if (aborted) {
          session.abort();
          return {
            text: '',
            usage: null,
            reason: 'aborted',
            interrupted: true,
            structuredOutput: null,
          };
        }
        return session.send(prompt);
      },
    };
  };
}
