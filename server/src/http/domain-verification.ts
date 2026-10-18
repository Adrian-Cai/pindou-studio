import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

const FILE_NAME = "3BvPmI4bqB.txt";
const DIRECTORY_PATHS = new Set([
  "/api/ai/text-generations",
  "/api/favorites",
  "/api/users/me",
  "/api/works",
  "/api/works/text-images",
  "/api/ai/text-generation-options",
  "/api/legal-documents/privacy-policy",
  "/api/legal-documents/user-agreement",
  "/api/auth/login",
]);
const FILE_CONTENT = readFileSync(resolve(__dirname, "../../domain-verification", FILE_NAME));

export function serveDomainVerificationFile(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): boolean {
  if (request.method !== "GET") return false;

  const suffix = `/${FILE_NAME}`;
  if (!url.pathname.endsWith(suffix)) return false;
  const directoryPath = url.pathname.slice(0, -suffix.length);
  if (!DIRECTORY_PATHS.has(directoryPath)) return false;

  response.statusCode = 200;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("content-length", FILE_CONTENT.length);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(FILE_CONTENT);
  return true;
}
