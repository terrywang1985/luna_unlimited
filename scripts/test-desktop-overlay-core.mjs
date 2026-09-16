import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DesktopService } from "../src/core/desktop.mjs";
import { ScreenVisionOverlay } from "../src/core/screen-vision.mjs";

if (process.platform !== "win32") {
  console.log("desktop overlay core tests skipped (Windows only)");
  process.exit(0);
}

const activity = [];
const fakeOverlay = {
  show(mode, point, label) { activity.push({ type: "show", mode, point, label }); return true; },
  hide(delayMs = 0) { activity.push({ type: "hide", delayMs }); }
};
const fakeProcess = async () => ({
  timedOut: false,
  exitCode: 0,
  stderr: "",
  stdoutTruncated: false,
  stdout: JSON.stringify({ ok: true, width: 100, height: 50, mime_type: "image/jpeg", data_url: "data:image/jpeg;base64,/9j/2Q==" })
});
const desktop = new DesktopService({ enabled: true, overlay: fakeOverlay, runProcess: fakeProcess });

await desktop.execute({ operation: "windows" });
assert.deepEqual(activity.splice(0), [
  { type: "show", mode: "observe", point: null, label: "桌面读取" },
  { type: "hide", delayMs: 450 }
]);

await desktop.execute({ operation: "click", x: 120, y: 240, button: "left" });
assert.deepEqual(activity.splice(0), [
  { type: "show", mode: "control", point: { x: 120, y: 240 }, label: "桌面控制" },
  { type: "hide", delayMs: 450 }
]);

await desktop.execute({ operation: "screenshot", max_width: 640, quality: 70 }, { activityOverlay: false });
assert.deepEqual(activity, []);

const stateFile = join(tmpdir(), `luna-overlay-test-${process.pid}.json`);
let kills = 0;
const child = new EventEmitter();
child.exitCode = null;
child.kill = () => { kills += 1; child.exitCode = 0; };
child.unref = () => {};
const overlay = new ScreenVisionOverlay({
  enabled: true,
  helperPath: "fake.ps1",
  stateFile,
  spawnProcess: () => child
});
overlay.show("observe", null, "桌面读取");
overlay.hide(30);
overlay.show("control", { x: 10, y: 20 }, "桌面控制");
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(kills, 0, "a new desktop action must cancel the previous delayed hide");
assert.equal(existsSync(stateFile), true);
overlay.hide();
assert.equal(kills, 1);
assert.equal(existsSync(stateFile), false);

console.log("desktop overlay core tests passed");
