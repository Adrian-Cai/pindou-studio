const assert = require("node:assert/strict");
const test = require("node:test");
const { createHttpApplication } = require("../dist/http/app.js");
const { startHttpServer } = require("../dist/http/server.js");

function dependencies(database) {
  return {
    database,
    auth: { async login() { throw new Error("unused"); } },
    authenticator: { async authenticate() { throw new Error("unused"); } },
    users: { async getCurrentUser() { throw new Error("unused"); } },
  };
}

async function withServer(database, callback) {
  const running = await startHttpServer(
    createHttpApplication(dependencies(database)),
    "127.0.0.1",
    0,
  );
  try {
    await callback(`http://127.0.0.1:${running.port}`);
  } finally {
    await running.close();
  }
}

test("GET /health reports a healthy database and exposes no connection string", async () => {
  await withServer(
    {
      async check() {
        return {
          status: "up",
          product: "PostgreSQL",
          version: "17.11",
          schemaStatus: "valid",
        };
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.status, "ok");
      assert.equal(body.database.status, "up");
      assert.match(response.headers.get("x-request-id"), /^req_[a-f0-9]{32}$/);
      assert.doesNotMatch(JSON.stringify(body), /DB_PASSWORD|postgresql:\/\//i);
    },
  );
});

test("GET /health returns 503 when the database is unavailable", async () => {
  await withServer(
    { async check() { throw new Error("database unavailable"); } },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.status, "degraded");
      assert.deepEqual(body.database, { status: "down" });
    },
  );
});

test("unknown routes use the API error contract", async () => {
  await withServer(
    { async check() { throw new Error("unused"); } },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/not-implemented`);
      const body = await response.json();
      assert.equal(response.status, 404);
      assert.equal(body.error.code, "NOT_FOUND");
      assert.equal(body.error.requestId, response.headers.get("x-request-id"));
      assert.deepEqual(body.error.details, {});
    },
  );
});
