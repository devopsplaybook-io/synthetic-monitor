import { PromisePool } from "./PromisePool";

describe("PromisePool", () => {
  it("should execute all tasks", async () => {
    const pool = new PromisePool(5);
    const results: number[] = [];

    const tasks = [1, 2, 3].map((num) =>
      pool.add(async () => {
        results.push(num);
        return num;
      })
    );

    const resolved = await Promise.all(tasks);
    expect(resolved).toEqual([1, 2, 3]);
  });

  it("should respect max concurrency", async () => {
    const pool = new PromisePool(2);

    let concurrent = 0;
    let maxConcurrent = 0;

    const tasks = [1, 2, 3, 4].map((num) =>
      pool.add(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent--;
        return num;
      })
    );

    const resolved = await Promise.all(tasks);
    expect(resolved).toEqual([1, 2, 3, 4]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("should handle tasks that reject", async () => {
    const pool = new PromisePool(3);

    const task1 = pool.add(async () => "ok");
    const task2 = pool.add(async () => {
      throw new Error("task failed");
    });
    const task3 = pool.add(async () => "also ok");

    await expect(task1).resolves.toBe("ok");
    await expect(task2).rejects.toThrow("task failed");
    await expect(task3).resolves.toBe("also ok");
  });

  it("should pass abort signal to promise generator", async () => {
    const pool = new PromisePool(2);

    const result = await pool.add(async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return "signal received";
    });

    expect(result).toBe("signal received");
  });

  it("should abort a task that exceeds the pool timeout", async () => {
    const pool = new PromisePool(1, 50);

    await expect(
      pool.add(() => new Promise((resolve) => setTimeout(resolve, 500))),
    ).rejects.toThrow("Promise cancelled due to timeout");
  });
});
