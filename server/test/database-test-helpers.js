/** 供服务端单测复用的轻量 PostgreSQL Pool 桩。 */
function clientPool(handler) {
  const calls = [];
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return handler(sql, parameters, calls);
    },
    release() {},
  };
  return {
    calls,
    async connect() { return client; },
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      return handler(sql, parameters, calls);
    },
  };
}

module.exports = { clientPool };
