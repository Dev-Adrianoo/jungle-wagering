export interface UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T>;
  read<T>(work: () => Promise<T>): Promise<T>;
}
