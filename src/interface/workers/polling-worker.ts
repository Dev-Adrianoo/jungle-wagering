// One background loop. While a tick reports work it runs again at once; when there is none
// it waits, and that wait is interruptible so shutdown never has to sit through it. A tick
// that throws is logged and the loop goes on: one bad cycle must not stop the worker.
import { safely } from '../../application/observability/safely';
import type { Logger } from '../../application/ports/logger';

export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly idleDelayMs: number,
    private readonly tick: () => Promise<number>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const handled = await this.safeTick();
      if (handled === 0 && this.running) {
        await this.idle();
      }
    }
  }

  private async safeTick(): Promise<number> {
    try {
      return await this.tick();
    } catch (error) {
      safely(() =>
        this.logger.error('worker.tick_failed', {
          worker: this.name,
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
      return 0;
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, this.idleDelayMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
