import http from "node:http";
import assert from "node:assert/strict";

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

const server = http.createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "locateanything-3b", capabilities: ["text", "image"] }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.messages[0].content[0].type, "image_url");
    assert.equal(payload.messages[0].content[1].text, "Point to: 程序包.");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "<ref>程序包</ref><box><250><750></box>" } }] }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise((resolve) => server.listen(18889, "127.0.0.1", resolve));
try {
  const eyes = new ScreenVisionService({ desktop, endpoint: "http://127.0.0.1:18889/v1/chat/completions", model: "locateanything-3b", overlay });
  const status = await eyes.status();
  assert.equal(status.structured.available, true);
  assert.equal(status.structured.overlay.enabled, true);
  const found = await eyes.find({ query: "程序包", hwnd: "123" });
  assert.deepEqual(found.structured.screen, { x: 600, y: 800 });
  assert.deepEqual(overlayEvents.splice(0), [
    { type: "show", mode: "observe", point: null, label: "locateanything-3b" },
    { type: "hide" }
  ]);
  const clicked = await eyes.click({ query: "程序包", hwnd: "123" });
  assert.equal(clicked.structured.clicked, true);
  assert.deepEqual(calls.at(-1), { operation: "click", x: 600, y: 800, button: "left" });
  assert.deepEqual(overlayEvents, [
    { type: "show", mode: "observe", point: null, label: "locateanything-3b" },
    { type: "show", mode: "control", point: { x: 600, y: 800 }, label: "locateanything-3b" },
    { type: "hide" }
  ]);
  console.log("screen vision core tests passed");
} finally {
  server.close();
}
