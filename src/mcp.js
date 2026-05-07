const protocolVersion = "2025-06-18";

function jsonRpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function apiToolToMcp(tool) {
  const outputHint = tool.outputExample
    ? `\n\nSalida esperada:\n${tool.outputExample}`
    : tool.outputSchema
      ? `\n\nSalida esperada:\n${JSON.stringify(tool.outputSchema, null, 2)}`
      : "";
  return {
    name: tool.name,
    title: tool.title || tool.name,
    description: `${tool.description || ""}${outputHint}`.trim(),
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

function guideToolToMcp() {
  return {
    name: "guiaProyecto",
    title: "Guia del proyecto",
    description:
      "Explica que puede hacer este proyecto, que puede consultar, como visualizar informacion y que datos faltan para ejecutar acciones. " +
      "Usa esta tool cuando el usuario pregunte que se puede hacer, como ver algo, o cuando necesites contexto antes de elegir otra tool.",
    inputSchema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: ["accion", "consulta", "visualizacion", "ayuda"],
          description: "Tipo de intencion del usuario",
        },
        question: {
          type: "string",
          description: "Pregunta o instruccion original del usuario",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Guia del proyecto",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function databaseToolToMcp(database) {
  const connectionHint = database.mode === "mysql"
    ? `Conexion MySQL directa a ${database.mysql?.host || "host no definido"}.`
    : database.mode === "http"
      ? `Consulta SQL por HTTP en ${database.sqlApiUrl || "sin URL"}.`
      : database.mode === "internal"
        ? "Consulta SQL sobre las tablas internas del proyecto."
        : "Solo documentacion y reglas.";
  return {
    name: database.toolName,
    title: database.title || database.name,
    description:
      `${connectionHint}\n\nDocumentacion:\n${database.documentation}\n\nReglas:\n${database.rules}\n\n` +
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

function initializeInstructions(store, userId, projectKey = "") {
  const guide = store.getProjectGuide(userId, projectKey, {});
  return [
    `Estas conectado al proyecto "${guide.project.title}".`,
    guide.project.description ? `Descripcion: ${guide.project.description}` : "",
    guide.project.context ? `Contexto operativo: ${guide.project.context}` : "",
    "Clasifica cada solicitud del usuario en una de estas intenciones: accion, consulta, visualizacion o ayuda.",
    "Si el usuario quiere realizar una accion, usa una tool de escritura y pide datos faltantes antes de ejecutar.",
    "Si el usuario quiere visualizar o revisar informacion, usa una tool read-only o una tool de base y luego presenta el resultado de forma clara.",
    "Si el usuario pregunta que se puede hacer o como ver algo, usa primero la tool guiaProyecto.",
    "Para SQL solo se permite SELECT/WITH.",
    "No inventes IDs, campos ni valores obligatorios.",
  ].filter(Boolean).join(" ");
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

export function listMcpTools(store, userId, projectKey = "") {
  return [
    guideToolToMcp(),
    ...store.getTools(userId, projectKey).map(apiToolToMcp),
    ...store.getDatabases(userId, projectKey).map(databaseToolToMcp),
  ];
}

export async function handleMcpMessage(store, userId, message, projectKey = "") {
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
        version: "2.1.0",
      },
      instructions: initializeInstructions(store, userId, projectKey),
    });
  }

  if (message.method === "tools/list") {
    return jsonRpc(message.id, { tools: listMcpTools(store, userId, projectKey) });
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments || {};
    if (!name) return jsonError(message.id, -32602, "Falta params.name");

    try {
      if (name === "guiaProyecto") {
        return jsonRpc(message.id, mcpContent(store.getProjectGuide(userId, projectKey, args)));
      }
      if (args.sql) args.sql = assertReadOnly(args.sql);
      const result = await store.callOperation(userId, name, args, projectKey);
      return jsonRpc(message.id, mcpContent(result, !result.ok));
    } catch (err) {
      return jsonRpc(message.id, mcpContent({ ok: false, error: err.message }, true));
    }
  }

  return jsonError(message.id, -32601, `Metodo no soportado: ${message.method}`);
}
