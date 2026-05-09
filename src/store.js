import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import mysql from "mysql2/promise";

const dataFile = path.join(process.cwd(), "data", "portal.json");
const defaultModel = "gpt-4.1-mini";
const maxResourceContentLength = 250_000;
const maxActivityEntries = 80;
const maxProjectImportFiles = 160;
const maxProjectImportBytes = 4_000_000;
const oauthCodeLifetimeMs = 10 * 60 * 1000;
const oauthTokenLifetimeMs = 12 * 60 * 60 * 1000;

const initialData = {
  version: 5,
  users: [],
  sessions: [],
  oauthClients: [],
  oauthCodes: [],
  oauthTokens: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function futureIso(ms) {
  return new Date(Date.now() + ms).toISOString();
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

function clipText(value, size = 220) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > size ? `${text.slice(0, size - 1)}...` : text;
}

function resourcePreview(value, size = 180) {
  return clipText(String(value || "").replace(/\s+/g, " "), size);
}

function resourceNameKey(value) {
  return String(value || "").trim().replace(/\\/g, "/").toLowerCase();
}

function resourceKindFromName(name) {
  const normalized = String(name || "").trim().replace(/\\/g, "/");
  const basename = normalized.split("/").pop() || normalized;
  const ext = basename.includes(".") ? `.${basename.split(".").pop().toLowerCase()}` : "";
  if ([".js", ".ts", ".tsx", ".jsx", ".php", ".py", ".java", ".cs", ".go", ".rb", ".rs", ".swift", ".kt", ".dart", ".c", ".cpp", ".h", ".hpp", ".vue", ".svelte", ".css", ".scss", ".less", ".sh", ".ps1", ".bat", ".cmd"].includes(ext)) {
    return "codigo";
  }
  if ([".sql"].includes(ext)) return "sql";
  if ([".md", ".txt", ".rst", ".adoc"].includes(ext)) return "documentacion";
  if ([".json", ".yml", ".yaml", ".toml", ".ini", ".env", ".xml", ".html", ".csv", ".log"].includes(ext)) {
    return "archivo";
  }
  return "archivo";
}

function projectManifestMeta(resource) {
  const normalizedName = String(resource?.name || "").replace(/\\/g, "/");
  if (!normalizedName.endsWith("/__mcp_project_manifest.json")) {
    return {
      isProjectManifest: false,
      projectRootName: "",
      projectFileCount: 0,
    };
  }

  const fallbackRoot = normalizedName.split("/__mcp_project_manifest.json")[0];
  try {
    const parsed = JSON.parse(String(resource?.content || "{}"));
    return {
      isProjectManifest: true,
      projectRootName: String(parsed.rootName || fallbackRoot || ""),
      projectFileCount: Number(parsed.fileCount || 0),
    };
  } catch {
    return {
      isProjectManifest: true,
      projectRootName: fallbackRoot,
      projectFileCount: 0,
    };
  }
}

function sha256Base64Url(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
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

function ensureReadOnlySql(sql) {
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

function aiStatusFromUser(user) {
  return {
    configured: Boolean(user.settings?.openaiApiKey),
    model: user.settings?.openaiModel || defaultModel,
    keyPreview: keyPreview(user.settings?.openaiApiKey || ""),
  };
}

function buildProjectDocumentation(project) {
  if (!project.tables.length) {
    return {
      documentation: "Sin tablas internas registradas.",
      rules: "Sin reglas documentadas.",
    };
  }

  const documentation = project.tables
    .map((table) => {
      const fieldNames = ["id", ...table.fields.map((field) => field.name), "createdAt"];
      const base = `Tabla ${table.name}(${fieldNames.join(", ")}).`;
      return table.description ? `${base} ${table.description}` : base;
    })
    .join(" ");

  const rules = project.tables
    .map((table) => (table.rules ? `${table.name}: ${table.rules}` : ""))
    .filter(Boolean)
    .join(" ");

  return {
    documentation,
    rules: rules || "Sin reglas documentadas.",
  };
}

function normalizeProjectMysql(mysqlInput, previous = {}) {
  const input = mysqlInput || {};
  const host = String(input.host ?? previous.host ?? "").trim();
  const portRaw = input.port ?? previous.port ?? 3306;
  const port = Number(portRaw || 3306);
  const user = String(input.user ?? input.username ?? previous.user ?? "").trim();
  const password = String(
    input.password === "" && previous.password ? previous.password : input.password ?? previous.password ?? "",
  );
  const database = String(input.database ?? input.databaseName ?? previous.database ?? "").trim();

  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 3306,
    user,
    password,
    database,
  };
}

function normalizeTool(input) {
  const method = String(input.method || "POST").toUpperCase();
  const name = slug(input.name, "tool");
  return {
    id: input.id || `tool_${randomUUID()}`,
    source: input.source || "manual",
    generated: Boolean(input.generated || (input.source === "internal" && /^(crear_|listar_)/.test(name))),
    locked: Boolean(input.locked),
    tableName: input.tableName || "",
    name,
    title: input.title || input.name,
    description: input.description || "",
    method,
    url: input.url ? assertUrl(input.url) : "",
    headers: json(input.headers, {}),
    bodyTemplate: json(input.bodyTemplate, undefined),
    readOnly: input.readOnly !== undefined ? Boolean(input.readOnly) : ["GET", "HEAD"].includes(method),
    inputSchema: normalizeSchema(input.inputSchema),
    outputSchema: input.outputSchema ? json(input.outputSchema, {}) : undefined,
    outputExample: input.outputExample ? String(input.outputExample) : "",
  };
}

function normalizeDatabase(input, previous = {}) {
  const name = slug(input.name, "base");
  const mysqlConfig = normalizeProjectMysql(input.mysql || input, previous.mysql);
  const sqlApiUrl = input.sqlApiUrl ? assertUrl(input.sqlApiUrl) : previous.sqlApiUrl || "";
  const requestedMode = String(input.mode || previous.mode || "").trim().toLowerCase();
  const hasMysql = Boolean(mysqlConfig.host || mysqlConfig.user || mysqlConfig.database);
  const mode = requestedMode || (
    input.source === "internal"
      ? "internal"
      : sqlApiUrl
        ? "http"
        : hasMysql
          ? "mysql"
          : "docs"
  );

  if (mode === "http" && !sqlApiUrl) {
    throw new Error("Agrega la URL del endpoint SQL si eliges modo HTTP.");
  }

  if (mode === "mysql") {
    if (!mysqlConfig.host || !mysqlConfig.user || !mysqlConfig.database) {
      throw new Error("Para MySQL necesitas host, usuario y base de datos.");
    }
  }

  return {
    id: input.id || previous.id || `db_${randomUUID()}`,
    source: input.source || previous.source || "manual",
    generated: Boolean(
      input.generated
      || previous.generated
      || ((input.source || previous.source) === "internal" && name === "workspace_interna"),
    ),
    locked: Boolean(input.locked || previous.locked),
    name,
    title: input.title || previous.title || input.name || name,
    toolName: slug(input.toolName || previous.toolName || `consulta_${name}`, "consulta"),
    mode,
    sqlApiUrl,
    documentation: input.documentation || previous.documentation || "",
    rules: input.rules || previous.rules || "",
    mysql: mysqlConfig,
  };
}

function normalizeResource(input, previous = {}) {
  const name = String(input.name ?? previous.name ?? "").trim();
  const content = String(input.content ?? previous.content ?? "");
  if (name.length < 2) throw new Error("El archivo o nota necesita un nombre.");
  if (!content.trim()) throw new Error("Agrega contenido o carga un archivo de texto.");
  if (content.length > maxResourceContentLength) {
    throw new Error(`El contenido supera el limite de ${maxResourceContentLength.toLocaleString("es-MX")} caracteres.`);
  }

  const kind = slug(input.kind || previous.kind || "archivo", "archivo");
  return {
    id: input.id || previous.id || `res_${randomUUID()}`,
    kind,
    name,
    description: String(input.description ?? previous.description ?? ""),
    mimeType: String(input.mimeType ?? previous.mimeType ?? "text/plain"),
    content,
    size: Buffer.byteLength(content, "utf8"),
    createdAt: input.createdAt || previous.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || previous.updatedAt || new Date().toISOString(),
  };
}

function normalizeActivity(input) {
  return {
    id: input.id || `act_${randomUUID()}`,
    type: String(input.type || "evento"),
    title: String(input.title || "Actividad"),
    summary: String(input.summary || ""),
    meta: typeof input.meta === "object" && input.meta ? clone(input.meta) : {},
    createdAt: input.createdAt || nowIso(),
  };
}

function normalizeOauthClient(input) {
  const redirectUris = Array.isArray(input.redirect_uris || input.redirectUris)
    ? (input.redirect_uris || input.redirectUris).map((item) => String(item).trim()).filter(Boolean)
    : [];
  if (!redirectUris.length) throw new Error("El cliente OAuth necesita al menos un redirect_uri.");
  return {
    id: input.id || `oauth_client_${randomUUID()}`,
    clientId: String(input.client_id || input.clientId || `client_${randomBytes(12).toString("hex")}`),
    clientName: String(input.client_name || input.clientName || "ChatGPT MCP client"),
    redirectUris,
    grantTypes: Array.isArray(input.grant_types || input.grantTypes)
      ? clone(input.grant_types || input.grantTypes)
      : ["authorization_code"],
    responseTypes: Array.isArray(input.response_types || input.responseTypes)
      ? clone(input.response_types || input.responseTypes)
      : ["code"],
    tokenEndpointAuthMethod: String(
      input.token_endpoint_auth_method || input.tokenEndpointAuthMethod || "none",
    ),
    scope: String(input.scope || "mcp:read mcp:write"),
    createdAt: input.createdAt || nowIso(),
  };
}

function normalizeOauthCode(input) {
  return {
    id: input.id || `oauth_code_${randomUUID()}`,
    code: String(input.code || randomBytes(24).toString("base64url")),
    clientId: String(input.clientId || ""),
    userId: String(input.userId || ""),
    workspaceKey: String(input.workspaceKey || ""),
    projectKey: String(input.projectKey || ""),
    redirectUri: String(input.redirectUri || ""),
    scope: String(input.scope || "mcp:read mcp:write"),
    resource: String(input.resource || ""),
    codeChallenge: String(input.codeChallenge || ""),
    codeChallengeMethod: String(input.codeChallengeMethod || "S256"),
    createdAt: input.createdAt || nowIso(),
    expiresAt: input.expiresAt || futureIso(oauthCodeLifetimeMs),
    consumedAt: input.consumedAt || "",
  };
}

function normalizeOauthToken(input) {
  return {
    id: input.id || `oauth_token_${randomUUID()}`,
    accessToken: String(input.accessToken || randomBytes(32).toString("base64url")),
    clientId: String(input.clientId || ""),
    userId: String(input.userId || ""),
    workspaceKey: String(input.workspaceKey || ""),
    projectKey: String(input.projectKey || ""),
    scope: String(input.scope || "mcp:read mcp:write"),
    resource: String(input.resource || ""),
    createdAt: input.createdAt || nowIso(),
    expiresAt: input.expiresAt || futureIso(oauthTokenLifetimeMs),
  };
}

function summarizeResource(resource, includeContent = false) {
  const manifest = projectManifestMeta(resource);
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
    size: resource.size,
    preview: resourcePreview(resource.content),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    isProjectManifest: manifest.isProjectManifest,
    projectRootName: manifest.projectRootName,
    projectFileCount: manifest.projectFileCount,
    ...(includeContent ? { content: resource.content } : {}),
  };
}

function findResourceByName(project, name) {
  const target = resourceNameKey(name);
  return (project.resources || []).find((resource) => resourceNameKey(resource.name) === target) || null;
}

function upsertProjectResource(project, input) {
  const existingById = input.id
    ? (project.resources || []).find((resource) => resource.id === String(input.id).trim())
    : null;
  const existingByName = input.name ? findResourceByName(project, input.name) : null;
  const previous = existingById || existingByName || null;
  const resource = normalizeResource({
    ...input,
    kind: input.kind || previous?.kind || resourceKindFromName(input.name),
  }, previous || {});
  resource.updatedAt = new Date().toISOString();
  project.resources = (project.resources || []).filter((item) => item.id !== resource.id);
  project.resources.unshift(resource);
  project.updatedAt = new Date().toISOString();
  return { resource, previous };
}

function pushActivity(project, input) {
  project.activity ||= [];
  const entry = normalizeActivity(input);
  project.activity.unshift(entry);
  project.activity = project.activity.slice(0, maxActivityEntries);
  project.updatedAt = new Date().toISOString();
  return entry;
}

function normalizeTable(input) {
  const fields = normalizeFields(input.fields);
  return {
    id: input.id || `tbl_${randomUUID()}`,
    name: slug(input.name, "tabla"),
    title: input.title || input.name || "Tabla",
    description: input.description || "",
    rules: input.rules || "",
    fields,
    rows: Array.isArray(input.rows) ? input.rows : [],
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function resolveToolUrl(user, project, tool, baseUrl) {
  if (tool.source !== "internal" || !tool.tableName) return tool.url;
  return `${baseUrl}/workspace-api/${user.workspaceKey}/${project.key}/tables/${tool.tableName}/rows`;
}

function resolveDatabaseUrl(user, project, database, baseUrl) {
  if (database.mode === "internal") {
    return `${baseUrl}/workspace-api/${user.workspaceKey}/${project.key}/sql`;
  }
  return database.sqlApiUrl || "";
}

function decorateTool(user, project, tool, baseUrl) {
  return {
    ...clone(tool),
    url: resolveToolUrl(user, project, tool, baseUrl),
  };
}

function decorateDatabase(user, project, database, baseUrl) {
  return {
    ...clone(database),
    sqlApiUrl: resolveDatabaseUrl(user, project, database, baseUrl),
    mysql: {
      ...clone(database.mysql || {}),
      password: "",
      passwordSaved: Boolean(database.mysql?.password),
      passwordPreview: database.mysql?.password ? "••••••••" : "",
    },
  };
}

function projectSummary(user, project, baseUrl) {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    title: project.title,
    description: project.description,
    context: project.context,
    apiBaseUrl: project.apiBaseUrl || "",
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    counts: {
      tools: project.tools.length,
      databases: project.databases.length,
      tables: project.tables.length,
      rows: project.tables.reduce((sum, table) => sum + (table.rows?.length || 0), 0),
      resources: project.resources?.length || 0,
    },
    mcpUrl: `${baseUrl}/mcp/${user.workspaceKey}/${project.key}`,
  };
}

function schemaFields(schema = {}) {
  return Object.keys(schema.properties || {});
}

function projectGuide(user, project, options = {}) {
  const intent = String(options.intent || "").trim().toLowerCase();
  const question = String(options.question || "").trim();
  const terms = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const actionTools = project.tools
    .filter((tool) => !tool.readOnly)
    .map((tool) => ({
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || "",
      requiredFields: tool.inputSchema?.required || [],
      acceptedFields: schemaFields(tool.inputSchema),
      outputExample: tool.outputExample || "",
    }));

  const readTools = project.tools
    .filter((tool) => tool.readOnly)
    .map((tool) => ({
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description || "",
      acceptedFields: schemaFields(tool.inputSchema),
      outputExample: tool.outputExample || "",
    }));

  const databases = project.databases.map((database) => ({
    name: database.toolName,
    title: database.title || database.name,
    mode: database.mode,
    description: database.documentation || "",
    rules: database.rules || "",
    canVisualize: true,
    supportsSql: ["internal", "mysql", "http"].includes(database.mode),
  }));

  const tables = project.tables.map((table) => ({
    name: table.name,
    title: table.title,
    fields: table.fields.map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      required: field.required,
    })),
    rules: table.rules || "",
  }));

  const resources = (project.resources || []).slice(0, 60).map((resource) => ({
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    description: resource.description || "",
    preview: resourcePreview(resource.content),
  }));

  const catalog = [
    ...actionTools.map((item) => ({ type: "action", ...item })),
    ...readTools.map((item) => ({ type: "read", ...item })),
    ...databases.map((item) => ({ type: "database", ...item })),
    ...tables.map((item) => ({ type: "table", ...item })),
    ...resources.map((item) => ({ type: "resource", ...item })),
  ];

  const matches = terms.length
    ? catalog
      .map((item) => {
        const source = JSON.stringify(item).toLowerCase();
        const score = terms.reduce((sum, term) => sum + (source.includes(term) ? 1 : 0), 0);
        return { item, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.item)
    : [];

  const recommendedTools = (
    intent === "accion"
      ? actionTools
      : intent === "visualizacion" || intent === "consulta"
        ? [...readTools, ...databases]
        : [...actionTools, ...readTools, ...databases]
  ).slice(0, 8);

  const managementTools = [
    {
      name: "crearBaseProyecto",
      description: "Crea o actualiza una base logica del proyecto para trabajar desde ChatGPT.",
    },
    {
      name: "crearTablaProyecto",
      description: "Crea o actualiza una tabla interna del proyecto.",
    },
    {
      name: "listarTablasProyecto",
      description: "Lista las tablas internas del proyecto con sus campos y conteos.",
    },
    {
      name: "crearRegistroProyecto",
      description: "Crea un registro dentro de una tabla interna.",
    },
    {
      name: "listarRegistrosProyecto",
      description: "Lista o busca registros dentro de una tabla interna.",
    },
    {
      name: "actualizarRegistroProyecto",
      description: "Edita un registro ya creado dentro de una tabla interna.",
    },
    {
      name: "eliminarRegistroProyecto",
      description: "Elimina un registro de una tabla interna.",
    },
    {
      name: "registrarToolProyecto",
      description: "Registra una API HTTP del sistema legacy.",
    },
    {
      name: "registrarBaseProyecto",
      description: "Conecta o documenta una base MySQL, SQL HTTP o interna.",
    },
    {
      name: "guardarArchivoProyecto",
      description: "Guarda codigo, SQL, documentacion o notas dentro del proyecto.",
    },
  ];

  return {
    ok: true,
    intent: intent || "general",
    question,
    project: {
      workspaceKey: user.workspaceKey,
      projectKey: project.key,
      title: project.title,
      description: project.description,
      context: project.context,
      apiBaseUrl: project.apiBaseUrl || "",
    },
    howToRespond: {
      action:
        "Si el usuario quiere realizar una accion, usa una tool de escritura. Si faltan datos requeridos, pidelos. Si la accion cambia datos importantes, confirma antes de ejecutar.",
      visualization:
        "Si el usuario quiere visualizar o revisar informacion, usa tools read-only o una base con SQL SELECT/WITH y luego resume el resultado en lista, tabla corta o conteos claros.",
      query:
        "Si el usuario hace una pregunta de negocio como cuantas polizas hay, usa una tool de base o lectura y responde con el dato exacto.",
      missingData:
        "Nunca inventes campos, IDs o parametros. Pide solamente los datos faltantes.",
    },
    availableActions: actionTools,
    availableReadTools: readTools,
    managementTools,
    availableDatabases: databases,
    internalTables: tables,
    projectResources: resources,
    projectResourceCount: project.resources?.length || 0,
    recommendedTools,
    bestMatches: matches,
    examplePrompts: [
      "crea una base de datos interna llamada usuarios",
      "crea una tabla clientes con nombre, email, telefono y status",
      "agrega una persona a la tabla personas con nombre, telefono y email",
      "edita el correo del registro personas_123",
      "elimina el registro personas_123 de la tabla personas",
      "registra la api /agregaCliente como tool de este proyecto",
      "guarda este SQL como archivo llamado polizas.sql",
      "agrega al cliente Fernando Hernandez, fernando@email.com, 5526997998",
      "cuantas polizas tiene el sistema",
      "muestrame las polizas vigentes",
      "abre el archivo polizas.sql y dime que consultas o tablas contiene",
      "que acciones puedes hacer dentro de este proyecto",
    ],
  };
}

function createEmptyProject(seed = {}) {
  return {
    id: seed.id || `prj_${randomUUID()}`,
    key: String(seed.key || randomBytes(8).toString("hex")),
    name: slug(seed.name || seed.title || "proyecto_principal", "proyecto_principal"),
    title: String(seed.title || seed.name || "Proyecto principal"),
    description: String(seed.description || ""),
    context: String(seed.context || ""),
    apiBaseUrl: seed.apiBaseUrl ? assertUrl(seed.apiBaseUrl) : "",
    tools: [],
    databases: [],
    tables: [],
    resources: [],
    activity: [],
    createdAt: seed.createdAt || new Date().toISOString(),
    updatedAt: seed.updatedAt || new Date().toISOString(),
  };
}

function syncTableTools(project, table) {
  const names = new Set([
    `crear_${table.name}`,
    `listar_${table.name}`,
    `actualizar_${table.name}`,
    `eliminar_${table.name}`,
  ]);
  const existingCreate = project.tools.find((tool) => tool.generated && tool.name === `crear_${table.name}`);
  const existingList = project.tools.find((tool) => tool.generated && tool.name === `listar_${table.name}`);
  const existingUpdate = project.tools.find((tool) => tool.generated && tool.name === `actualizar_${table.name}`);
  const existingDelete = project.tools.find((tool) => tool.generated && tool.name === `eliminar_${table.name}`);
  project.tools = project.tools.filter((tool) => !(tool.generated && names.has(tool.name)));

  project.tools.push({
    id: existingCreate?.id || `tool_${randomUUID()}`,
    source: "internal",
    generated: true,
    locked: false,
    tableName: table.name,
    name: `crear_${table.name}`,
    title: `Crear ${table.title || table.name}`,
    description:
      table.description ||
      `Crea un nuevo registro en la tabla ${table.title || table.name}. Usa esta tool cuando pidan dar de alta un elemento.`,
    method: "POST",
    headers: {},
    readOnly: false,
    inputSchema: schemaFromFields(table.fields),
    outputExample: "{ ok: true, row: { ... } }",
  });

  project.tools.push({
    id: existingList?.id || `tool_${randomUUID()}`,
    source: "internal",
    generated: true,
    locked: false,
    tableName: table.name,
    name: `listar_${table.name}`,
    title: `Listar ${table.title || table.name}`,
    description: `Consulta los registros actuales de la tabla ${table.title || table.name}.`,
    method: "GET",
    headers: {},
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputExample: "{ ok: true, rows: [...] }",
  });

  project.tools.push({
    id: existingUpdate?.id || `tool_${randomUUID()}`,
    source: "internal",
    generated: true,
    locked: false,
    tableName: table.name,
    name: `actualizar_${table.name}`,
    title: `Actualizar ${table.title || table.name}`,
    description: `Actualiza un registro existente de la tabla ${table.title || table.name}.`,
    method: "PUT",
    headers: {},
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        rowId: { type: "string", description: "ID del registro a actualizar" },
        ...schemaFromFields(table.fields).properties,
      },
      required: ["rowId"],
      additionalProperties: false,
    },
    outputExample: "{ ok: true, row: { ... } }",
  });

  project.tools.push({
    id: existingDelete?.id || `tool_${randomUUID()}`,
    source: "internal",
    generated: true,
    locked: false,
    tableName: table.name,
    name: `eliminar_${table.name}`,
    title: `Eliminar ${table.title || table.name}`,
    description: `Elimina un registro de la tabla ${table.title || table.name}.`,
    method: "DELETE",
    headers: {},
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        rowId: { type: "string", description: "ID del registro a eliminar" },
      },
      required: ["rowId"],
      additionalProperties: false,
    },
    outputExample: "{ ok: true, deleted: { id: '...' } }",
  });
}

function syncWorkspaceDatabase(project) {
  const info = buildProjectDocumentation(project);
  const existing = project.databases.find(
    (database) => database.generated && database.name === "workspace_interna",
  );
  project.databases = project.databases.filter(
    (database) => !(database.generated && database.name === "workspace_interna"),
  );

  if (!project.tables.length) return;

  project.databases.push({
    id: existing?.id || `db_${randomUUID()}`,
    source: "internal",
    generated: true,
    locked: true,
    name: "workspace_interna",
    title: "Base interna",
    toolName: "consultaBaseInterna",
    mode: "internal",
    sqlApiUrl: "",
    documentation: info.documentation,
    rules: info.rules,
    mysql: { host: "", port: 3306, user: "", password: "", database: "" },
  });
}

function syncProjectArtifacts(project) {
  project.tools = Array.isArray(project.tools) ? project.tools.map(normalizeTool) : [];
  project.databases = Array.isArray(project.databases) ? project.databases.map((db) => normalizeDatabase(db)) : [];
  project.tables = Array.isArray(project.tables) ? project.tables.map(normalizeTable) : [];
  project.resources = Array.isArray(project.resources)
    ? project.resources.map((resource) => normalizeResource(resource))
    : [];
  project.activity = Array.isArray(project.activity)
    ? project.activity.map((activity) => normalizeActivity(activity))
    : [];

  project.tools = project.tools.filter((tool) => !tool.generated);
  project.databases = project.databases.filter((database) => !database.generated);

  for (const table of project.tables) syncTableTools(project, table);
  syncWorkspaceDatabase(project);
  project.updatedAt = project.updatedAt || new Date().toISOString();
  return project;
}

function legacyProjectFromUser(user) {
  const project = createEmptyProject({
    key: randomBytes(8).toString("hex"),
    name: "proyecto_principal",
    title: "Proyecto principal",
    description: "Migrado desde el workspace unico anterior.",
  });
  project.tools = Array.isArray(user.tools) ? user.tools : [];
  project.databases = Array.isArray(user.databases) ? user.databases : [];
  project.tables = Array.isArray(user.tables) ? user.tables : [];
  return syncProjectArtifacts(project);
}

function normalizeProject(project) {
  const normalized = createEmptyProject(project);
  normalized.context = String(project.context || "");
  normalized.tools = Array.isArray(project.tools) ? project.tools : [];
  normalized.databases = Array.isArray(project.databases) ? project.databases : [];
  normalized.tables = Array.isArray(project.tables) ? project.tables : [];
  normalized.resources = Array.isArray(project.resources) ? project.resources : [];
  normalized.activity = Array.isArray(project.activity) ? project.activity : [];
  return syncProjectArtifacts(normalized);
}

function normalizeOauthState(raw) {
  const now = Date.now();
  const oauthClients = Array.isArray(raw.oauthClients)
    ? raw.oauthClients.map(normalizeOauthClient)
    : [];
  const oauthCodes = Array.isArray(raw.oauthCodes)
    ? raw.oauthCodes
      .map(normalizeOauthCode)
      .filter((code) => new Date(code.expiresAt).getTime() > now && !code.consumedAt)
    : [];
  const oauthTokens = Array.isArray(raw.oauthTokens)
    ? raw.oauthTokens
      .map(normalizeOauthToken)
      .filter((token) => new Date(token.expiresAt).getTime() > now)
    : [];
  return { oauthClients, oauthCodes, oauthTokens };
}

function normalizeUser(user) {
  const rawProjects = Array.isArray(user.projects) && user.projects.length
    ? user.projects
    : [legacyProjectFromUser(user)];
  const projects = rawProjects.map(normalizeProject);
  const activeProjectId = projects.some((project) => project.id === user.activeProjectId)
    ? user.activeProjectId
    : projects[0]?.id || "";

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
    activeProjectId,
    projects,
  };
}

function normalizeData(raw) {
  if (raw && Array.isArray(raw.users)) {
    const oauth = normalizeOauthState(raw);
    return {
      version: 5,
      users: raw.users.map(normalizeUser),
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      oauthClients: oauth.oauthClients,
      oauthCodes: oauth.oauthCodes,
      oauthTokens: oauth.oauthTokens,
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

function ensureUser(data, userId) {
  const user = data.users.find((item) => item.id === userId);
  if (!user) throw new Error("Usuario no encontrado.");
  user.settings ||= { openaiApiKey: "", openaiModel: defaultModel };
  user.projects ||= [normalizeProject(createEmptyProject())];
  user.activeProjectId ||= user.projects[0]?.id || "";
  return user;
}

function getProjectById(user, projectId) {
  return user.projects.find((project) => project.id === projectId) || null;
}

function getProjectByKey(user, projectKey) {
  return user.projects.find((project) => project.key === projectKey) || null;
}

function getProjectByReference(user, reference = "") {
  const target = String(reference || "").trim();
  if (!target) return null;
  return (
    getProjectById(user, target)
    || getProjectByKey(user, target)
    || user.projects.find((project) => project.name === slug(target, target))
    || user.projects.find((project) => slug(project.title, project.title) === slug(target, target))
    || null
  );
}

function getActiveProject(user) {
  return getProjectById(user, user.activeProjectId) || user.projects[0] || null;
}

function ensureProject(user, projectRef = "") {
  const project = projectRef ? getProjectByReference(user, projectRef) : getActiveProject(user);
  if (!project) throw new Error("Proyecto no encontrado.");
  return project;
}

function ensureWorkspaceProject(data, workspaceKey, projectKey = "") {
  const user = data.users.find((item) => item.workspaceKey === workspaceKey);
  if (!user) throw new Error("Workspace no encontrado.");
  const project = projectKey ? getProjectByKey(user, projectKey) : getActiveProject(user);
  if (!project) throw new Error("Proyecto no encontrado.");
  return { user, project };
}

function resolvePublishedProject(data) {
  const workspaceKey = String(process.env.PUBLIC_MCP_WORKSPACE_KEY || "").trim();
  const projectKey = String(process.env.PUBLIC_MCP_PROJECT_KEY || "").trim();

  if (workspaceKey) {
    return ensureWorkspaceProject(data, workspaceKey, projectKey);
  }

  if (data.users.length === 1) {
    const user = ensureUser(data, data.users[0].id);
    const project = projectKey ? getProjectByKey(user, projectKey) : getActiveProject(user);
    if (!project) throw new Error("Proyecto no encontrado.");
    return { user, project };
  }

  const onlyProjects = data.users.flatMap((user) =>
    (user.projects || []).map((project) => ({ user, project })),
  );

  if (onlyProjects.length === 1) return onlyProjects[0];

  throw new Error(
    "No pude decidir que proyecto publicar en /mcp. Configura PUBLIC_MCP_WORKSPACE_KEY y PUBLIC_MCP_PROJECT_KEY.",
  );
}

function findOauthClient(data, clientId) {
  return (data.oauthClients || []).find((client) => client.clientId === clientId) || null;
}

function findOauthCode(data, code) {
  return (data.oauthCodes || []).find((item) => item.code === code) || null;
}

function findOauthToken(data, accessToken) {
  return (data.oauthTokens || []).find((item) => item.accessToken === accessToken) || null;
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

function findTable(project, tableName) {
  const table = project.tables.find((item) => item.name === slug(tableName, tableName));
  if (!table) throw new Error(`Tabla no encontrada: ${tableName}`);
  return table;
}

function findRow(table, rowId) {
  table.rows ||= [];
  const row = table.rows.find((item) => item.id === rowId);
  if (!row) throw new Error(`Registro no encontrado: ${rowId}`);
  return row;
}

function findResource(project, identifier) {
  const target = String(identifier || "").trim();
  const byId = (project.resources || []).find((resource) => resource.id === target);
  if (byId) return byId;
  const byName = findResourceByName(project, target);
  if (byName) return byName;
  const bySlug = (project.resources || []).find((resource) => slug(resource.name, resource.name) === slug(target, target));
  if (bySlug) return bySlug;
  throw new Error(`Archivo o nota no encontrado: ${identifier}`);
}

function insertRow(project, tableName, input) {
  const table = findTable(project, tableName);
  const row = {
    id: `${table.name}_${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  for (const field of table.fields) {
    row[field.name] = normalizeValue(field, input?.[field.name]);
  }

  table.rows ||= [];
  table.rows.push(row);
  table.updatedAt = new Date().toISOString();
  return row;
}

function updateRow(project, tableName, rowId, input) {
  const table = findTable(project, tableName);
  const row = findRow(table, rowId);

  for (const field of table.fields) {
    const candidate = input?.[field.name] === undefined ? row[field.name] : input[field.name];
    row[field.name] = normalizeValue(field, candidate);
  }

  row.updatedAt = new Date().toISOString();
  table.updatedAt = new Date().toISOString();
  return row;
}

function deleteRow(project, tableName, rowId) {
  const table = findTable(project, tableName);
  const row = findRow(table, rowId);
  table.rows = (table.rows || []).filter((item) => item.id !== rowId);
  table.updatedAt = new Date().toISOString();
  return row;
}

function listRows(project, tableName) {
  const table = findTable(project, tableName);
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

function runInternalSql(project, sql) {
  const text = ensureReadOnlySql(sql).replace(/\s+/g, " ");
  const match = text.match(
    /^select\s+(.+?)\s+from\s+([a-zA-Z0-9_]+)(?:\s+where\s+([a-zA-Z0-9_]+)\s*=\s*(.+?))?(?:\s+limit\s+(\d+))?\s*;?$/i,
  );

  if (!match) {
    throw new Error("SQL demo soportado: SELECT columnas FROM tabla [WHERE campo = valor] [LIMIT n].");
  }

  const [, columnsRaw, tableName, whereField, whereValueRaw, limitRaw] = match;
  const table = findTable(project, tableName);
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

async function runMysqlReadOnly(database, sql) {
  const text = ensureReadOnlySql(sql);
  const connection = await mysql.createConnection({
    host: database.mysql.host,
    port: database.mysql.port,
    user: database.mysql.user,
    password: database.mysql.password,
    database: database.mysql.database,
    connectTimeout: 5000,
  });

  try {
    const [rows] = await connection.query(text);
    const plainRows = clone(rows);
    return {
      ok: true,
      sql: text,
      count: Array.isArray(plainRows) ? plainRows.length : 0,
      rows: plainRows,
    };
  } finally {
    await connection.end();
  }
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

async function runExternalSql(database, sql) {
  const text = ensureReadOnlySql(sql);
  const response = await fetch(database.sqlApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql: text }),
  });

  const payload = await response.text();
  let data = null;
  try {
    data = payload ? JSON.parse(payload) : null;
  } catch {
    data = { raw: payload };
  }

  return {
    ok: response.ok,
    status: response.status,
    sql: text,
    result: data,
  };
}

function buildOperationDocs(database, args = {}) {
  return {
    ok: true,
    executed: false,
    mode: database.mode,
    documentation: database.documentation,
    rules: database.rules,
    question: args.question || "",
    note: "No se ejecuto SQL. Agrega sql o configura una conexion activa.",
  };
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
        const project = normalizeProject(createEmptyProject());
        const user = normalizeUser({
          id: `usr_${randomUUID()}`,
          name,
          email,
          passwordSalt: salt,
          passwordHash: hash,
          projects: [project],
          activeProjectId: project.id,
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

    registerOauthClient(input) {
      return mutate((data) => {
        const client = normalizeOauthClient(input);
        data.oauthClients = (data.oauthClients || []).filter((item) => item.clientId !== client.clientId);
        data.oauthClients.push(client);
        return clone(client);
      });
    },

    getOauthClient(clientId) {
      const data = readData();
      return clone(findOauthClient(data, clientId));
    },

    createOauthCode(input) {
      return mutate((data) => {
        const client = findOauthClient(data, input.clientId);
        if (!client) throw new Error("Cliente OAuth no encontrado.");
        const redirectUri = String(input.redirectUri || "").trim();
        if (!client.redirectUris.includes(redirectUri)) {
          throw new Error("redirect_uri no permitido para este cliente.");
        }
        const code = normalizeOauthCode(input);
        data.oauthCodes ||= [];
        data.oauthCodes.push(code);
        return clone(code);
      });
    },

    exchangeOauthCode(input) {
      return mutate((data) => {
        const code = findOauthCode(data, input.code);
        if (!code) throw new Error("Authorization code no valido.");
        if (code.consumedAt) throw new Error("Authorization code ya fue usado.");
        if (new Date(code.expiresAt).getTime() <= Date.now()) {
          throw new Error("Authorization code expirado.");
        }
        if (String(input.clientId || "") !== code.clientId) {
          throw new Error("client_id invalido.");
        }
        if (String(input.redirectUri || "") !== code.redirectUri) {
          throw new Error("redirect_uri invalido.");
        }
        if (code.codeChallengeMethod !== "S256") {
          throw new Error("Solo se soporta PKCE con S256.");
        }
        if (sha256Base64Url(input.codeVerifier || "") !== code.codeChallenge) {
          throw new Error("code_verifier invalido.");
        }

        code.consumedAt = nowIso();
        const token = normalizeOauthToken({
          clientId: code.clientId,
          userId: code.userId,
          workspaceKey: code.workspaceKey,
          projectKey: code.projectKey,
          scope: code.scope,
          resource: code.resource,
        });
        data.oauthTokens ||= [];
        data.oauthTokens.push(token);
        return clone(token);
      });
    },

    getOauthToken(accessToken) {
      const data = readData();
      const token = findOauthToken(data, accessToken);
      if (!token) return null;
      if (new Date(token.expiresAt).getTime() <= Date.now()) return null;
      return clone(token);
    },

    getUserByWorkspaceKey(workspaceKey) {
      const data = readData();
      return data.users.find((user) => user.workspaceKey === workspaceKey) || null;
    },

    getWorkspaceProject(workspaceKey, projectKey = "") {
      const data = readData();
      return ensureWorkspaceProject(data, workspaceKey, projectKey);
    },

    getPublishedProject() {
      const data = readData();
      return resolvePublishedProject(data);
    },

    getSettings(userId) {
      const data = readData();
      const user = ensureUser(data, userId);
      return clone(user.settings);
    },

    getState(userId, baseUrl) {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = ensureProject(user);

      return {
        user: sanitizeUser(user),
        projects: user.projects.map((item) => projectSummary(user, item, baseUrl)),
        project: projectSummary(user, project, baseUrl),
        tools: project.tools.map((tool) => decorateTool(user, project, tool, baseUrl)),
        databases: project.databases.map((database) => decorateDatabase(user, project, database, baseUrl)),
        tables: clone(project.tables),
        resources: (project.resources || []).map((resource) => summarizeResource(resource)),
        activity: clone((project.activity || []).slice(0, 24)),
        ai: aiStatusFromUser(user),
        mcpUrl: `${baseUrl}/mcp/${user.workspaceKey}/${project.key}`,
        legacyMcpUrl: `${baseUrl}/mcp/${user.workspaceKey}`,
        chatGptReady: baseUrl.startsWith("https://"),
      };
    },

    getProjectGuide(userId, projectKey = "", options = {}) {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      return projectGuide(user, project, options);
    },

    getTools(userId, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      return clone(project.tools);
    },

    getDatabases(userId, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      return clone(project.databases);
    },

    listResources(userId, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      return (project.resources || []).map((resource) => summarizeResource(resource));
    },

    getResource(userId, identifier, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      return summarizeResource(findResource(project, identifier), true);
    },

    getActivity(userId, projectKey = "", limit = 20) {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      const size = Number(limit) > 0 ? Math.min(Number(limit), maxActivityEntries) : 20;
      return clone((project.activity || []).slice(0, size));
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

    saveProject(userId, input) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const title = String(input.title || input.name || "").trim();
        if (title.length < 2) throw new Error("Escribe el nombre del proyecto.");

        const existing = input.id ? getProjectById(user, input.id) : null;
        if (existing) {
          existing.name = slug(input.name || title, existing.name || "proyecto");
          existing.title = title;
          existing.description = String(input.description || "");
          existing.context = String(input.context || "");
          existing.apiBaseUrl = input.apiBaseUrl ? assertUrl(input.apiBaseUrl) : "";
          existing.updatedAt = new Date().toISOString();
          pushActivity(existing, {
            type: "configuracion",
            title: "Proyecto actualizado",
            summary: `Se actualizo la configuracion del proyecto ${existing.title}.`,
            meta: { projectId: existing.id },
          });
          user.activeProjectId = existing.id;
          return projectSummary(user, existing, input.baseUrl || "http://localhost");
        }

        const project = normalizeProject(createEmptyProject({
          name: input.name || title,
          title,
          description: input.description || "",
          context: input.context || "",
          apiBaseUrl: input.apiBaseUrl || "",
        }));
        user.projects.push(project);
        user.activeProjectId = project.id;
        pushActivity(project, {
          type: "configuracion",
          title: "Proyecto creado",
          summary: `Se creo el proyecto ${project.title}.`,
          meta: { projectId: project.id },
        });
        return project;
      });
    },

    selectProject(userId, projectId) {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = getProjectById(user, projectId);
        if (!project) throw new Error("Proyecto no encontrado.");
        user.activeProjectId = project.id;
        return sanitizeUser(user);
      });
    },

    deleteProject(userId, projectId) {
      mutate((data) => {
        const user = ensureUser(data, userId);
        if (user.projects.length <= 1) {
          throw new Error("Debes conservar al menos un proyecto.");
        }
        user.projects = user.projects.filter((project) => project.id !== projectId);
        if (!user.projects.some((project) => project.id === user.activeProjectId)) {
          user.activeProjectId = user.projects[0]?.id || "";
        }
      });
    },

    saveTool(userId, input, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const tool = normalizeTool(input);
        project.tools = project.tools.filter((item) => item.name !== tool.name);
        project.tools.push(tool);
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "configuracion",
          title: "Tool guardada",
          summary: `La tool ${tool.name} ya forma parte del proyecto.`,
          meta: { toolName: tool.name, method: tool.method },
        });
        return tool;
      });
    },

    deleteTool(userId, name, projectRef = "") {
      mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        project.tools = project.tools.filter((tool) => tool.name !== name || tool.locked);
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "configuracion",
          title: "Tool eliminada",
          summary: `Se elimino la tool ${name}.`,
          meta: { toolName: name },
        });
      });
    },

    saveDatabase(userId, input, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const previous = project.databases.find((item) => item.name === slug(input.name, "base"));
        const database = normalizeDatabase(input, previous);
        project.databases = project.databases.filter((item) => item.name !== database.name);
        project.databases.push(database);
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "configuracion",
          title: "Base documentada",
          summary: `Se guardo la base ${database.title || database.name} en modo ${database.mode}.`,
          meta: { databaseName: database.name, mode: database.mode },
        });
        return database;
      });
    },

    deleteDatabase(userId, name, projectRef = "") {
      mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        project.databases = project.databases.filter(
          (database) => database.name !== name || database.locked,
        );
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "configuracion",
          title: "Base eliminada",
          summary: `Se elimino la base ${name}.`,
          meta: { databaseName: name },
        });
      });
    },

    saveTable(userId, input, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const name = slug(input.name, "tabla");
        const previous = project.tables.find((item) => item.name === name);
        const table = normalizeTable({
          ...input,
          id: previous?.id,
          createdAt: previous?.createdAt,
          rows: previous?.rows || [],
        });
        project.tables = project.tables.filter((item) => item.name !== name);
        project.tables.push(table);
        syncProjectArtifacts(project);
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "configuracion",
          title: previous ? "Tabla actualizada" : "Tabla creada",
          summary: `${table.title} quedo lista con ${table.fields.length} campos.`,
          meta: { tableName: table.name, fields: table.fields.length },
        });
        return table;
      });
    },

    deleteTable(userId, name, projectRef = "") {
      mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const tableName = slug(name, name);
        project.tables = project.tables.filter((table) => table.name !== tableName);
        syncProjectArtifacts(project);
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "configuracion",
          title: "Tabla eliminada",
          summary: `Se elimino la tabla ${tableName}.`,
          meta: { tableName },
        });
      });
    },

    saveResource(userId, input, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const { resource, previous } = upsertProjectResource(project, input);
        pushActivity(project, {
          type: "archivo",
          title: previous ? "Archivo actualizado" : "Archivo cargado",
          summary: `${resource.name} ya esta disponible para que ChatGPT lo consulte.`,
          meta: { resourceId: resource.id, name: resource.name, kind: resource.kind },
        });
        return summarizeResource(resource, true);
      });
    },

    importProjectResources(userId, payload, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const files = Array.isArray(payload?.files) ? payload.files : [];
        if (!files.length) throw new Error("Selecciona al menos un archivo del proyecto.");
        if (files.length > maxProjectImportFiles) {
          throw new Error(`Por ahora solo se importan hasta ${maxProjectImportFiles} archivos por proyecto.`);
        }

        const rootName = String(payload?.rootName || project.title || "proyecto").trim().replace(/\\/g, "/");
        let totalBytes = 0;
        let createdCount = 0;
        let updatedCount = 0;
        const saved = [];

        for (const file of files) {
          const content = String(file?.content || "");
          const bytes = Buffer.byteLength(content, "utf8");
          totalBytes += bytes;
          if (totalBytes > maxProjectImportBytes) {
            throw new Error(`El proyecto supera el limite de ${(maxProjectImportBytes / 1_000_000).toFixed(1)} MB de texto.`);
          }

          const { resource, previous } = upsertProjectResource(project, {
            name: String(file?.name || "").trim().replace(/\\/g, "/"),
            kind: file?.kind || resourceKindFromName(file?.name || ""),
            description: file?.description || `Archivo importado desde el proyecto ${rootName}.`,
            mimeType: file?.mimeType || "text/plain",
            content,
          });

          if (previous) updatedCount += 1;
          else createdCount += 1;

          saved.push({
            name: resource.name,
            kind: resource.kind,
            size: resource.size,
            updatedAt: resource.updatedAt,
          });
        }

        const manifest = upsertProjectResource(project, {
          name: `${rootName}/__mcp_project_manifest.json`,
          kind: "documentacion",
          description: `Indice del proyecto ${rootName} con ${saved.length} archivos listo para ChatGPT.`,
          mimeType: "application/json",
          content: JSON.stringify({
            rootName,
            importedAt: nowIso(),
            fileCount: saved.length,
            files: saved,
          }, null, 2),
        }).resource;

        pushActivity(project, {
          type: "archivo",
          title: "Proyecto cargado",
          summary: `Se importaron ${saved.length} archivos del proyecto ${rootName}.`,
          meta: {
            rootName,
            fileCount: saved.length,
            createdCount,
            updatedCount,
          },
        });

        return {
          ok: true,
          rootName,
          fileCount: saved.length,
          createdCount,
          updatedCount,
          manifest: summarizeResource(manifest),
          files: saved.slice(0, 40),
        };
      });
    },

    deleteResource(userId, identifier, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        const resource = findResource(project, identifier);
        project.resources = (project.resources || []).filter((item) => item.id !== resource.id);
        project.updatedAt = new Date().toISOString();
        pushActivity(project, {
          type: "archivo",
          title: "Archivo eliminado",
          summary: `Se elimino ${resource.name} del proyecto.`,
          meta: { resourceId: resource.id, name: resource.name },
        });
      });
    },

    seedDemo(userId, projectRef = "") {
      return mutate((data) => {
        const user = ensureUser(data, userId);
        const project = ensureProject(user, projectRef);
        project.tables = [];
        project.tools = project.tools.filter((tool) => tool.source !== "internal");
        project.databases = project.databases.filter((database) => database.source !== "internal");

        const clientes = normalizeTable({
          name: "clientes",
          title: "Clientes",
          description: "Clientes del sistema conectado.",
          rules: "status = 1 activo, status = -1 inactivo.",
          fields: [
            { name: "nombre", label: "Nombre", type: "string", required: true },
            { name: "email", label: "Email", type: "string", required: true },
            { name: "telefono", label: "Telefono", type: "string", required: true },
            { name: "status", label: "Status", type: "number", required: false, defaultValue: 1 },
          ],
        });

        const polizas = normalizeTable({
          name: "polizas",
          title: "Polizas",
          description: "Polizas registradas en el sistema.",
          rules: "status = 1 vigente, status = -1 cancelada.",
          fields: [
            { name: "folio", label: "Folio", type: "string", required: true },
            { name: "cliente", label: "Cliente", type: "string", required: true },
            { name: "importe", label: "Importe", type: "number", required: true },
            { name: "status", label: "Status", type: "number", required: false, defaultValue: 1 },
          ],
        });

        const facturas = normalizeTable({
          name: "facturas",
          title: "Facturas",
          description: "Facturas emitidas a clientes existentes.",
          rules: "status = 1 emitida, status = -1 cancelada.",
          fields: [
            { name: "clienteid", label: "Cliente ID", type: "string", required: true },
            { name: "importe", label: "Importe", type: "number", required: true },
            { name: "concepto", label: "Concepto", type: "string", required: true },
            { name: "status", label: "Status", type: "number", required: false, defaultValue: 1 },
          ],
        });

        project.tables.push(clientes, polizas, facturas);
        syncProjectArtifacts(project);

        project.tools = project.tools.filter((tool) => !["agregaCliente", "emiteFactura"].includes(tool.name));
        project.tools.push({
          id: `tool_${randomUUID()}`,
          source: "internal",
          generated: false,
          locked: true,
          tableName: "clientes",
          name: "agregaCliente",
          title: "Agrega cliente",
          description:
            "Da de alta un cliente. Usa esta tool cuando el usuario pida agregar, registrar o crear un cliente.",
          method: "POST",
          headers: {},
          readOnly: false,
          inputSchema: schemaFromFields(clientes.fields),
          outputExample: "{ ok: true, row: { id, nombre, email, telefono } }",
        });

        project.tools.push({
          id: `tool_${randomUUID()}`,
          source: "internal",
          generated: false,
          locked: true,
          tableName: "facturas",
          name: "emiteFactura",
          title: "Emite factura",
          description: "Emite una factura para un cliente existente.",
          method: "POST",
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
          outputExample: "{ ok: true, row: { id, clienteid, importe, concepto } }",
        });

        project.updatedAt = new Date().toISOString();
        return {
          tools: clone(project.tools),
          databases: clone(project.databases),
          tables: clone(project.tables),
        };
      });
    },

    parseSimpleCommand(userId, text) {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = ensureProject(user);
      const parsed = parseSimpleCustomerCommand(text);
      if (!parsed) return null;

      const toolName = project.tools.find((tool) => tool.name === "agregaCliente")
        ? "agregaCliente"
        : project.tools.find((tool) => tool.name === "crear_clientes")
          ? "crear_clientes"
          : null;

      if (!toolName) return null;
      return {
        tool: toolName,
        arguments: parsed,
      };
    },

    async callTool(userId, name, args = {}, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      const tool = project.tools.find((item) => item.name === name);
      if (!tool) throw new Error(`Tool no encontrada: ${name}`);

      if (tool.source === "internal" && tool.tableName) {
        const payload = tool.bodyTemplate ? renderTemplate(tool.bodyTemplate, args) : args;
        if (tool.readOnly || ["GET", "HEAD"].includes(tool.method || "GET")) {
          return { ok: true, status: 200, data: this.listWorkspaceRows(user.workspaceKey, project.key, tool.tableName) };
        }
        if (["PUT", "PATCH"].includes(tool.method || "POST")) {
          const rowId = String(payload.rowId || payload.id || "").trim();
          if (!rowId) throw new Error("Falta rowId para actualizar.");
          const row = this.updateWorkspaceRow(user.workspaceKey, project.key, tool.tableName, rowId, payload, {
            source: "mcp",
            toolName: tool.name,
            toolTitle: tool.title || tool.name,
          });
          return { ok: true, status: 200, data: { ok: true, row } };
        }
        if ((tool.method || "POST") === "DELETE") {
          const rowId = String(payload.rowId || payload.id || "").trim();
          if (!rowId) throw new Error("Falta rowId para eliminar.");
          const deleted = this.deleteWorkspaceRow(user.workspaceKey, project.key, tool.tableName, rowId, {
            source: "mcp",
            toolName: tool.name,
            toolTitle: tool.title || tool.name,
          });
          return { ok: true, status: 200, data: { ok: true, deleted } };
        }
        const row = this.insertWorkspaceRow(user.workspaceKey, project.key, tool.tableName, payload, {
          source: "mcp",
          toolName: tool.name,
          toolTitle: tool.title || tool.name,
        });
        return { ok: true, status: 201, data: { ok: true, row } };
      }

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

      mutate((saveData) => {
        const saveUser = ensureUser(saveData, userId);
        const saveProject = projectKey ? getProjectByKey(saveUser, project.key) : ensureProject(saveUser);
        if (!saveProject) return;
        pushActivity(saveProject, {
          type: "tool",
          title: tool.title || tool.name,
          summary: `${tool.name} respondio con HTTP ${response.status}.`,
          meta: {
            toolName: tool.name,
            method,
            status: response.status,
            ok: response.ok,
            args,
          },
        });
      });

      return { ok: response.ok, status: response.status, data: output };
    },

    async callDatabase(userId, name, args = {}, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");
      const database = project.databases.find((item) => item.toolName === name);
      if (!database) throw new Error(`Base no encontrada: ${name}`);

      const sql = String(args.sql || "").trim();
      if (!sql) return buildOperationDocs(database, args);

      if (database.mode === "internal") {
        return this.runWorkspaceSql(user.workspaceKey, project.key, sql);
      }
      if (database.mode === "mysql") {
        const result = await runMysqlReadOnly(database, sql);
        mutate((saveData) => {
          const saveUser = ensureUser(saveData, userId);
          const saveProject = projectKey ? getProjectByKey(saveUser, project.key) : ensureProject(saveUser);
          if (!saveProject) return;
          pushActivity(saveProject, {
            type: "consulta",
            title: database.title || database.name,
            summary: `Consulta MySQL por ${database.toolName} con ${result.count} registros.`,
            meta: { database: database.name, toolName: database.toolName, sql, count: result.count },
          });
        });
        return result;
      }
      if (database.mode === "http") {
        const result = await runExternalSql(database, sql);
        mutate((saveData) => {
          const saveUser = ensureUser(saveData, userId);
          const saveProject = projectKey ? getProjectByKey(saveUser, project.key) : ensureProject(saveUser);
          if (!saveProject) return;
          pushActivity(saveProject, {
            type: "consulta",
            title: database.title || database.name,
            summary: `Consulta SQL por ${database.toolName} en modo ${database.mode}.`,
            meta: { database: database.name, toolName: database.toolName, sql, count: result.result?.count ?? null },
          });
        });
        return result;
      }

      const docs = buildOperationDocs(database, args);
      mutate((saveData) => {
        const saveUser = ensureUser(saveData, userId);
        const saveProject = projectKey ? getProjectByKey(saveUser, project.key) : ensureProject(saveUser);
        if (!saveProject) return;
        pushActivity(saveProject, {
          type: "consulta",
          title: database.title || database.name,
          summary: `Se consulto la documentacion de ${database.toolName}.`,
          meta: { database: database.name, toolName: database.toolName },
        });
      });
      return docs;
    },

    async callOperation(userId, name, args = {}, projectKey = "") {
      const data = readData();
      const user = ensureUser(data, userId);
      const project = projectKey ? getProjectByKey(user, projectKey) : ensureProject(user);
      if (!project) throw new Error("Proyecto no encontrado.");

      if (name === "configurarProyectoActual") {
        const apiBaseUrl = typeof args.apiBaseUrl === "string" ? args.apiBaseUrl.trim() : project.apiBaseUrl;
        return {
          ok: true,
          project: this.saveProject(userId, {
            id: project.id,
            title: args.title || project.title,
            name: args.name || project.name,
            description: args.description ?? project.description,
            context: args.context ?? project.context,
            apiBaseUrl,
          }),
        };
      }

      if (name === "crearBaseProyecto") {
        const payload = {
          ...args,
          mode: args.mode || "internal",
          documentation: args.documentation || args.description || "",
        };
        if (payload.sqlApiUrl && String(payload.sqlApiUrl).startsWith("/") && project.apiBaseUrl) {
          payload.sqlApiUrl = new URL(String(payload.sqlApiUrl), `${project.apiBaseUrl}/`).toString();
        }
        return {
          ok: true,
          database: this.saveDatabase(userId, payload, project.key),
        };
      }

      if (name === "crearTablaProyecto") {
        return {
          ok: true,
          table: this.saveTable(userId, args, project.key),
        };
      }

      if (name === "listarTablasProyecto") {
        const query = String(args.query || "").trim().toLowerCase();
        const tables = clone(project.tables)
          .map((table) => ({
            name: table.name,
            title: table.title,
            description: table.description,
            rules: table.rules,
            rowCount: Array.isArray(table.rows) ? table.rows.length : 0,
            fields: table.fields.map((field) => ({
              name: field.name,
              label: field.label,
              type: field.type,
              required: field.required,
              description: field.description,
            })),
          }))
          .filter((table) => {
            if (!query) return true;
            return JSON.stringify(table).toLowerCase().includes(query);
          });

        return {
          ok: true,
          project: project.title,
          count: tables.length,
          tables,
        };
      }

      if (name === "eliminarTablaProyecto") {
        const tableName = args.name || args.tableName;
        if (!tableName) throw new Error("Agrega name o tableName.");
        this.deleteTable(userId, tableName, project.key);
        return { ok: true, deleted: { tableName: slug(tableName, tableName) } };
      }

      if (name === "registrarToolProyecto") {
        const payload = { ...args };
        if (payload.url && String(payload.url).startsWith("/") && project.apiBaseUrl) {
          payload.url = new URL(String(payload.url), `${project.apiBaseUrl}/`).toString();
        }
        return {
          ok: true,
          tool: this.saveTool(userId, payload, project.key),
        };
      }

      if (name === "eliminarToolProyecto") {
        const toolName = args.name || args.toolName;
        if (!toolName) throw new Error("Agrega name o toolName.");
        this.deleteTool(userId, toolName, project.key);
        return { ok: true, deleted: { toolName } };
      }

      if (name === "registrarBaseProyecto") {
        const payload = { ...args };
        if (payload.sqlApiUrl && String(payload.sqlApiUrl).startsWith("/") && project.apiBaseUrl) {
          payload.sqlApiUrl = new URL(String(payload.sqlApiUrl), `${project.apiBaseUrl}/`).toString();
        }
        return {
          ok: true,
          database: this.saveDatabase(userId, payload, project.key),
        };
      }

      if (name === "eliminarBaseProyecto") {
        const dbName = args.name || args.databaseName;
        if (!dbName) throw new Error("Agrega name o databaseName.");
        this.deleteDatabase(userId, dbName, project.key);
        return { ok: true, deleted: { databaseName: slug(dbName, dbName) } };
      }

      if (name === "guardarArchivoProyecto") {
        const payload = { ...args };
        if (payload.resourceId && !payload.id) payload.id = payload.resourceId;
        return {
          ok: true,
          resource: this.saveResource(userId, payload, project.key),
        };
      }

      if (name === "eliminarArchivoProyecto") {
        const identifier = args.resourceId || args.name;
        if (!identifier) throw new Error("Agrega resourceId o name.");
        this.deleteResource(userId, identifier, project.key);
        return { ok: true, deleted: { identifier } };
      }

      if (name === "cargarDemoProyecto") {
        return {
          ok: true,
          demo: this.seedDemo(userId, project.key),
        };
      }

      if (name === "listarArchivosProyecto") {
        const query = String(args.query || "").trim().toLowerCase();
        const resources = this.listResources(userId, project.key).filter((resource) => {
          if (!query) return true;
          const source = JSON.stringify(resource).toLowerCase();
          return source.includes(query);
        });
        return {
          ok: true,
          project: project.title,
          count: resources.length,
          resources,
        };
      }

      if (name === "verArchivoProyecto") {
        const identifier = args.resourceId || args.name;
        if (!identifier) throw new Error("Agrega resourceId o name para abrir el archivo del proyecto.");
        return {
          ok: true,
          project: project.title,
          resource: this.getResource(userId, identifier, project.key),
        };
      }

      if (name === "actividadProyecto") {
        const limit = Number(args.limit || 20);
        return {
          ok: true,
          project: project.title,
          items: this.getActivity(userId, project.key, limit),
        };
      }

      if (name === "crearRegistroProyecto") {
        const tableName = String(args.tableName || "").trim();
        if (!tableName) throw new Error("Agrega tableName.");
        const payload = typeof args.data === "object" && args.data ? args.data : {};
        return {
          ok: true,
          row: this.insertWorkspaceRow(user.workspaceKey, project.key, tableName, payload, {
            source: "mcp",
            toolName: name,
            toolTitle: `Nuevo registro en ${tableName}`,
          }),
        };
      }

      if (name === "listarRegistrosProyecto") {
        const tableName = String(args.tableName || "").trim();
        if (!tableName) throw new Error("Agrega tableName.");
        const rowId = String(args.rowId || "").trim();
        const query = String(args.query || "").trim().toLowerCase();
        const limit = Number(args.limit || 0);
        const listed = this.listWorkspaceRows(user.workspaceKey, project.key, tableName);
        let rows = Array.isArray(listed.rows) ? listed.rows : [];

        if (rowId) {
          rows = rows.filter((row) => row.id === rowId);
        }
        if (query) {
          rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query));
        }
        if (Number.isFinite(limit) && limit > 0) {
          rows = rows.slice(0, limit);
        }

        return {
          ok: true,
          table: listed.table,
          title: listed.title,
          count: rows.length,
          rows,
        };
      }

      if (name === "actualizarRegistroProyecto") {
        const tableName = String(args.tableName || "").trim();
        const rowId = String(args.rowId || "").trim();
        if (!tableName) throw new Error("Agrega tableName.");
        if (!rowId) throw new Error("Agrega rowId.");
        const payload = typeof args.data === "object" && args.data ? args.data : {};
        return {
          ok: true,
          row: this.updateWorkspaceRow(user.workspaceKey, project.key, tableName, rowId, payload, {
            source: "mcp",
            toolName: name,
            toolTitle: `Registro actualizado en ${tableName}`,
          }),
        };
      }

      if (name === "eliminarRegistroProyecto") {
        const tableName = String(args.tableName || "").trim();
        const rowId = String(args.rowId || "").trim();
        if (!tableName) throw new Error("Agrega tableName.");
        if (!rowId) throw new Error("Agrega rowId.");
        return {
          ok: true,
          deleted: this.deleteWorkspaceRow(user.workspaceKey, project.key, tableName, rowId, {
            source: "mcp",
            toolName: name,
            toolTitle: `Registro eliminado de ${tableName}`,
          }),
        };
      }

      const database = project.databases.find((item) => item.toolName === name);
      if (database) return this.callDatabase(userId, name, args, project.key);

      return this.callTool(userId, name, args, project.key);
    },

    insertWorkspaceRow(workspaceKey, projectKey, tableName, input, meta = {}) {
      return mutate((data) => {
        const { project } = ensureWorkspaceProject(data, workspaceKey, projectKey);
        const row = insertRow(project, tableName, input);
        const table = findTable(project, tableName);
        pushActivity(project, {
          type: "dato",
          title: meta.toolTitle || `Nuevo registro en ${table.title}`,
          summary: `${row.id} se creo dentro de ${table.title}.`,
          meta: { tableName: table.name, rowId: row.id, source: meta.source || "portal", toolName: meta.toolName || "" },
        });
        project.updatedAt = new Date().toISOString();
        return clone(row);
      });
    },

    listWorkspaceRows(workspaceKey, projectKey, tableName) {
      const data = readData();
      const { project } = ensureWorkspaceProject(data, workspaceKey, projectKey);
      return listRows(project, tableName);
    },

    updateWorkspaceRow(workspaceKey, projectKey, tableName, rowId, input, meta = {}) {
      return mutate((data) => {
        const { project } = ensureWorkspaceProject(data, workspaceKey, projectKey);
        const row = updateRow(project, tableName, rowId, input);
        const table = findTable(project, tableName);
        pushActivity(project, {
          type: "dato",
          title: meta.toolTitle || `Registro actualizado en ${table.title}`,
          summary: `${row.id} se actualizo dentro de ${table.title}.`,
          meta: { tableName: table.name, rowId: row.id, source: meta.source || "portal", toolName: meta.toolName || "" },
        });
        project.updatedAt = new Date().toISOString();
        return clone(row);
      });
    },

    deleteWorkspaceRow(workspaceKey, projectKey, tableName, rowId, meta = {}) {
      return mutate((data) => {
        const { project } = ensureWorkspaceProject(data, workspaceKey, projectKey);
        const deleted = deleteRow(project, tableName, rowId);
        const table = findTable(project, tableName);
        pushActivity(project, {
          type: "dato",
          title: meta.toolTitle || `Registro eliminado de ${table.title}`,
          summary: `${deleted.id} se elimino de ${table.title}.`,
          meta: { tableName: table.name, rowId: deleted.id, source: meta.source || "portal", toolName: meta.toolName || "" },
        });
        project.updatedAt = new Date().toISOString();
        return clone(deleted);
      });
    },

    runWorkspaceSql(workspaceKey, projectKey, sql) {
      return mutate((data) => {
        const { project } = ensureWorkspaceProject(data, workspaceKey, projectKey);
        const result = runInternalSql(project, sql);
        pushActivity(project, {
          type: "consulta",
          title: "Consulta sobre base interna",
          summary: `Se ejecuto SQL de lectura sobre ${result.table} y devolvio ${result.count} registros.`,
          meta: { sql: result.sql, table: result.table, count: result.count },
        });
        return result;
      });
    },
  };
}
