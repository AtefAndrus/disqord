import packageJson from "../package.json";
import { loadReleaseNotes, parseVersion } from "../src/services/releaseNotes";

const target = process.argv[2] ?? packageJson.version;
const version = parseVersion(target);
const notes = await loadReleaseNotes(process.argv[3]);
if (!version || notes?.section(version)?.status !== "ok") {
  console.error(`Release ${target}: CHANGELOG must contain exactly one valid section`);
  process.exitCode = 1;
} else {
  console.info(`Release ${target}: CHANGELOG section is valid`);
}
