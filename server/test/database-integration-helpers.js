const { loadLocalEnv, readConfig } = require("../dist/config/env.js");
const { createPool } = require("../dist/db/pool.js");

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1";

function createIntegrationDatabase() {
  loadLocalEnv();
  const config = readConfig();
  return { config, pool: createPool(config.database) };
}

module.exports = { enabled, createIntegrationDatabase };
