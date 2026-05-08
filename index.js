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
app.use(express.urlencoded({ extended: false }));
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

function isSecureRequest(req) {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  return proto === "https";
}

function parseCookies(req) {
  const raw = req.get("cookie") || "";
  return Object.fromEntries(
    raw
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [key, ...rest] = item.split("=");
        return [key, decodeURIComponent(rest.join("=") || "")];
      }),
  );
}

function readPortalCookie(req) {
  return parseCookies(req).portal_session || "";
}

function setPortalCookie(req, res, token) {
  const parts = [
    `portal_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function clearPortalCookie(req, res) {
  const parts = [
    "portal_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function isLocalHost(req) {
  const host = req.hostname || "";
  return ["localhost", "127.0.0.1"].includes(host);
}

function oauthScopes() {
  return "mcp:read mcp:write";
}

function oauthResourceMetadataUrl(req) {
  return `${publicBaseUrl(req)}/.well-known/oauth-protected-resource`;
}

function oauthIssuer(req) {
  return publicBaseUrl(req);
}

function oauthMetadata(req) {
  const base = publicBaseUrl(req);
  return {
    issuer: oauthIssuer(req),
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: oauthScopes().split(" "),
  };
}

function parseMcpResource(resource) {
  const url = new URL(resource);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "mcp") {
    throw new Error("El recurso OAuth no corresponde a una ruta MCP.");
  }
  return {
    workspaceKey: parts[1] || "",
    projectKey: parts[2] || "",
    pathname: url.pathname,
  };
}

function oauthTargetFromResource(resource) {
  if (!resource) return store.getPublishedProject();
  const parsed = parseMcpResource(resource);
  if (!parsed.workspaceKey) return store.getPublishedProject();
  return store.getWorkspaceProject(parsed.workspaceKey, parsed.projectKey);
}

function oauthChallenge(res, req) {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="legacy-mcp-portal", resource_metadata="${oauthResourceMetadataUrl(req)}", scope="${oauthScopes()}"`,
  );
}

function oauthUserForRequest(req) {
  const token = readToken(req);
  if (!token) return null;
  const access = store.getOauthToken(token);
  if (!access) return null;
  const user = store.getUserByWorkspaceKey(access.workspaceKey);
  if (!user || user.id !== access.userId) return null;
  return { user, access };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderOauthPage({
  title,
  subtitle,
  body,
}) {
  return `<!doctype html>
  <html lang="es">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title}</title>
      <style>
        :root {
          color: #25313c;
          font-family: "Segoe UI", sans-serif;
          background: linear-gradient(180deg, #f7f3ea 0%, #efe9dd 100%);
        }
        * { box-sizing: border-box; }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
        .card {
          width: min(560px, 100%);
          border-radius: 28px;
          background: rgba(255, 251, 245, 0.96);
          border: 1px solid rgba(37, 49, 60, 0.08);
          box-shadow: 0 28px 70px rgba(45, 31, 19, 0.18);
          padding: 24px;
        }
        .eyebrow { margin: 0 0 10px; color: #9f4a29; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
        h1 { margin: 0; font-size: 2rem; font-family: Georgia, serif; line-height: 1.1; }
        p, li, small { color: #66727f; line-height: 1.6; }
        label { display: grid; gap: 6px; font-size: 13px; font-weight: 700; margin-top: 12px; }
        input, textarea { width: 100%; border: 1px solid rgba(37, 49, 60, 0.12); border-radius: 12px; background: rgba(255,255,255,0.88); padding: 12px 13px; font: inherit; }
        button { min-height: 44px; border: 1px solid #c86f4a; border-radius: 12px; background: linear-gradient(180deg, #c86f4a 0%, #9f4a29 100%); color: #fffaf5; padding: 0 16px; font-weight: 700; cursor: pointer; }
        .secondary { background: rgba(255,255,255,0.72); color: #25313c; border-color: rgba(37,49,60,0.1); }
        .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
        .box { padding: 14px; border-radius: 16px; border: 1px solid rgba(37,49,60,0.08); background: rgba(255,255,255,0.58); margin-top: 14px; }
        .error { color: #9b1c1c; background: rgba(254, 242, 242, 0.96); border-color: rgba(239, 68, 68, 0.2); }
      </style>
    </head>
    <body>
      <main class="card">
        <p class="eyebrow">Legacy MCP Portal</p>
        <h1>${title}</h1>
        <p>${subtitle}</p>
        ${body}
      </main>
    </body>
  </html>`;
}

function authRequired(req, res, next) {
  const token = readToken(req) || readPortalCookie(req);
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

function messagesNeedOauth(messages) {
  return (messages || []).some((message) => message?.method === "tools/call");
}

function ensureMcpOauth(req, res, target, messages) {
  if (isLocalHost(req)) return true;
  if (!messagesNeedOauth(messages)) return true;

  const oauth = oauthUserForRequest(req);
  if (!oauth) {
    oauthChallenge(res, req);
    res.status(401).json({
      error: "ChatGPT necesita completar el flujo OAuth antes de ejecutar tools en este MCP.",
    });
    return false;
  }

  if (oauth.user.id !== target.user.id) {
    oauthChallenge(res, req);
    res.status(403).json({
      error: "El token OAuth no corresponde al desarrollador dueño de este proyecto.",
    });
    return false;
  }

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
    oauthClients: data.oauthClients?.length || 0,
    mcpPattern: `${publicBaseUrl(req)}/mcp/:workspaceKey/:projectKey`,
    publicMcpUrl: publicMcp,
  });
});

function protectedResourceResponse(req, res) {
  const pathParts = [];
  if (req.params.workspaceKey) pathParts.push(req.params.workspaceKey);
  if (req.params.projectKey) pathParts.push(req.params.projectKey);
  const defaultResource = `${publicBaseUrl(req)}/mcp${pathParts.length ? `/${pathParts.join("/")}` : ""}`;
  const resource = String(req.query.resource || defaultResource).trim();
  res.json({
    resource,
    authorization_servers: [oauthIssuer(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: oauthScopes().split(" "),
  });
}

app.get([
  "/.well-known/oauth-protected-resource",
  "/mcp/.well-known/oauth-protected-resource",
  "/mcp/:workspaceKey/.well-known/oauth-protected-resource",
  "/mcp/:workspaceKey/:projectKey/.well-known/oauth-protected-resource",
], protectedResourceResponse);

app.get([
  "/.well-known/oauth-authorization-server",
  "/mcp/.well-known/oauth-authorization-server",
  "/mcp/:workspaceKey/.well-known/oauth-authorization-server",
  "/mcp/:workspaceKey/:projectKey/.well-known/oauth-authorization-server",
], (req, res) => {
  res.json(oauthMetadata(req));
});

app.get([
  "/.well-known/openid-configuration",
  "/mcp/.well-known/openid-configuration",
  "/mcp/:workspaceKey/.well-known/openid-configuration",
  "/mcp/:workspaceKey/:projectKey/.well-known/openid-configuration",
], (req, res) => {
  res.json(oauthMetadata(req));
});

app.post("/oauth/register", asyncRoute(async (req, res) => {
  const client = store.registerOauthClient(req.body || {});
  res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: client.responseTypes,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope,
  });
}));

app.get("/oauth/authorize", asyncRoute(async (req, res) => {
  const clientId = String(req.query.client_id || "").trim();
  const redirectUri = String(req.query.redirect_uri || "").trim();
  const stateParam = String(req.query.state || "").trim();
  const scope = String(req.query.scope || oauthScopes()).trim();
  const resource = String(req.query.resource || "").trim();
  const codeChallenge = String(req.query.code_challenge || "").trim();
  const codeChallengeMethod = String(req.query.code_challenge_method || "S256").trim();

  const client = store.getOauthClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    res.status(400).send(renderOauthPage({
      title: "Cliente OAuth invalido",
      subtitle: "No pude validar el cliente que intenta conectar ChatGPT.",
      body: '<div class="box error"><strong>Verifica el registro dinamico del cliente y vuelve a intentar.</strong></div>',
    }));
    return;
  }

  let target = null;
  try {
    target = oauthTargetFromResource(resource);
  } catch (err) {
    res.status(400).send(renderOauthPage({
      title: "Recurso MCP invalido",
      subtitle: err.message,
      body: "",
    }));
    return;
  }

  const sessionToken = readPortalCookie(req);
  const sessionUser = store.getUserByToken(sessionToken);
  const hiddenFields = `
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}" />
    <input type="hidden" name="state" value="${escapeHtml(stateParam)}" />
    <input type="hidden" name="scope" value="${escapeHtml(scope)}" />
    <input type="hidden" name="resource" value="${escapeHtml(resource)}" />
    <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}" />
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}" />
  `;

  if (!sessionUser) {
    res.send(renderOauthPage({
      title: "Autoriza tu MCP en ChatGPT",
      subtitle: `Inicia sesion con la cuenta que administra el proyecto "${escapeHtml(target.project.title)}".`,
      body: `
        <div class="box">
          <strong>Proyecto</strong>
          <p>${escapeHtml(target.project.title)}</p>
          <small>Workspace ${escapeHtml(target.user.workspaceKey)}</small>
        </div>
        <form method="post" action="/oauth/authorize">
          ${hiddenFields}
          <input type="hidden" name="action" value="login" />
          <label>Correo <input name="email" type="email" placeholder="ignacio@empresa.com" required /></label>
          <label>Contrasena <input name="password" type="password" placeholder="Tu contrasena" required /></label>
          <div class="row">
            <button type="submit">Entrar y continuar</button>
          </div>
        </form>
      `,
    }));
    return;
  }

  if (sessionUser.id !== target.user.id) {
    res.status(403).send(renderOauthPage({
      title: "Cuenta incorrecta",
      subtitle: "La sesion actual no corresponde al desarrollador dueño de este proyecto.",
      body: `
        <div class="box error">
          <strong>Entra con la cuenta correcta para autorizar este MCP.</strong>
          <p>Proyecto: ${escapeHtml(target.project.title)}</p>
          <p>Workspace: ${escapeHtml(target.user.workspaceKey)}</p>
        </div>
      `,
    }));
    return;
  }

  res.send(renderOauthPage({
    title: "Autoriza el acceso de ChatGPT",
    subtitle: "ChatGPT podra leer y ejecutar tools del proyecto con los permisos que apruebes aqui.",
    body: `
      <div class="box">
        <strong>Proyecto</strong>
        <p>${escapeHtml(target.project.title)}</p>
        <small>Scopes solicitados: ${escapeHtml(scope || oauthScopes())}</small>
      </div>
      <div class="box">
        <strong>Cuenta</strong>
        <p>${escapeHtml(sessionUser.email)}</p>
      </div>
      <form method="post" action="/oauth/authorize">
        ${hiddenFields}
        <input type="hidden" name="action" value="approve" />
        <div class="row">
          <button type="submit">Autorizar en ChatGPT</button>
        </div>
      </form>
      <form method="post" action="/oauth/authorize">
        ${hiddenFields}
        <input type="hidden" name="action" value="deny" />
        <div class="row">
          <button class="secondary" type="submit">Cancelar</button>
        </div>
      </form>
    `,
  }));
}));

app.post("/oauth/authorize", asyncRoute(async (req, res) => {
  const action = String(req.body?.action || "").trim();
  const clientId = String(req.body?.client_id || "").trim();
  const redirectUri = String(req.body?.redirect_uri || "").trim();
  const stateParam = String(req.body?.state || "").trim();
  const scope = String(req.body?.scope || oauthScopes()).trim();
  const resource = String(req.body?.resource || "").trim();
  const codeChallenge = String(req.body?.code_challenge || "").trim();
  const codeChallengeMethod = String(req.body?.code_challenge_method || "S256").trim();

  const client = store.getOauthClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) {
    res.status(400).send("Cliente OAuth invalido.");
    return;
  }

  let target = null;
  try {
    target = oauthTargetFromResource(resource);
  } catch (err) {
    res.status(400).send(err.message);
    return;
  }

  if (action === "login") {
    const login = store.loginUser({
      email: req.body?.email,
      password: req.body?.password,
    });
    setPortalCookie(req, res, login.token);
    const next = new URL(`${publicBaseUrl(req)}/oauth/authorize`);
    next.searchParams.set("client_id", clientId);
    next.searchParams.set("redirect_uri", redirectUri);
    next.searchParams.set("state", stateParam);
    next.searchParams.set("scope", scope);
    next.searchParams.set("resource", resource);
    next.searchParams.set("code_challenge", codeChallenge);
    next.searchParams.set("code_challenge_method", codeChallengeMethod);
    res.redirect(next.toString());
    return;
  }

  if (action === "deny") {
    const denied = new URL(redirectUri);
    denied.searchParams.set("error", "access_denied");
    if (stateParam) denied.searchParams.set("state", stateParam);
    res.redirect(denied.toString());
    return;
  }

  const sessionUser = store.getUserByToken(readPortalCookie(req));
  if (!sessionUser) {
    res.redirect(`${publicBaseUrl(req)}/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(stateParam)}&scope=${encodeURIComponent(scope)}&resource=${encodeURIComponent(resource)}&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=${encodeURIComponent(codeChallengeMethod)}`);
    return;
  }

  if (sessionUser.id !== target.user.id) {
    res.status(403).send("La cuenta autenticada no corresponde a este proyecto.");
    return;
  }

  const code = store.createOauthCode({
    clientId,
    userId: sessionUser.id,
    workspaceKey: target.user.workspaceKey,
    projectKey: target.project.key,
    redirectUri,
    scope,
    resource,
    codeChallenge,
    codeChallengeMethod,
  });

  const approved = new URL(redirectUri);
  approved.searchParams.set("code", code.code);
  if (stateParam) approved.searchParams.set("state", stateParam);
  res.redirect(approved.toString());
}));

app.post("/oauth/token", asyncRoute(async (req, res) => {
  const grantType = String(req.body?.grant_type || "").trim();
  if (grantType !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  const token = store.exchangeOauthCode({
    code: req.body?.code,
    clientId: req.body?.client_id,
    redirectUri: req.body?.redirect_uri,
    codeVerifier: req.body?.code_verifier,
  });

  res.json({
    access_token: token.accessToken,
    token_type: "Bearer",
    expires_in: 12 * 60 * 60,
    scope: token.scope,
  });
}));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const result = store.registerUser(req.body || {});
  setPortalCookie(req, res, result.token);
  res.status(201).json({
    ...result,
    state: store.getState(result.user.id, publicBaseUrl(req)),
  });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const result = store.loginUser(req.body || {});
  setPortalCookie(req, res, result.token);
  res.json({
    ...result,
    state: store.getState(result.user.id, publicBaseUrl(req)),
  });
}));

app.post("/api/auth/logout", authRequired, (req, res) => {
  store.logout(req.token);
  clearPortalCookie(req, res);
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

app.post("/api/tables/:tableName/rows", authRequired, asyncRoute(async (req, res) => {
  const projectKey = store.getState(req.user.id, publicBaseUrl(req)).project.key;
  const row = store.insertWorkspaceRow(
    req.user.workspaceKey,
    projectKey,
    req.params.tableName,
    req.body || {},
    { source: "portal", toolTitle: `Nuevo registro en ${req.params.tableName}` },
  );
  res.status(201).json({ ok: true, row });
}));

app.put("/api/tables/:tableName/rows/:rowId", authRequired, asyncRoute(async (req, res) => {
  const projectKey = store.getState(req.user.id, publicBaseUrl(req)).project.key;
  const row = store.updateWorkspaceRow(
    req.user.workspaceKey,
    projectKey,
    req.params.tableName,
    req.params.rowId,
    req.body || {},
    { source: "portal", toolTitle: `Registro actualizado en ${req.params.tableName}` },
  );
  res.json({ ok: true, row });
}));

app.delete("/api/tables/:tableName/rows/:rowId", authRequired, asyncRoute(async (req, res) => {
  const projectKey = store.getState(req.user.id, publicBaseUrl(req)).project.key;
  const deleted = store.deleteWorkspaceRow(
    req.user.workspaceKey,
    projectKey,
    req.params.tableName,
    req.params.rowId,
    { source: "portal", toolTitle: `Registro eliminado de ${req.params.tableName}` },
  );
  res.json({ ok: true, deleted });
}));

app.post("/api/resources", authRequired, (req, res) => {
  res.status(201).json(store.saveResource(req.user.id, req.body || {}));
});

app.get("/api/resources/:resourceId", authRequired, (req, res) => {
  res.json(store.getResource(req.user.id, req.params.resourceId));
});

app.delete("/api/resources/:resourceId", authRequired, (req, res) => {
  store.deleteResource(req.user.id, req.params.resourceId);
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

app.put("/workspace-api/:workspaceKey/tables/:tableName/rows/:rowId", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;
  const row = store.updateWorkspaceRow(
    req.params.workspaceKey,
    target.project.key,
    req.params.tableName,
    req.params.rowId,
    req.body || {},
    { source: "workspace-api", toolTitle: `Registro actualizado en ${req.params.tableName}` },
  );
  res.json({ ok: true, row });
}));

app.delete("/workspace-api/:workspaceKey/tables/:tableName/rows/:rowId", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey);
  if (!target) return;
  const deleted = store.deleteWorkspaceRow(
    req.params.workspaceKey,
    target.project.key,
    req.params.tableName,
    req.params.rowId,
    { source: "workspace-api", toolTitle: `Registro eliminado de ${req.params.tableName}` },
  );
  res.json({ ok: true, deleted });
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

app.put("/workspace-api/:workspaceKey/:projectKey/tables/:tableName/rows/:rowId", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;
  const row = store.updateWorkspaceRow(
    req.params.workspaceKey,
    req.params.projectKey,
    req.params.tableName,
    req.params.rowId,
    req.body || {},
    { source: "workspace-api", toolTitle: `Registro actualizado en ${req.params.tableName}` },
  );
  res.json({ ok: true, row });
}));

app.delete("/workspace-api/:workspaceKey/:projectKey/tables/:tableName/rows/:rowId", asyncRoute(async (req, res) => {
  const target = workspaceProjectOr404(res, req.params.workspaceKey, req.params.projectKey);
  if (!target) return;
  const deleted = store.deleteWorkspaceRow(
    req.params.workspaceKey,
    req.params.projectKey,
    req.params.tableName,
    req.params.rowId,
    { source: "workspace-api", toolTitle: `Registro eliminado de ${req.params.tableName}` },
  );
  res.json({ ok: true, deleted });
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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.status(204).end();
});

app.options("/mcp/:workspaceKey", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
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
  if (!ensureMcpOauth(req, res, target, messages)) return;
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
  if (!ensureMcpOauth(req, res, target, messages)) return;
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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id");
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
  if (!ensureMcpOauth(req, res, target, messages)) return;
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
