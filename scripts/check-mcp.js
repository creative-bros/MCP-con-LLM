const endpoint = process.argv[2];

if (!endpoint) {
  throw new Error(
    "Usa: node scripts/check-mcp.js http://127.0.0.1:3000/mcp o node scripts/check-mcp.js http://127.0.0.1:3000/mcp/TU_WORKSPACE_KEY/TU_PROJECT_KEY",
  );
}

async function post(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const init = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "check", version: "1.0.0" },
  },
});

const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });

console.log(`Servidor: ${init.result.serverInfo.title}`);
console.log(`Tools: ${list.result.tools.map((tool) => tool.name).join(", ") || "ninguna"}`);
console.log("MCP OK");
