import { runAgent } from "../src/agent/agent.ts";
import { buildFixture } from "./fixture.ts";

const dbPath = process.argv[2]!;
const crashAfter = Number(process.argv[3] ?? 0);
const fixture = buildFixture();
await runAgent({ dbPath, ...fixture, crashAfter: crashAfter > 0 ? crashAfter : undefined });
