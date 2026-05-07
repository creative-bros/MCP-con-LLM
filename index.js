import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTableFromPrompt, runAiCommand } from "./src/ai.js";
import { handleMcpMessage, listMcpTools } from "./src/mcp.js";
import { createStore } from "./src/store.js";

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const app = express();
const store = createStore();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function publicBaseUrl(req) {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host");
  return `${proto}://${host}`;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function readToken(req) {
  const auth = req.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

function authRequired(req, res, next) {
  const token = readToken(req);
  const user = store.getUserByToken(token);
  if (!user) {
    res.status(401).json({ error: "Sesion no valida. Entra de nuevo." });
    return;
  }
  req.token = token;
  req.user = user;
  next();
}

function workspaceProjectOr404(res, workspaceKey, projectKey = "") {
  try {
    return store.getWorkspaceProject(workspaceKey, projectKey);
  } catch {
    res.status(404).json({ error: "Workspace no encontrado." });
    return null;
  }
}

function publishedProjectOrError(res) {
  try {
    return store.getPublishedProject();
  } catch (err) {
    res.status(409).json({
      error: err.message,
      hint: "Si quieres usar una sola URL /mcp, deja un solo usuario/proyecto o configura PUBLIC_MCP_WORKSPACE_KEY y PUBLIC_MCP_PROJECT_KEY.",
    });
    return null;
  }
}

function handleStreamableMcp(req, res) {
  if (!(req.get("accept") || "").includes("text/event-stream")) return false;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(": MCP stream listo\n\n");
  const timer = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => clearInterval(timer));
  return true;
}

app.get("/health", (req, res) => {
  const data = store.read();
  let publicMcp = null;
  try {
    const target = store.getPublishedProject();
    publicMcp = `${publicBaseUrl(req)}/mcp`;
    if (!target?.project?.key) publicMcp = null;
  } catch {
    publicMcp = null;
  }
  res.json({
    ok: true,
    users: data.users.length,
    sessions: data.sessions.length,
    mcpPattern: `${publicBaseUrl(req)}/mcp/:workspaceKey/:projectKey`,
    publicMcpUrl: publicMcp,
  });
});

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const result = store.registerUser(req.body || {});
  res.status(201).json({
    ...result,
    state: store.getState(result.user.id, publicBaseUrl(req)),
  });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const result = store.loginUser(req.body || {});
  res.json({
    ...result,
    state: store.getState(result.user.id, publicBaseUrl(req)),
  });
}));

app.post("/api/auth/logout", authRequired, (req, res) => {
  store.logout(req.token);
  res.status(204).end();
});

app.get("/api/auth/session", authRequired, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      workspaceKey: req.user.workspaceKey,
      createdAt: req.user.createdAt,
    },
    state: store.getState(req.user.id, publicBaseUrl(req)),
  });
});

app.get("/api/state", authRequired, (req, res) => {
  res.json(store.getState(req.user.id, publicBaseUrl(req)));
});

app.post("/api/projects", authRequired, (req, res) => {
  res.status(201).json(store.saveProject(req.user.id, req.body || {}));
});

app.post("/api/projects/select", authRequired, (req, res) => {
  store.selectProject(req.user.id, String(req.body?.projectId || ""));
  res.status(204).end();
});

app.delete("/api/projects/:projectId", authRequired, (req, res) => {
  store.deleteProject(req.user.id, req.params.projectId);
  res.status(204).end();
});

app.post("/api/settings", authRequired, (req, res) => {
  res.json(store.saveSettings(req.user.id, req.body || {}));
});

app.post("/api/demo", authRequired, (req, res) => {
  const result = store.seedDemo(req.user.id);
  res.status(201).json(result);
});

app.post("/api/tools", authRequired, (req, res) => {
  res.status(201).json(store.saveTool(req.user.id, req.body || {}));
});

app.delete("/api/tools/:name", authRequired, (req, res) => {
  store.deleteTool(req.user.id, req.params.name);
  res.status(204).end();
});

app.post("/api/databases", authRequired, (req, res) => {
  res.status(201).json(store.saveDatabase(req.user.id, req.body || {}));
});

app.delete("/api/databases/:name", authRequired, (req, res) => {
  store.deleteDatabase(req.user.id, req.params.name);
  res.status(204).end();
});

app.post("/api/tables", authRequired, (req, res) => {
  res.status(201).json(store.saveTable(req.user.id, req.body || {}));
});

app.delete("/api/tables/:name", authRequired, (req, res) => {
  store.deleteTable(req.user.id, req.params.name);
  res.status(204).end();
});

app.post("/api/ai-table", authRequired, asyncRoute(async (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) {
    res.status(400).json({ error: "Escribe la instruccion para crear la tabla." });
    return;
  }

  const result = await buildTableFromPrompt(store, req.user.id, publicBaseUrl(req), prompt);
  res.status(201).json(result);
}));

app.post("/api/command", authRequired, asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).json({ error: "Escribe una instruccion." });
    return;
  }

  const parsed = store.parseSimpleCommand(req.user.id, text);
  if (!parsed) {
    res.status(400).json({
      error: "No entendi la instruccion en modo simple.",
      hint: "Prueba: agrega al cliente Fernando Hernandez, fernando@email.com, 5526997998",
    });
    return;
  }

  const result = await store.callTool(req.user.id, parsed.tool, parsed.arguments);
  res.json({
    understood: parsed,
    result,
  });
}));

app.post("/api/ai-command", authRequired, asyncRoute(async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) {
    res.status(400).json({ error: "Escribe una instruccion." });
    return;
  }

  const result = await runAiCommand(store, req.user.id, text);
  res.json(result);
}));

app.get("/workspace-api/:workspaceKey/tables/:tableName/rows", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;
  res.json({
    ok: true,
    project: target.project.title,
    ...store.listWorkspaceRows(req.params.workspaceKey, target.project.key, req.params.tableName),
  });
}));

app.post("/workspace-api/:workspaceKey/tables/:tableName/rows", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;
  const row = store.insertWorkspaceRow(
    req.params.workspaceKey,
    target.project.key,
    req.params.tableName,
    req.body || {},
  );
  res.status(201).json({ ok: true, row });
}));

app.post("/workspace-api/:workspaceKey/sql", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;
  const sql = String(req.body?.sql || "").trim();
  if (!sql) {
    res.status(400).json({ error: "Escribe el SQL." });
    return;
  }
  res.json(store.runWorkspaceSql(req.params.workspaceKey, target.project.key, sql));
}));

app.get("/workspace-api/:workspaceKey/:projectKey/tables/:tableName/rows", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;
  res.json({
    ok: true,
    project: target.project.title,
    ...store.listWorkspaceRows(req.params.workspaceKey, req.params.projectKey, req.params.tableName),
  });
}));

app.post("/workspace-api/:workspaceKey/:projectKey/tables/:tableName/rows", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;
  const row = store.insertWorkspaceRow(
    req.params.workspaceKey,
    req.params.projectKey,
    req.params.tableName,
    req.body || {},
  );
  res.status(201).json({ ok: true, row });
}));

app.post("/workspace-api/:workspaceKey/:projectKey/sql", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;
  const sql = String(req.body?.sql || "").trim();
  if (!sql) {
    res.status(400).json({ error: "Escribe el SQL." });
    return;
  }
  res.json(store.runWorkspaceSql(req.params.workspaceKey, req.params.projectKey, sql));
}));

app.options("/mcp", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.status(204).end();
});

app.options("/mcp/:workspaceKey", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.status(204).end();
});

app.get("/mcp", (req, res) => {
  const target = publishedProjectOrError(res);
  if (!target) return;

  if (handleStreamableMcp(req, res)) return;

  res.json({
    ok: true,
    message: "Este endpoint MCP publico apunta al proyecto publicado para ChatGPT.",
    project: target.project.title,
    workspaceKey: target.user.workspaceKey,
    projectKey: target.project.key,
    transport: "Streamable HTTP",
    tools: listMcpTools(store, target.user.id, target.project.key).map((tool) => tool.name),
  });
});

app.post("/mcp", asyncRoute(async (req, res) => {
  const target = publishedProjectOrError(res);
  if (!target) return;

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const replies = [];

  for (const message of messages) {
    const reply = await handleMcpMessage(store, target.user.id, message, target.project.key);
    if (reply) replies.push(reply);
  }

  if (!replies.length) {
    res.status(204).end();
    return;
  }

  res.json(Array.isArray(req.body) ? replies : replies[0]);
}));

app.get("/mcp/:workspaceKey", (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;

  if (handleStreamableMcp(req, res)) return;

  res.json({
    ok: true,
    message: "Este endpoint MCP apunta al proyecto activo del desarrollador.",
    project: target.project.title,
    transport: "Streamable HTTP",
    tools: listMcpTools(store, target.user.id, target.project.key).map((tool) => tool.name),
  });
});

app.post("/mcp/:workspaceKey", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const replies = [];

  for (const message of messages) {
    const reply = await handleMcpMessage(store, target.user.id, message, target.project.key);
    if (reply) replies.push(reply);
  }

  if (!replies.length) {
    res.status(204).end();
    return;
  }

  res.json(Array.isArray(req.body) ? replies : replies[0]);
}));

app.options("/mcp/:workspaceKey/:projectKey", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.status(204).end();
});

app.get("/mcp/:workspaceKey/:projectKey", (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;

  if (handleStreamableMcp(req, res)) return;

  res.json({
    ok: true,
    message: "Este endpoint MCP pertenece a un proyecto especifico.",
    project: target.project.title,
    transport: "Streamable HTTP",
    tools: listMcpTools(store, target.user.id, target.project.key).map((tool) => tool.name),
  });
});

app.post("/mcp/:workspaceKey/:projectKey", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;

  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const replies = [];

  for (const message of messages) {
    const reply = await handleMcpMessage(store, target.user.id, message, target.project.key);
    if (reply) replies.push(reply);
  }

  if (!replies.length) {
    res.status(204).end();
    return;
  }

  res.json(Array.isArray(req.body) ? replies : replies[0]);
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || "Error interno" });
});

app.listen(port, () => {
  console.log(`Portal: http://localhost:${port}`);
  console.log(`MCP simple: http://localhost:${port}/mcp`);
  console.log(`MCP:    http://localhost:${port}/mcp/:workspaceKey/:projectKey`);
});
