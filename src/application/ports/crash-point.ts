// Lets a test stop the process at an exact moment (after the commit and before the ack, for
// example) to prove recovery. In production the adapter does nothing.
export interface CrashPoint {
  reached(point: string): void;
}
