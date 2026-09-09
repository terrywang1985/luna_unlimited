import http from "node:http";
import assert from "node:assert/strict";

import { ScreenVisionService, parseGroundingPoint } from "../src/core/screen-vision.mjs";

assert.deepEqual(parseGroundingPoint("[0.25, 0.75]"), { x: 0.25, y: 0.75 });
assert.deepEqual(parseGroundingPoint("(0.1,0.9)"), { x: 0.1, y: 0.9 });

const calls = [];
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
    res.end(JSON.stringify({ data: [{ id: "showui-2b", capabilities: ["text", "image"] }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.messages[0].content[1].type, "image_url");
    assert.equal(payload.messages[0].content[2].text, "程序包");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "[0.25, 0.75]" } }] }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise((resolve) => server.listen(18889, "127.0.0.1", resolve));
try {
  const eyes = new ScreenVisionService({ desktop, endpoint: "http://127.0.0.1:18889/v1/chat/completions", model: "showui-2b" });
  const status = await eyes.status();
  assert.equal(status.structured.available, true);
  const found = await eyes.find({ query: "程序包", hwnd: "123" });
  assert.deepEqual(found.structured.screen, { x: 600, y: 800 });
  const clicked = await eyes.click({ query: "程序包", hwnd: "123" });
  assert.equal(clicked.structured.clicked, true);
  assert.deepEqual(calls.at(-1), { operation: "click", x: 600, y: 800, button: "left" });
  console.log("screen vision core tests passed");
} finally {
  server.close();
}
