export class PromisePool {
  private maxConcurrency: number;
  private currentConcurrency = 0;
  private queue: {
    wrappedPromise: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }[] = [];
  private timeout: number;

  constructor(maxConcurrency: number, timeout = 3600000) {
    this.maxConcurrency = maxConcurrency;
    this.timeout = timeout;
  }

  public add<T>(promiseGenerator: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const signal = controller.signal;

      const wrappedPromise = () => {
        return new Promise<T>((innerResolve, innerReject) => {
          const timeoutId = setTimeout(() => {
            controller.abort();
            innerReject(new Error("Promise cancelled due to timeout"));
          }, this.timeout);

          promiseGenerator(signal)
            .then((result) => {
              clearTimeout(timeoutId);
              innerResolve(result);
            })
            .catch((error) => {
              clearTimeout(timeoutId);
              innerReject(error);
            });
        });
      };

      this.queue.push({ wrappedPromise, resolve, reject });
      this.runNext();
    });
  }

  private runNext() {
    if (this.currentConcurrency < this.maxConcurrency && this.queue.length > 0) {
      const { wrappedPromise, resolve, reject } = this.queue.shift();
      this.currentConcurrency++;

      wrappedPromise()
        .then((result) => {
          resolve(result);
          this.currentConcurrency--;
          this.runNext();
        })
        .catch((error) => {
          reject(error);
          this.currentConcurrency--;
          this.runNext();
        });
    }
  }
}
