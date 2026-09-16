import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { ScreenVisionService, parseGroundingPoint } from "../src/core/screen-vision.mjs";

assert.deepEqual(parseGroundingPoint("<ref>target</ref><box><250><750></box>"), { x: 0.25, y: 0.75 });
assert.deepEqual(parseGroundingPoint("<ref>target</ref><box><100><200><300><600></box>"), { x: 0.2, y: 0.4 });

const calls = [];
const overlayEvents = [];
const overlay = {
  show(mode, point = null, label = "Luna Eyes") { overlayEvents.push({ type: "show", mode, point, label }); return true; },
  hide() { overlayEvents.push({ type: "hide" }); },
  status() { return { enabled: true, visible: false, mode: "hidden", helper: "test", error: null }; }
};
const desktop = {
  async execute(request) {
    calls.push(request);
    if (request.operation === "screenshot") {
      return {
        structured: {
          data_url: "data:image/jpeg;base64,/9j/2Q==",
          width: 1000,
          height: 500,
          source_x: 100,
          source_y: 50,
          source_width: 2000,
          source_height: 1000
        }
      };
    }
    if (request.operation === "click") return { structured: { ok: true, ...request } };
    throw new Error(`unexpected desktop op ${request.operation}`);
  }
};

const tempPaths = [];
const detect = async ({ imagePath, prompt, mode }) => {
  assert.equal(prompt, "Locate all the instances that matches the following description: 程序包.");
  assert.equal(mode, "hybrid");
  assert.equal(existsSync(imagePath), true);
  tempPaths.push(imagePath);
  return { detections: [{ label: "程序包", box: [200, 350, 300, 400] }] };
};

try {
  const eyes = new ScreenVisionService({ desktop, model: "locate-anything-q6_k", overlay, detect });
  const status = await eyes.status();
  assert.equal(status.structured.available, true);
  assert.equal(status.structured.backend, "locate-anything.cpp-cli");
  assert.equal(status.structured.overlay.enabled, true);
  const found = await eyes.find({ query: "程序包", hwnd: "123" });
  assert.deepEqual(found.structured.screen, { x: 600, y: 800 });
  assert.deepEqual(found.structured.screen_box, { x1: 500, y1: 750, x2: 700, y2: 850 });
  assert.equal(found.structured.label, "程序包");
  assert.equal(existsSync(tempPaths.at(-1)), false);
  assert.deepEqual(overlayEvents.splice(0), [
    { type: "show", mode: "observe", point: null, label: "locate-anything-q6_k" },
    { type: "hide" }
  ]);
  const clicked = await eyes.click({ query: "程序包", hwnd: "123" });
  assert.equal(clicked.structured.clicked, true);
  assert.deepEqual(calls.at(-1), { operation: "click", x: 600, y: 800, button: "left" });
  assert.equal(existsSync(tempPaths.at(-1)), false);
  assert.deepEqual(overlayEvents, [
    { type: "show", mode: "observe", point: null, label: "locate-anything-q6_k" },
    { type: "show", mode: "control", point: { x: 600, y: 800 }, label: "locate-anything-q6_k" },
    { type: "hide" }
  ]);
  console.log("screen vision core tests passed");
} finally {
  for (const path of tempPaths) assert.equal(existsSync(path), false);
}
