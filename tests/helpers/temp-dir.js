import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
export function makeTempDir(prefix = "pulseed-test-") {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
export function cleanupTempDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
//# sourceMappingURL=temp-dir.js.map
