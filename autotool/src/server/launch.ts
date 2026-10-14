// For autotool.sh: the saved page key, the data folder (for the log) and the fingerprint the server's
// /api/ping reports for a robot repo, one per line. Usage: node launch.ts <robot repo>
import { realpathSync } from "node:fs";
import { configDir, sessionToken, sha256 } from "./store.ts";

const repo = realpathSync(process.argv[2] ?? "."); // as RobotRepo.open resolves it
process.stdout.write(`${sessionToken()}\n${configDir()}\n${sha256(repo).slice(0, 16)}\n`);
