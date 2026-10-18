const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { resolve } = require("node:path");
const { serveDomainVerificationFile } = require("../dist/http/domain-verification.js");

const fileName = "3BvPmI4bqB.txt";
const directoryPaths = [
  "/api/ai/text-generations",
  "/api/favorites",
  "/api/users/me",
  "/api/works",
  "/api/works/text-images",
  "/api/ai/text-generation-options",
  "/api/legal-documents/privacy-policy",
  "/api/legal-documents/user-agreement",
  "/api/auth/login",
];

function createResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: undefined,
    headers,
    setHeader(name, value) { headers.set(name, value); },
    end(body) { this.body = body; },
  };
}

test("WeChat verification file is served below every reported API path", () => {
  const expectedContent = readFileSync(resolve(__dirname, "../domain-verification", fileName));

  for (const directoryPath of directoryPaths) {
    const response = createResponse();
    const url = new URL(`${directoryPath}/${fileName}`, "https://api.pindou.wiac.xyz");

    assert.equal(serveDomainVerificationFile({ method: "GET" }, response, url), true, directoryPath);
    assert.equal(response.statusCode, 200, directoryPath);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8", directoryPath);
    assert.deepEqual(response.body, expectedContent, directoryPath);
  }
});

test("verification response is limited to the exact file paths and GET method", () => {
  const reportedUrls = [
    "/api/ai/text-generations?active=true",
    "/api/favorites?page=1&pageSize=50",
    "/api/users/me",
    "/api/works?page=1&pageSize=50",
    "/api/works/text-images?page=1&pageSize=50",
    "/api/ai/text-generation-options",
    "/api/legal-documents/privacy-policy",
    "/api/legal-documents/user-agreement",
    "/api/auth/login",
  ];

  for (const path of reportedUrls) {
    const response = createResponse();
    const url = new URL(path, "https://api.pindou.wiac.xyz");
    assert.equal(serveDomainVerificationFile({ method: "GET" }, response, url), false, path);
  }

  const response = createResponse();
  const fileUrl = new URL(`${directoryPaths[0]}/${fileName}`, "https://api.pindou.wiac.xyz");
  assert.equal(serveDomainVerificationFile({ method: "POST" }, response, fileUrl), false);
});
