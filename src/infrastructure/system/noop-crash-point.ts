import type { CrashPoint } from '../../application/ports/crash-point';

export class NoopCrashPoint implements CrashPoint {
  reached(): void {}
}
