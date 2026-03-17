import * as fs from "node:fs";
import * as path from "node:path";

export class PIDManager {
  private pidPath: string;

  constructor(baseDir: string, pidFile: string = "motiva.pid") {
    this.pidPath = path.join(baseDir, pidFile);
  }

  /** Write current process PID to file (atomic write) */
  writePID(): void {
    const info = {
      pid: process.pid,
      started_at: new Date().toISOString(),
    };
    const tmpPath = this.pidPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.pidPath);
  }

  /** Read PID from file. Returns null if file doesn't exist or is invalid */
  readPID(): { pid: number; started_at: string } | null {
    try {
      if (!fs.existsSync(this.pidPath)) return null;
      const content = fs.readFileSync(this.pidPath, "utf-8");
      const data = JSON.parse(content);
      if (typeof data.pid !== "number") return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Check if a process with the stored PID is actually running */
  isRunning(): boolean {
    const info = this.readPID();
    if (!info) return false;
    try {
      // signal 0 doesn't kill, just checks if process exists
      process.kill(info.pid, 0);
      return true;
    } catch {
      // Process doesn't exist - stale PID file
      return false;
    }
  }

  /** Remove PID file */
  cleanup(): void {
    try {
      if (fs.existsSync(this.pidPath)) {
        fs.unlinkSync(this.pidPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /** Get the PID file path */
  getPath(): string {
    return this.pidPath;
  }
}
