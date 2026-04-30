const protocolVersion = "2025-06-18";

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function apiToolToMcp(tool) {
  return {
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title || tool.name,
      readOnlyHint: Boolean(tool.readOnly),
      destructiveHint: !tool.readOnly,
      idempotentHint: Boolean(tool.readOnly),
      openWorldHint: true,
    },
  };
}

function databaseToolToMcp(database) {
  return {
    name: database.toolName,
    title: database.title || database.name,
    description:
      `Consulta documentada de base de datos.\n\nDocumentacion:\n${database.documentation}\n\nReglas:\n${database.rules}\n\n` +
      "Usa esta tool para pedir o ejecutar SQL read-only. Solo SELECT/WITH.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Pregunta natural del usuario" },
        sql: { type: "string", description: "SQL read-only opcional" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: database.title || database.name,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function mcpContent(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: typeof value === "object" ? value : { text },
    isError,
  };
}

function assertReadOnly(sql) {
  const value = String(sql || "").trim();
  if (!value) return "";
  if (!/^(select|with)\b/i.test(value)) {
    throw new Error("Solo se permite SQL de lectura: SELECT/WITH.");
  }
  if (/(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(value)) {
    throw new Error("SQL bloqueado por seguridad.");
  }
  return value;
}

export function listMcpTools(store, userId) {
  return [
    ...store.getTools(userId).map(apiToolToMcp),
    ...store.getDatabases(userId).map(databaseToolToMcp),
  ];
}

export async function handleMcpMessage(store, userId, message) {
  if (!message || message.jsonrpc !== "2.0" || !message.method) {
    return jsonError(message?.id, -32600, "Invalid JSON-RPC request");
  }

  if (message.method === "notifications/initialized") return null;

  if (message.method === "initialize") {
    return jsonRpc(message.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: {
        name: "legacy-mcp-portal",
        title: "Legacy MCP Portal",
        version: "2.0.0",
      },
      instructions:
        "Usa estas tools para ejecutar acciones y consultar la base interna o legacy del desarrollador. Para acciones de escritura, pide confirmacion al usuario.",
    });
  }

  if (message.method === "tools/list") {
    return jsonRpc(message.id, { tools: listMcpTools(store, userId) });
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    if (!name) return jsonError(message.id, -32602, "Falta params.name");

    const databases = store.getDatabases(userId);
    const database = databases.find((item) => item.toolName === name);

    if (database) {
      try {
        const sql = assertReadOnly(args.sql);
        if (!database.sqlApiUrl || !sql) {
          return jsonRpc(
            message.id,
            mcpContent({
              ok: true,
              executed: false,
              documentation: database.documentation,
              rules: database.rules,
              question: args.question || "",
              note: "No se ejecuto SQL. Agrega sql o configura sqlApiUrl.",
            }),
          );
        }

        const response = await fetch(database.sqlApiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql }),
        });
        const result = await response.json();
        return jsonRpc(message.id, mcpContent({ ok: response.ok, sql, result }, !response.ok));
      } catch (err) {
        return jsonRpc(message.id, mcpContent({ ok: false, error: err.message }, true));
      }
    }

    try {
      const result = await store.callTool(userId, name, args);
      return jsonRpc(message.id, mcpContent(result, !result.ok));
    } catch (err) {
      return jsonRpc(message.id, mcpContent({ ok: false, error: err.message }, true));
    }
  }

  return jsonError(message.id, -32601, `Metodo no soportado: ${message.method}`);
}
