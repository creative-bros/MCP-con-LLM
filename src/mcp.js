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

function resourceListToolToMcp() {
  return {
    name: "listarArchivosProyecto",
    title: "Listar archivos del proyecto",
    description:
      "Lista los archivos, notas, codigo, SQL o contexto cargado dentro del proyecto. " +
      "Usa esta tool cuando el usuario mencione un archivo, documento, layout, script, consulta o quiera saber que material esta disponible.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Filtro opcional para buscar por nombre, tipo o descripcion",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Listar archivos del proyecto",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function resourceReadToolToMcp() {
  return {
    name: "verArchivoProyecto",
    title: "Abrir archivo del proyecto",
    description:
      "Abre el contenido completo de un archivo o nota del proyecto. " +
      "Usa esta tool cuando el usuario pida revisar, entender, resumir o ejecutar algo a partir de un archivo cargado.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "ID del archivo o nota" },
        name: { type: "string", description: "Nombre del archivo o nota" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Abrir archivo del proyecto",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function projectActivityToolToMcp() {
  return {
    name: "actividadProyecto",
    title: "Actividad del proyecto",
    description:
      "Devuelve las operaciones recientes del proyecto: altas, ediciones, eliminaciones, consultas y archivos cargados. " +
      "Usa esta tool cuando el usuario quiera ver que se hizo o validar que una accion ya quedo reflejada en el sistema.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Cantidad maxima de eventos a devolver" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Actividad del proyecto",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

function projectConfigToolToMcp() {
  return {
    name: "configurarProyectoActual",
    title: "Configurar proyecto actual",
    description:
      "Actualiza la configuracion operativa del proyecto actual: nombre, descripcion, contexto para ChatGPT o URL base del sistema. " +
      "Usa esta tool cuando el usuario pida ajustar reglas, contexto, endpoints base o identidad del proyecto.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Nombre visible del proyecto" },
        name: { type: "string", description: "Nombre tecnico del proyecto" },
        description: { type: "string", description: "Descripcion del sistema" },
        context: { type: "string", description: "Indicaciones operativas para ChatGPT" },
        apiBaseUrl: { type: "string", description: "URL base opcional del sistema" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Configurar proyecto actual",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function tableCreateToolToMcp() {
  return {
    name: "crearTablaProyecto",
    title: "Crear tabla del proyecto",
    description:
      "Crea o actualiza una tabla interna del proyecto. " +
      "Usa esta tool cuando el usuario pida crear una base interna, una entidad nueva o una estructura para altas desde ChatGPT.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre tecnico de la tabla" },
        title: { type: "string", description: "Nombre visible de la tabla" },
        description: { type: "string", description: "Descripcion corta" },
        rules: { type: "string", description: "Reglas especiales o significados de campos" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              type: {
                type: "string",
                enum: ["string", "number", "boolean", "email", "phone", "date", "integer"],
              },
              required: { type: "boolean" },
              description: { type: "string" },
              enum: { type: "array", items: { type: "string" } },
              defaultValue: {},
            },
            required: ["name", "label", "type", "required"],
            additionalProperties: false,
          },
        },
      },
      required: ["name", "fields"],
      additionalProperties: false,
    },
    annotations: {
      title: "Crear tabla del proyecto",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function tableDeleteToolToMcp() {
  return {
    name: "eliminarTablaProyecto",
    title: "Eliminar tabla del proyecto",
    description: "Elimina una tabla interna y sus tools autogeneradas del proyecto actual.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre tecnico de la tabla" },
        tableName: { type: "string", description: "Alias del nombre tecnico" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Eliminar tabla del proyecto",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function toolRegisterToolToMcp() {
  return {
    name: "registrarToolProyecto",
    title: "Registrar API del proyecto",
    description:
      "Registra o actualiza una tool API del proyecto, incluyendo metodo, URL, schema de entrada y salida esperada. " +
      "Usa esta tool cuando el usuario quiera conectar endpoints legacy como agregaCliente o emiteFactura.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre MCP de la tool" },
        title: { type: "string", description: "Titulo visible" },
        description: { type: "string", description: "Que hace la API" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
          description: "Metodo HTTP",
        },
        url: { type: "string", description: "URL absoluta o ruta relativa si ya existe apiBaseUrl" },
        headers: { type: "object", description: "Headers opcionales", additionalProperties: { type: "string" } },
        bodyTemplate: { type: "object", description: "Plantilla JSON opcional para el body" },
        inputSchema: { type: "object", description: "Schema JSON de entrada", additionalProperties: true },
        outputSchema: { type: "object", description: "Schema JSON de salida", additionalProperties: true },
        outputExample: { type: "string", description: "Ejemplo de salida" },
        readOnly: { type: "boolean", description: "Marca si la API solo consulta" },
      },
      required: ["name", "method", "url"],
      additionalProperties: false,
    },
    annotations: {
      title: "Registrar API del proyecto",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function toolDeleteToolToMcp() {
  return {
    name: "eliminarToolProyecto",
    title: "Eliminar API del proyecto",
    description: "Elimina una tool API registrada en el proyecto actual.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre MCP de la tool" },
        toolName: { type: "string", description: "Alias del nombre MCP" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Eliminar API del proyecto",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function databaseRegisterToolToMcp() {
  return {
    name: "registrarBaseProyecto",
    title: "Registrar base del proyecto",
    description:
      "Guarda la configuracion de una base del proyecto, ya sea MySQL directa, SQL por HTTP o solo documentacion. " +
      "Usa esta tool cuando el usuario quiera documentar tablas legacy o conectar una base existente.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre tecnico de la base" },
        title: { type: "string", description: "Nombre visible de la base" },
        toolName: { type: "string", description: "Nombre de la tool SQL que se publicara" },
        mode: { type: "string", enum: ["mysql", "http", "docs", "internal"] },
        sqlApiUrl: { type: "string", description: "URL del endpoint SQL HTTP" },
        documentation: { type: "string", description: "Schema o documentacion util" },
        rules: { type: "string", description: "Reglas de negocio y significados" },
        mysql: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "number" },
            user: { type: "string" },
            password: { type: "string" },
            database: { type: "string" },
          },
          additionalProperties: false,
        },
        host: { type: "string" },
        port: { type: "number" },
        user: { type: "string" },
        password: { type: "string" },
        database: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      title: "Registrar base del proyecto",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function databaseDeleteToolToMcp() {
  return {
    name: "eliminarBaseProyecto",
    title: "Eliminar base del proyecto",
    description: "Elimina una base documentada del proyecto actual.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre tecnico de la base" },
        databaseName: { type: "string", description: "Alias del nombre tecnico" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Eliminar base del proyecto",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function resourceWriteToolToMcp() {
  return {
    name: "guardarArchivoProyecto",
    title: "Guardar archivo del proyecto",
    description:
      "Crea o actualiza un archivo, nota, SQL, codigo o documento textual dentro del proyecto. " +
      "Usa esta tool cuando el usuario quiera generar codigo, guardar reglas o subir contexto para que luego ChatGPT lo reconozca.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "ID del archivo si se desea actualizar" },
        id: { type: "string", description: "Alias de resourceId" },
        name: { type: "string", description: "Nombre del archivo o nota" },
        kind: { type: "string", description: "Tipo: archivo, documentacion, sql, codigo, nota o documento" },
        description: { type: "string", description: "Descripcion del contenido" },
        mimeType: { type: "string", description: "Mime type opcional" },
        content: { type: "string", description: "Contenido textual completo" },
      },
      required: ["name", "content"],
      additionalProperties: false,
    },
    annotations: {
      title: "Guardar archivo del proyecto",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function resourceDeleteToolToMcp() {
  return {
    name: "eliminarArchivoProyecto",
    title: "Eliminar archivo del proyecto",
    description: "Elimina un archivo o nota cargada en el proyecto actual.",
    inputSchema: {
      type: "object",
      properties: {
        resourceId: { type: "string", description: "ID del archivo" },
        name: { type: "string", description: "Nombre del archivo" },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Eliminar archivo del proyecto",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

function demoToolToMcp() {
  return {
    name: "cargarDemoProyecto",
    title: "Cargar demo del proyecto",
    description:
      "Carga una demo base con clientes, polizas y facturas para arrancar rapido. " +
      "Usa esta tool cuando el usuario quiera comenzar con un ejemplo funcional.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      title: "Cargar demo del proyecto",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
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
    "Si el usuario pide configurar el proyecto, crear tablas, registrar APIs, documentar una base o guardar codigo/archivos, usa las tools de configuracion del proyecto.",
    "Si el usuario menciona un archivo, documento, SQL, codigo o contexto cargado en el proyecto, usa listarArchivosProyecto y luego verArchivoProyecto.",
    "Si el usuario pide confirmar que ya se ejecuto algo o quiere ver cambios recientes, usa actividadProyecto.",
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
    projectConfigToolToMcp(),
    tableCreateToolToMcp(),
    tableDeleteToolToMcp(),
    toolRegisterToolToMcp(),
    toolDeleteToolToMcp(),
    databaseRegisterToolToMcp(),
    databaseDeleteToolToMcp(),
    resourceListToolToMcp(),
    resourceReadToolToMcp(),
    resourceWriteToolToMcp(),
    resourceDeleteToolToMcp(),
    projectActivityToolToMcp(),
    demoToolToMcp(),
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
        version: "2.2.0",
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
