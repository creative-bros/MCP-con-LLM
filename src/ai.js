function settingsError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getToolDefinitions(store, userId) {
  return store.getTools(userId).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.title || tool.name,
      parameters: tool.inputSchema,
    },
  }));
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

  const tools = getToolDefinitions(store, userId);
  if (!tools.length) {
    throw settingsError("Primero registra una tool, crea una tabla o carga la demo.");
  }

  const messages = [
    {
      role: "system",
      content:
        "Eres un asistente operativo conectado a un sistema legacy y a tablas internas. " +
        "Cuando el usuario pida una accion disponible, llama exactamente la function tool correcta. " +
        "No inventes datos requeridos; si faltan datos, responde pidiendolos en espanol.",
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
    const result = await store.callTool(userId, name, args);
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

  const message = await openAiChat(settings, {
    model: settings.openaiModel,
    messages: [
      {
        role: "system",
        content:
          "Convierte la solicitud del desarrollador en una definicion de tabla para un portal MCP. " +
          "Piensa en una tabla util para altas desde chat. Usa nombres claros, campos concretos y reglas operativas.",
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
  const table = store.saveTable(userId, definition, baseUrl);
  return {
    message: `Tabla ${table.title} creada con ${table.fields.length} campos.`,
    table,
  };
}
