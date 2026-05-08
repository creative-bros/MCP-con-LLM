function settingsError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function apiToolDefinitions(store, userId) {
  return store.getTools(userId).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: [
        tool.description || tool.title || tool.name,
        tool.outputExample ? `Salida esperada: ${tool.outputExample}` : "",
      ].filter(Boolean).join("\n\n"),
      parameters: tool.inputSchema,
    },
  }));
}

function databaseToolDefinitions(store, userId) {
  return store.getDatabases(userId).map((database) => ({
    type: "function",
    function: {
      name: database.toolName,
      description: [
        `Consulta la base del proyecto "${database.title || database.name}".`,
        database.documentation ? `Documentacion: ${database.documentation}` : "",
        database.rules ? `Reglas: ${database.rules}` : "",
        "Usa SQL read-only. Solo SELECT/WITH.",
      ].filter(Boolean).join("\n\n"),
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Pregunta natural del usuario" },
          sql: { type: "string", description: "SQL read-only a ejecutar" },
        },
        additionalProperties: false,
      },
    },
  }));
}

function resourceToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "listarArchivosProyecto",
        description:
          "Lista los archivos, notas, codigo y contexto cargado en el proyecto. Usa esta tool cuando el usuario mencione archivos o documentos.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Filtro opcional por nombre o descripcion" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "verArchivoProyecto",
        description: "Abre el contenido completo de un archivo o nota del proyecto.",
        parameters: {
          type: "object",
          properties: {
            resourceId: { type: "string" },
            name: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "actividadProyecto",
        description: "Consulta la actividad reciente del proyecto para validar cambios.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number" },
          },
          additionalProperties: false,
        },
      },
    },
  ];
}

function managementToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "configurarProyectoActual",
        description: "Actualiza nombre, descripcion, contexto o URL base del proyecto actual.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            context: { type: "string" },
            apiBaseUrl: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "crearBaseProyecto",
        description:
          "Crea o actualiza una base de datos logica del proyecto para trabajar desde ChatGPT. " +
          "Usa modo internal si el usuario quiere una base interna dentro del portal.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            documentation: { type: "string" },
            rules: { type: "string" },
            toolName: { type: "string" },
            mode: { type: "string" },
            sqlApiUrl: { type: "string" },
            mysql: { type: "object", additionalProperties: true },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "crearTablaProyecto",
        description: "Crea o actualiza una tabla interna del proyecto.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            rules: { type: "string" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  label: { type: "string" },
                  type: { type: "string" },
                  required: { type: "boolean" },
                  description: { type: "string" },
                },
                required: ["name", "label", "type", "required"],
                additionalProperties: false,
              },
            },
          },
          required: ["name", "fields"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listarTablasProyecto",
        description: "Lista las tablas internas del proyecto con sus campos y conteos.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "crearRegistroProyecto",
        description: "Crea un registro dentro de una tabla interna del proyecto.",
        parameters: {
          type: "object",
          properties: {
            tableName: { type: "string" },
            data: { type: "object", additionalProperties: true },
          },
          required: ["tableName", "data"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listarRegistrosProyecto",
        description: "Lista o busca registros dentro de una tabla interna del proyecto.",
        parameters: {
          type: "object",
          properties: {
            tableName: { type: "string" },
            rowId: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["tableName"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "actualizarRegistroProyecto",
        description: "Actualiza un registro ya creado dentro de una tabla interna del proyecto.",
        parameters: {
          type: "object",
          properties: {
            tableName: { type: "string" },
            rowId: { type: "string" },
            data: { type: "object", additionalProperties: true },
          },
          required: ["tableName", "rowId", "data"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "eliminarRegistroProyecto",
        description: "Elimina un registro de una tabla interna del proyecto.",
        parameters: {
          type: "object",
          properties: {
            tableName: { type: "string" },
            rowId: { type: "string" },
          },
          required: ["tableName", "rowId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "registrarToolProyecto",
        description: "Registra una API HTTP del proyecto para usarla desde ChatGPT.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            method: { type: "string" },
            url: { type: "string" },
            inputSchema: { type: "object", additionalProperties: true },
            outputSchema: { type: "object", additionalProperties: true },
            outputExample: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            bodyTemplate: { type: "object", additionalProperties: true },
            readOnly: { type: "boolean" },
          },
          required: ["name", "method", "url"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "registrarBaseProyecto",
        description: "Guarda una base MySQL, SQL HTTP o documentacion de base para el proyecto.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            toolName: { type: "string" },
            mode: { type: "string" },
            sqlApiUrl: { type: "string" },
            documentation: { type: "string" },
            rules: { type: "string" },
            mysql: { type: "object", additionalProperties: true },
            host: { type: "string" },
            port: { type: "number" },
            user: { type: "string" },
            password: { type: "string" },
            database: { type: "string" },
          },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "guardarArchivoProyecto",
        description: "Guarda codigo, SQL, documentacion o notas dentro del proyecto actual.",
        parameters: {
          type: "object",
          properties: {
            resourceId: { type: "string" },
            name: { type: "string" },
            kind: { type: "string" },
            description: { type: "string" },
            mimeType: { type: "string" },
            content: { type: "string" },
          },
          required: ["name", "content"],
          additionalProperties: false,
        },
      },
    },
  ];
}

async function openAiChat(settings, body) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw settingsError(json.error?.message || `OpenAI HTTP ${response.status}`, response.status);
  }
  return json.choices?.[0]?.message;
}

export function aiStatus(store, userId) {
  const settings = store.getSettings(userId);
  return {
    configured: Boolean(settings.openaiApiKey),
    model: settings.openaiModel,
    keyPreview: settings.openaiApiKey
      ? `${settings.openaiApiKey.slice(0, 7)}...${settings.openaiApiKey.slice(-4)}`
      : "",
  };
}

export async function runAiCommand(store, userId, text) {
  const settings = store.getSettings(userId);
  if (!settings.openaiApiKey) {
    throw settingsError("Primero guarda tu propia OpenAI API key en Configuracion IA.");
  }

  const state = store.getState(userId, "https://portal.local");
  const tools = [
    ...apiToolDefinitions(store, userId),
    ...databaseToolDefinitions(store, userId),
    ...managementToolDefinitions(),
    ...resourceToolDefinitions(),
  ];
  if (!tools.length) {
    throw settingsError("Primero registra una tool, una base, crea una tabla o carga la demo.");
  }

  const messages = [
    {
      role: "system",
      content:
        `Eres un asistente operativo conectado al proyecto "${state.project?.title || "Proyecto"}". ` +
        `${state.project?.description || ""} ${state.project?.context || ""}`.trim() +
        " Clasifica la solicitud del usuario como accion, consulta, visualizacion o ayuda. " +
        "Cuando el usuario pida una accion disponible, llama exactamente la function tool correcta. " +
        "Antes de decir que algo no se puede hacer, revisa si puedes resolverlo con crearBaseProyecto, crearTablaProyecto, listarTablasProyecto, crearRegistroProyecto, listarRegistrosProyecto, actualizarRegistroProyecto, eliminarRegistroProyecto, registrarToolProyecto, registrarBaseProyecto o guardarArchivoProyecto. " +
        "Si la solicitud implica consultar o visualizar datos del sistema, puedes usar tools de base con SQL read-only o tools read-only. " +
        "Si el usuario pide configurar el proyecto, crear tablas, registrar APIs o guardar codigo/documentacion, usa las tools de gestion del proyecto. " +
        "Si el usuario pide crear una base de datos interna y una tabla en la misma instruccion, puedes ejecutar varias tools en secuencia para dejarlo listo. " +
        "Si el usuario menciona archivos, codigo, SQL, layouts o documentos cargados en el proyecto, usa primero listarArchivosProyecto y luego verArchivoProyecto. " +
        "Si faltan datos requeridos, responde pidiendolos en espanol. " +
        "Si el usuario quiere ver algo, resume el resultado de forma clara y ordenada.",
    },
    { role: "user", content: text },
  ];

  const first = await openAiChat(settings, {
    model: settings.openaiModel,
    messages,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
  });

  const calls = first?.tool_calls || [];
  if (!calls.length) {
    return {
      reply: first?.content || "No hubo accion para ejecutar.",
      toolCalls: [],
    };
  }

  const toolMessages = [];
  const results = [];

  for (const call of calls) {
    const name = call.function?.name;
    const args = JSON.parse(call.function?.arguments || "{}");
    const result = await store.callOperation(userId, name, args);
    results.push({ name, arguments: args, result });
    toolMessages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
  }

  const final = await openAiChat(settings, {
    model: settings.openaiModel,
    messages: [...messages, first, ...toolMessages],
  });

  return {
    reply: final?.content || "Accion ejecutada.",
    toolCalls: results,
  };
}

export async function buildTableFromPrompt(store, userId, baseUrl, prompt) {
  const settings = store.getSettings(userId);
  if (!settings.openaiApiKey) {
    throw settingsError("Guarda primero la API key del desarrollador para usar el creador con IA.");
  }

  const state = store.getState(userId, baseUrl || "https://portal.local");

  const message = await openAiChat(settings, {
    model: settings.openaiModel,
    messages: [
      {
        role: "system",
        content:
          "Convierte la solicitud del desarrollador en una definicion de tabla para un portal MCP. " +
          `El proyecto actual se llama "${state.project?.title || "Proyecto"}". ` +
          `${state.project?.description || ""} ${state.project?.context || ""}`.trim() +
          " Piensa en una tabla util para altas desde chat. Usa nombres claros, campos concretos y reglas operativas.",
      },
      { role: "user", content: prompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "define_table",
          description: "Define una tabla interna con sus campos y reglas.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Nombre tecnico de la tabla" },
              title: { type: "string", description: "Titulo visible de la tabla" },
              description: { type: "string", description: "Descripcion corta" },
              rules: { type: "string", description: "Reglas de negocio o significados especiales" },
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
                  },
                  required: ["name", "label", "type", "required"],
                  additionalProperties: false,
                },
              },
            },
            required: ["name", "title", "fields"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "define_table" } },
    parallel_tool_calls: false,
  });

  const call = message?.tool_calls?.[0];
  if (!call?.function?.arguments) {
    throw settingsError("No pude convertir la instruccion en una tabla.");
  }

  const definition = JSON.parse(call.function.arguments);
  const table = store.saveTable(userId, definition);
  return {
    message: `Tabla ${table.title} creada con ${table.fields.length} campos.`,
    table,
  };
}
