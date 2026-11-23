const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { server } = require("../server.js");

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    // Raw path: http.get would normalise "//" away from the request line otherwise.
    const req = http.request({ port, host: "127.0.0.1", path, headers, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
  });

test("server", async (t) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  t.after(() => server.close());

  await t.test("GET // returns 400 and the server stays up", async () => {
    assert.strictEqual((await get(port, "//")).statusCode, 400);
    assert.strictEqual((await get(port, "/")).statusCode, 200);
  });

  await t.test("unknown Host is rejected, allowed hosts pass", async () => {
    assert.strictEqual((await get(port, "/", { Host: "evil.example.com" })).statusCode, 403);
    assert.strictEqual((await get(port, "/", { Host: "homepi.tail2970c8.ts.net:3000" })).statusCode, 200);
    assert.strictEqual((await get(port, "/", { Host: "[::1]:3000" })).statusCode, 200);
    process.env.ALLOWED_HOSTS = "deck.example.com";
    assert.strictEqual((await get(port, "/", { Host: "deck.example.com" })).statusCode, 200);
    delete process.env.ALLOWED_HOSTS;
  });

  await t.test("HOMEDECK_TOKEN enforces auth via header, cookie or ?token=", async () => {
    process.env.HOMEDECK_TOKEN = "s3cret";
    assert.strictEqual((await get(port, "/")).statusCode, 401);
    assert.strictEqual((await get(port, "/", { Authorization: "Bearer wrong" })).statusCode, 401);
    assert.strictEqual((await get(port, "/", { Authorization: "Bearer s3cret" })).statusCode, 200);
    assert.strictEqual((await get(port, "/", { Cookie: "homedeck_token=s3cret" })).statusCode, 200);
    const login = await get(port, "/?token=s3cret");
    assert.strictEqual(login.statusCode, 302);
    assert.match(login.headers["set-cookie"][0], /^homedeck_token=s3cret; HttpOnly/);
    delete process.env.HOMEDECK_TOKEN;
  });
});
