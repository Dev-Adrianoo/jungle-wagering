import type { CrashPoint } from '../../application/ports/crash-point';

const KILLED = 137;

export class EnvCrashPoint implements CrashPoint {
  constructor(
    private readonly point: string | undefined,
    private readonly exit: (code: number) => never = (code) => process.exit(code),
  ) {}

  reached(point: string): void {
    if (this.point !== undefined && this.point === point) {
      this.exit(KILLED);
    }
  }
}
