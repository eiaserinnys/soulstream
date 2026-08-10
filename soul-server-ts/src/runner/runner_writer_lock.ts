import { open, unlink, type FileHandle } from "node:fs/promises";

export class RunnerWriterLock {
  private constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async acquire(path: string, pid = process.pid): Promise<RunnerWriterLock> {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`runner writer lock already held: ${path}`);
      }
      throw error;
    }
    try {
      await handle.writeFile(`${pid}\n`);
      await handle.sync();
      return new RunnerWriterLock(path, handle);
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => {});
      throw error;
    }
  }

  async release(): Promise<void> {
    await this.handle.close();
    try {
      await unlink(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
