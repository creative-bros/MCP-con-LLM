import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const dataFile = path.join(process.cwd(), "data", "portal.json");
const defaultModel = "gpt-4.1-mini";

const initialData = {
  version: 2,
  users: [],
  sessions: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slug(value, fallback = "item") {
  const text = String(value || fallback)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return (text || fallback).slice(0, 64);
}

function json(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function keyPreview(value) {
  return value ? `${value.slice(0, 7)}...${value.slice(-4)}` : "";
}

function normalizeSchema(schema) {
  const value = json(schema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  return {
    type: "object",
    properties: value.properties || {},
    required: Array.isArray(value.required) ? value.required : [],
    additionalProperties: value.additionalProperties ?? false,
  };
}

function normalizeFields(fields) {
  const parsed = json(fields, []);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("Debes agregar al menos un campo.");
  }

  return parsed.map((field, index) => {
    const name = slug(field.name || field.label || `campo_${index + 1}`, `campo_${index + 1}`);
    const type = String(field.type || "string").toLowerCase();
    return {
      name,
      label: String(field.label || name),
      type,
      required: Boolean(field.required),
      description: String(field.description || ""),
      enum: Array.isArray(field.enum) ? field.enum.map((item) => String(item)) : undefined,
      defaultValue: field.defaultValue ?? "",
    };
  });
}

function schemaFromFields(fields) {
  const properties = {};
  const required = [];

  for (const field of fields) {
    const property = { description: field.description || field.label };
    if (field.type === "number" || field.type === "integer") property.type = "number";
    else if (field.type === "boolean") property.type = "boolean";
    else property.type = "string";
    if (field.enum?.length) property.enum = field.enum;
    properties[field.name] = property;
    if (field.required) required.push(field.name);
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function assertUrl(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("La URL debe iniciar con http:// o https://");
  }
  return String(url);
}

function renderTemplate(template, args) {
  if (template === undefined || template === null || template === "") return args;
  if (typeof template === "string") {
    return template.replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (_, key) => {
      const value = key.split(".").reduce((obj, part) => obj?.[part], args);
      return value === undefined || value === null ? "" : String(value);
    });
  }
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, args));
  if (typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, renderTemplate(value, args)]),
    );
  }
  return template;
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const actual = Buffer.from(user.passwordHash, "hex");
  const expected = Buffer.from(scryptSync(password, user.passwordSalt, 64).toString("hex"), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newToken() {
  return randomBytes(24).toString("hex");
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    workspaceKey: user.workspaceKey,
    createdAt: user.createdAt,
  };
}

function ensureUser(data, userId) {
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw new Error("Usuario no encontrado.");
  user.settings ||= { openaiApiKey: "", openaiModel: defaultModel };
  user.tools ||= [];
  user.databases ||= [];
  user.tables ||= [];
  return user;
}

function normalizeUser(user) {
  return {
    id: user.id || `usr_${randomUUID()}`,
    name: String(user.name || "Desarrollador"),
    email: String(user.email || "").trim().toLowerCase(),
    passwordHash: String(user.passwordHash || ""),
    passwordSalt: String(user.passwordSalt || ""),
    workspaceKey: String(user.workspaceKey || randomBytes(10).toString("hex")),
    createdAt: user.createdAt || new Date().toISOString(),
    settings: {
      openaiApiKey: String(user.settings?.openaiApiKey || ""),
      openaiModel: String(user.settings?.openaiModel || defaultModel),
    },
    tools: Array.isArray(user.tools) ? user.tools : [],
    databases: Array.isArray(user.databases) ? user.databases : [],
    tables: Array.isArray(user.tables) ? user.tables : [],
  };
}

function normalizeData(raw) {
  if (raw && Array.isArray(raw.users)) {
    return {
      version: 2,
      users: raw.users.map(normalizeUser),
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
  }
  return clone(initialData);
}

function readData() {
  if (!fs.existsSync(dataFile)) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, JSON.stringify(initialData, null, 2));
  }
  const raw = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const data = normalizeData(raw);
  if (JSON.stringify(raw) !== JSON.stringify(data)) writeData(data);
  return data;
}

function writeData(data) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
}

function aiStatusFromUser(user) {
  return {
    configured: Boolean(user.settings?.openaiApiKey),
    model: user.settings?.openaiModel || defaultModel,
    keyPreview: keyPreview(user.settings?.openaiApiKey || ""),
  };
}

function buildWorkspaceDocumentation(user) {
  if (!user.tables.length) {
    return {
      documentation: "Sin tablas internas registradas.",
      rules: "Sin reglas documentadas.",
    };
  }

  const documentation = user.tables
    .map((table) => {
      const fieldNames = ["id", ...table.fields.map((field) => field.name), "createdAt"];
      const base = `Tabla ${table.name}(${fieldNames.join(", ")}).`;
      return table.description ? `${base} ${table.description}` : base;
    })
    .join(" ");

  const rules = user.tables
    .map((table) => (table.rules ? `${table.name}: ${table.rules}` : ""))
    .filter(Boolean)
    .join(" ");

  return {
    documentation,
    rules: rules || "Sin reglas documentadas.",
  };
}

function syncWorkspaceDatabase(user, baseUrl) {
  const workspaceDbName = "workspace_interna";
  const info = buildWorkspaceDocumentation(user);
  user.databases = user.databases.filter(
    (database) => !(database.source === "internal" && database.name === workspaceDbName),
  );

  if (!user.tables.length) return;

  user.databases.push({
    id: `db_${workspaceDbName}`,
    source: "internal",
    locked: true,
    name: workspaceDbName,
    title: "Base interna",
    toolName: "consultaBaseInterna",
    sqlApiUrl: `${baseUrl}/workspace-api/${user.workspaceKey}/sql`,
    documentation: info.documentation,
    rules: info.rules,
  });
}

function syncTableTools(user, table, baseUrl) {
  const names = new Set([`crear_${table.name}`, `listar_${table.name}`]);
  user.tools = user.tools.filter((tool) => !(tool.source === "internal" && names.has(tool.name)));

  user.tools.push({
    id: `tool_${randomUUID()}`,
    source: "internal",
    tableName: table.name,
    name: `crear_${table.name}`,
    title: `Crear ${table.title || table.name}`,
    description:
      table.description ||
      `Crea un nuevo registro en la tabla ${table.title || table.name}. Usa esta tool cuando pidan dar de alta un elemento.`,
    method: "POST",
    url: `${baseUrl}/workspace-api/${user.workspaceKey}/tables/${table.name}/rows`,
    headers: {},
    readOnly: false,
    inputSchema: schemaFromFields(table.fields),
  });

  user.tools.push({
    id: `tool_${randomUUID()}`,
    source: "internal",
    tableName: table.name,
    name: `listar_${table.name}`,
    title: `Listar ${table.title || table.name}`,
    description: `Consulta los registros actuales de la tabla ${table.title || table.name}.`,
    method: "GET",
    url: `${baseUrl}/workspace-api/${user.workspaceKey}/tables/${table.name}/rows`,
    headers: {},
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  });
}

function normalizeTool(input) {
  return {
    id: input.id || `tool_${randomUUID()}`,
    source: input.source || "manual",
    tableName: input.tableName || "",
    name: slug(input.name, "tool"),
    title: input.title || input.name,
    description: input.description || "",
    method: String(input.method || "POST").toUpperCase(),
    url: assertUrl(input.url),
    headers: json(input.headers, {}),
    bodyTemplate: json(input.bodyTemplate, undefined),
    readOnly: Boolean(input.readOnly),
    inputSchema: normalizeSchema(input.inputSchema),
  };
}

function normalizeDatabase(input) {
  const name = slug(input.name, "base");
  return {
    id: input.id || `db_${randomUUID()}`,
    source: input.source || "manual",
    locked: Boolean(input.locked),
    name,
    title: input.title || input.name || name,
    toolName: slug(input.toolName || `consulta_${name}`, "consulta"),
    sqlApiUrl: input.sqlApiUrl ? assertUrl(input.sqlApiUrl) : "",
    documentation: input.documentation || "",
    rules: input.rules || "",
  };
}

function normalizeValue(field, value) {
  if (value === undefined || value === null || value === "") {
    if (field.defaultValue !== undefined && field.defaultValue !== "") return field.defaultValue;
    if (field.required) throw new Error(`Falta el campo requerido: ${field.label}`);
    return "";
  }

  if (field.type === "number" || field.type === "integer") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`El campo ${field.label} debe ser numerico.`);
    return numeric;
  }

  if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "si", "yes"].includes(normalized)) return true;
    if (["0", "false", "no"].includes(normalized)) return false;
    throw new Error(`El campo ${field.label} debe ser booleano.`);
  }

  const text = String(value).trim();
  if (field.enum?.length && !field.enum.includes(text)) {
    throw new Error(`El campo ${field.label} debe ser uno de: ${field.enum.join(", ")}`);
  }
  return text;
}

function findTable(user, tableName) {
  const table = user.tables.find((item) => item.name === slug(tableName, tableName));
  if (!table) throw new Error(`Tabla no encontrada: ${tableName}`);
  return table;
}

function insertRow(user, tableName, input) {
  const table = findTable(user, tableName);
  const row = {
    id: `${table.name}_${Date.now()}`,
    createdAt: new Date().toISOString(),
  };

  for (const field of table.fields) {
    row[field.name] = normalizeValue(field, input?.[field.name]);
  }

  table.rows ||= [];
  table.rows.push(row);
  table.updatedAt = new Date().toISOString();
  return row;
}

function listRows(user, tableName) {
  const table = findTable(user, tableName);
  return {
    table: table.name,
    title: table.title,
    rows: clone(table.rows || []),
  };
}

function parseSqlValue(raw) {
  if (raw === undefined) return undefined;
  if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return raw.slice(1, -1);
  if (/^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function runInternalSql(user, sql) {
  const text = String(sql || "").trim().replace(/\s+/g, " ");
  if (!/^(select|with)\b/i.test(text)) {
    throw new Error("Solo se permite SQL de lectura: SELECT/WITH.");
  }
  if (/(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(text)) {
    throw new Error("SQL bloqueado por seguridad.");
  }

  const match = text.match(
    /^select\s+(.+?)\s+from\s+([a-zA-Z0-9_]+)(?:\s+where\s+([a-zA-Z0-9_]+)\s*=\s*(.+?))?(?:\s+limit\s+(\d+))?\s*;?$/i,
  );

  if (!match) {
    throw new Error("SQL demo soportado: SELECT columnas FROM tabla [WHERE campo = valor] [LIMIT n].");
  }

  const [, columnsRaw, tableName, whereField, whereValueRaw, limitRaw] = match;
  const table = findTable(user, tableName);
  let rows = clone(table.rows || []);

  if (whereField) {
    const expected = parseSqlValue(whereValueRaw.trim());
    rows = rows.filter((row) => String(row[whereField]) === String(expected));
  }

  if (limitRaw) rows = rows.slice(0, Number(limitRaw));

  const columns = columnsRaw.trim() === "*"
    ? null
    : columnsRaw.split(",").map((item) => item.trim()).filter(Boolean);

  if (columns?.length) {
    rows = rows.map((row) => {
      const projected = {};
      for (const column of columns) projected[column] = row[column];
      return projected;
    });
  }

  return {
    ok: true,
    sql: text,
    table: table.name,
    count: rows.length,
    rows,
  };
}

function parseSimpleCustomerCommand(text) {
  if (!/\bagrega\b/i.test(text) && !/\bcrea\b/i.test(text) && !/\bregistra\b/i.test(text)) return null;
  if (!/\bcliente\b/i.test(text) && !/\bpersona\b/i.test(text)) return null;

  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0]?.replace(/\D/g, "");
  if (!email || !phone) return null;

  const beforeEmail = text.slice(0, text.indexOf(email));
  const nombre = beforeEmail
    .replace(/\bagrega(?:r)?\b/gi, "")
    .replace(/\bcrea(?:r)?\b/gi, "")
    .replace(/\bregistra(?:r)?\b/gi, "")
    .replace(/\b(al|el|la|un|una)\b/gi, "")
    .replace(/\b(cliente|persona)\b/gi, "")
    .replace(/[:\n\r,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!nombre) return null;
  return { nombre, email, telefono: phone };
}

export function createStore() {
  function mutate(fn) {
    const data = readData();
    const result = fn(data);
    writeData(data);
    return result;
  }

  return {
    read: readData,

    registerUser(input) {
      return mutate((data) => {
        const name = String(input.name || "").trim();
        const email = String(input.email || "").trim().toLowerCase();
        const password = String(input.password || "");

        if (name.length < 2) throw new Error("Escribe un nombre valido.");
        if (!email.includes("@")) throw new Error("Escribe un correo valido.");
        if (password.length < 6) throw new Error("La contrasena debe tener al menos 6 caracteres.");
        if (data.users.some((user) => user.email === email)) {
          throw new Error("Ya existe un usuario con ese correo.");
        }

        const { salt, hash } = hashPassword(password);
        const user = normalizeUser({
          id: `usr_${randomUUID()}`,
          name,
          email,
          passwordSalt: salt,
          passwordHash: hash,
        });
        data.users.push(user);

        const token = newToken();
        data.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
        return {
          token,
          user: sanitizeUser(user),
        };
      });
    },

    loginUser(input) {
      return mutate((data) => {
        const email = String(input.email || "").trim().toLowerCase();
        const password = String(input.password || "");
        const user = data.users.find((item) => item.email === email);
        if (!user || !verifyPassword(password, user)) {
          throw new Error("Correo o contrasena incorrectos.");
        }

        const token = newToken();
        data.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
        return {
          token,
          user: sanitizeUser(user),
        };
      });
    },

    logout(token) {
      mutate((data) => {
        data.sessions = data.sessions.filter((session) => session.token !== token);
      });
    },

    getUserByToken(token) {
      if (!token) return null;
      const data = readData();
      const session = data.sessions.find((item) => item.token === token);
      if (!session) return null;
      return ensureUser(data, session.userId);
    },

    getUserByWorkspaceKey(workspaceKey) {
      const data = readData();
      return data.users.find((user) => user.workspaceKey === workspaceKey) || null;
    },

    getSettings(userId) {
      const data = readData();
      const user = ensureUser(data, userId);
      return clone(user.settings);
    },

    getState(userId, baseUrl) {
      const data = readData();
      const user = ensureUser(data, userId);
      return {
        user: sanitizeUser(user),
        tools: clone(user.tools),
        databases: clone(user.databases),
        tables: clone(user.tables),
        ai: aiStatusFromUser(user),
        mcpUrl: `${baseUrl}/mcp/${user.workspaceKey}`,
        chatGptReady: baseUrl.startsWith("https://"),
      };
    },

    getTools(userId) {
      const data = readData();
      return clone(ensureUser(data, userId).tools);
    },

    getDatabases(userId) {
      const data = readData();
      return clone(ensureUser(data, userId).databases);
    },

    saveSettings(userId, input) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        if (typeof input.openaiApiKey === "string" && input.openaiApiKey.trim()) {
          user.settings.openaiApiKey = input.openaiApiKey.trim();
        }
        if (typeof input.openaiModel === "string" && input.openaiModel.trim()) {
          user.settings.openaiModel = input.openaiModel.trim();
        }
        return aiStatusFromUser(user);
      });
    },

    saveTool(userId, input) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const tool = normalizeTool(input);
        user.tools = user.tools.filter((item) => item.name !== tool.name);
        user.tools.push(tool);
        return tool;
      });
    },

    deleteTool(userId, name) {
      mutate((data) => {
        const user = ensureUser(data, userId);
        user.tools = user.tools.filter((tool) => tool.name !== name || tool.locked);
      });
    },

    saveDatabase(userId, input) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const database = normalizeDatabase(input);
        user.databases = user.databases.filter((item) => item.name !== database.name);
        user.databases.push(database);
        return database;
      });
    },

    deleteDatabase(userId, name) {
      mutate((data) => {
        const user = ensureUser(data, userId);
        user.databases = user.databases.filter(
          (database) => database.name !== name || database.locked,
        );
      });
    },

    saveTable(userId, input, baseUrl) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const name = slug(input.name, "tabla");
        const fields = normalizeFields(input.fields);
        const previous = user.tables.find((item) => item.name === name);
        const table = {
          id: previous?.id || `tbl_${randomUUID()}`,
          name,
          title: input.title || input.name || name,
          description: input.description || "",
          rules: input.rules || "",
          fields,
          rows: previous?.rows || [],
          createdAt: previous?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        user.tables = user.tables.filter((item) => item.name !== name);
        user.tables.push(table);
        syncTableTools(user, table, baseUrl);
        syncWorkspaceDatabase(user, baseUrl);
        return table;
      });
    },

    deleteTable(userId, name, baseUrl) {
      mutate((data) => {
        const user = ensureUser(data, userId);
        const tableName = slug(name, name);
        user.tables = user.tables.filter((table) => table.name !== tableName);
        user.tools = user.tools.filter(
          (tool) => !(tool.source === "internal" && tool.tableName === tableName),
        );
        syncWorkspaceDatabase(user, baseUrl);
      });
    },

    seedDemo(userId, baseUrl) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        user.tables = [];
        user.tools = user.tools.filter((tool) => tool.source !== "internal" && !tool.locked);
        user.databases = user.databases.filter((database) => database.source !== "internal");

        const clientes = {
          id: `tbl_${randomUUID()}`,
          name: "clientes",
          title: "Clientes",
          description: "Clientes del sistema legacy o del portal.",
          rules: "status = 1 activo, status = -1 inactivo.",
          fields: normalizeFields([
            { name: "nombre", label: "Nombre", type: "string", required: true },
            { name: "email", label: "Email", type: "string", required: true },
            { name: "telefono", label: "Telefono", type: "string", required: true },
            { name: "status", label: "Status", type: "number", required: false, defaultValue: 1 },
          ]),
          rows: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const facturas = {
          id: `tbl_${randomUUID()}`,
          name: "facturas",
          title: "Facturas",
          description: "Facturas emitidas a clientes existentes.",
          rules: "status = 1 emitida, status = -1 cancelada.",
          fields: normalizeFields([
            { name: "clienteid", label: "Cliente ID", type: "string", required: true },
            { name: "importe", label: "Importe", type: "number", required: true },
            { name: "concepto", label: "Concepto", type: "string", required: true },
            { name: "status", label: "Status", type: "number", required: false, defaultValue: 1 },
          ]),
          rows: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        user.tables.push(clientes, facturas);
        syncTableTools(user, clientes, baseUrl);
        syncTableTools(user, facturas, baseUrl);

        user.tools = user.tools.filter((tool) => tool.name !== "agregaCliente" && tool.name !== "emiteFactura");
        user.tools.push({
          id: `tool_${randomUUID()}`,
          source: "internal",
          tableName: "clientes",
          locked: true,
          name: "agregaCliente",
          title: "Agrega cliente",
          description:
            "Da de alta un cliente. Usa esta tool cuando el usuario pida agregar, registrar o crear un cliente.",
          method: "POST",
          url: `${baseUrl}/workspace-api/${user.workspaceKey}/tables/clientes/rows`,
          headers: {},
          readOnly: false,
          inputSchema: schemaFromFields(clientes.fields),
        });

        user.tools.push({
          id: `tool_${randomUUID()}`,
          source: "internal",
          tableName: "facturas",
          locked: true,
          name: "emiteFactura",
          title: "Emite factura",
          description: "Emite una factura para un cliente existente.",
          method: "POST",
          url: `${baseUrl}/workspace-api/${user.workspaceKey}/tables/facturas/rows`,
          headers: {},
          bodyTemplate: {
            clienteid: "{{clienteId}}",
            importe: "{{importe}}",
            concepto: "{{concepto}}",
            status: 1,
          },
          readOnly: false,
          inputSchema: {
            type: "object",
            properties: {
              clienteId: { type: "string" },
              importe: { type: "number" },
              concepto: { type: "string" },
            },
            required: ["clienteId", "importe", "concepto"],
            additionalProperties: false,
          },
        });

        syncWorkspaceDatabase(user, baseUrl);
        return {
          tools: clone(user.tools),
          databases: clone(user.databases),
          tables: clone(user.tables),
        };
      });
    },

    parseSimpleCommand(userId, text) {
      const data = readData();
      const user = ensureUser(data, userId);
      const parsed = parseSimpleCustomerCommand(text);
      if (!parsed) return null;

      const toolName = user.tools.find((tool) => tool.name === "agregaCliente")
        ? "agregaCliente"
        : user.tools.find((tool) => tool.name === "crear_clientes")
          ? "crear_clientes"
          : null;

      if (!toolName) return null;
      return {
        tool: toolName,
        arguments: parsed,
      };
    },

    async callTool(userId, name, args = {}) {
      const data = readData();
      const user = ensureUser(data, userId);
      const tool = user.tools.find((item) => item.name === name);
      if (!tool) throw new Error(`Tool no encontrada: ${name}`);

      const method = tool.method || "POST";
      const hasBody = !["GET", "HEAD"].includes(method);
      const body = hasBody ? renderTemplate(tool.bodyTemplate, args) : undefined;
      const url = new URL(tool.url);
      if (!hasBody) {
        Object.entries(args).forEach(([key, value]) => url.searchParams.set(key, value));
      }

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...(tool.headers || {}) },
        body: body === undefined ? (hasBody ? JSON.stringify(args) : undefined) : JSON.stringify(body),
      });

      const text = await response.text();
      let output = null;
      try {
        output = text ? JSON.parse(text) : null;
      } catch {
        output = { raw: text };
      }

      return { ok: response.ok, status: response.status, data: output };
    },

    insertWorkspaceRow(workspaceKey, tableName, input) {
      return mutate((data) => {
        const user = data.users.find((item) => item.workspaceKey === workspaceKey);
        if (!user) throw new Error("Workspace no encontrado.");
        return insertRow(user, tableName, input);
      });
    },

    listWorkspaceRows(workspaceKey, tableName) {
      const data = readData();
      const user = data.users.find((item) => item.workspaceKey === workspaceKey);
      if (!user) throw new Error("Workspace no encontrado.");
      return listRows(user, tableName);
    },

    runWorkspaceSql(workspaceKey, sql) {
      const data = readData();
      const user = data.users.find((item) => item.workspaceKey === workspaceKey);
      if (!user) throw new Error("Workspace no encontrado.");
      return runInternalSql(user, sql);
    },
  };
}
