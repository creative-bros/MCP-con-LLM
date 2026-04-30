const tokenKey = "legacyMcpPortalToken";
const state = {
  token: localStorage.getItem(tokenKey) || "",
  user: null,
  tools: [],
  databases: [],
  tables: [],
  mcpUrl: "",
  ai: null,
  chatGptReady: false,
};
let flashTimer = null;

const $ = (selector) => document.querySelector(selector);

function show(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const flash = $("#flash");
  const flashText = typeof value === "string"
    ? value
    : value?.error
      ? `Error: ${value.error}`
      : value?.paso
        ? value.paso
        : "Respuesta actualizada.";

  if ($("#output")) $("#output").textContent = text;
  flash.textContent = flashText;
  flash.classList.remove("hidden");
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => flash.classList.add("hidden"), 5000);
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, options = {}, useAuth = true) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (useAuth && state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(path, {
    ...options,
    headers,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (response.status === 401 && useAuth) {
    clearSession();
    render();
    throw new Error(data?.error || "Tu sesion expiro.");
  }

  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function mcp(method, params) {
  const response = await fetch(state.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

function clearSession() {
  state.token = "";
  state.user = null;
  state.tools = [];
  state.databases = [];
  state.tables = [];
  state.mcpUrl = "";
  state.ai = null;
  localStorage.removeItem(tokenKey);
}

function setSession(token, payload) {
  state.token = token;
  localStorage.setItem(tokenKey, token);
  state.user = payload.user || payload.state?.user || null;
  Object.assign(state, payload.state || {});
}

function authVisible(showApp) {
  $("#auth-view").classList.toggle("hidden", showApp);
  $("#app-view").classList.toggle("hidden", !showApp);
}

function setAuthTab(target) {
  const loginActive = target !== "register";
  $("#tab-login").classList.toggle("is-active", loginActive);
  $("#tab-register").classList.toggle("is-active", !loginActive);
  $("#panel-login").classList.toggle("hidden", !loginActive);
  $("#panel-register").classList.toggle("hidden", loginActive);
}

function setAuthModal(open, target = "login") {
  $("#auth-modal").classList.toggle("hidden", !open);
  if (open) setAuthTab(target);
}

function totalRows() {
  return state.tables.reduce((sum, table) => sum + (table.rows?.length || 0), 0);
}

function nextStep() {
  if (!state.ai?.configured) {
    return {
      title: "Guarda la API key del desarrollador",
      copy: "Eso activa la creacion de tablas con IA y el modo conversacional dentro del portal.",
    };
  }

  if (!state.tools.length && !state.tables.length) {
    return {
      title: "Crea tu primera estructura",
      copy: "Puedes cargar la demo para avanzar rapido o crear una tabla propia desde una instruccion.",
    };
  }

  if (!state.chatGptReady) {
    return {
      title: "Publica tu MCP por HTTPS",
      copy: "Tu workspace ya existe. Solo falta sacar la URL local con un tunel o dominio para usarla en ChatGPT.",
    };
  }

  return {
    title: "Tu portal ya esta listo para pruebas",
    copy: "Usa el centro operativo para probar altas y luego comparte la URL MCP con tu cliente o con ChatGPT.",
  };
}

function renderTools() {
  $("#tools").innerHTML = state.tools.length
    ? state.tools.map((tool) => `
      <div class="item">
        <div class="item-row">
          <strong>${esc(tool.title || tool.name)}</strong>
          ${tool.locked ? '<span class="badge">fijo</span>' : `<button class="ghost" data-delete-tool="${esc(tool.name)}" type="button">Eliminar</button>`}
        </div>
        <small>${esc(tool.name)} | ${esc(tool.method)} | ${esc(tool.source || "manual")}</small>
        <small>${esc(tool.url)}</small>
      </div>
    `).join("")
    : '<div class="item"><small>Aun no hay tools en este workspace.</small></div>';
}

function renderDatabases() {
  $("#databases").innerHTML = state.databases.length
    ? state.databases.map((db) => `
      <div class="item">
        <div class="item-row">
          <strong>${esc(db.title || db.name)}</strong>
          ${db.locked ? '<span class="badge">interna</span>' : `<button class="ghost" data-delete-db="${esc(db.name)}" type="button">Eliminar</button>`}
        </div>
        <small>${esc(db.toolName)}</small>
        <small>${esc(db.rules || db.documentation || "Sin reglas")}</small>
      </div>
    `).join("")
    : '<div class="item"><small>No hay bases documentadas.</small></div>';
}

function renderTables() {
  $("#tables").innerHTML = state.tables.length
    ? state.tables.map((table) => {
      const columns = table.fields.map((field) => `<th>${esc(field.label)}</th>`).join("");
      const rows = (table.rows || []).length
        ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>ID</th>${columns}<th>Creado</th></tr>
              </thead>
              <tbody>
                ${(table.rows || []).slice(0, 6).map((row) => `
                  <tr>
                    <td>${esc(row.id)}</td>
                    ${table.fields.map((field) => `<td>${esc(row[field.name])}</td>`).join("")}
                    <td>${esc(row.createdAt)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `
        : '<div class="empty-mini">Sin registros todavia.</div>';

      return `
        <article class="table-card">
          <div class="item-row">
            <div>
              <h3>${esc(table.title || table.name)}</h3>
              <p>${esc(table.description || table.rules || "Tabla interna del portal")}</p>
            </div>
            <button class="ghost" data-delete-table="${esc(table.name)}" type="button">Eliminar</button>
          </div>
          <div class="chips">
            ${table.fields.map((field) => `<span class="chip">${esc(field.label)} | ${esc(field.type)}</span>`).join("")}
          </div>
          ${rows}
        </article>
      `;
    }).join("")
    : '<div class="item"><small>No hay tablas internas creadas.</small></div>';
}

function render() {
  const logged = Boolean(state.user && state.token);
  authVisible(logged);
  if (!logged) return;

  const step = nextStep();
  const httpsReady = state.chatGptReady;
  $("#welcome-title").textContent = `Hola, ${state.user.name}`;
  $("#welcome-subtitle").textContent = `${state.user.email} | tu MCP es independiente del resto de desarrolladores`;
  $("#ai-status").textContent = state.ai?.configured
    ? `${state.ai.model} (${state.ai.keyPreview})`
    : "Sin key guardada";
  $("#workspace-key").textContent = state.user.workspaceKey;
  $("#account-panel").dataset.connection = httpsReady ? "ready" : "local";
  $("#account-ready-label").textContent = httpsReady ? "Listo para conectar" : "Pendiente de publicar";
  $("#https-status").textContent = httpsReady ? "HTTPS listo" : "Solo local";
  $("#https-help").textContent = httpsReady
    ? "Tu URL ya puede usarse desde fuera del sistema."
    : "Necesitas un dominio o tunel HTTPS para conectar ChatGPT.";
  $("#mcp-badge").textContent = httpsReady ? "Listo para ChatGPT" : "Requiere HTTPS";
  $("#next-step-title").textContent = step.title;
  $("#next-step-copy").textContent = step.copy;
  $("#tools-count").textContent = state.tools.length;
  $("#tables-count").textContent = state.tables.length;
  $("#db-count").textContent = state.databases.length;
  $("#rows-count").textContent = totalRows();
  $("#mcp-url").value = state.mcpUrl;
  $("#ready-note").textContent = httpsReady
    ? "Tu URL ya esta en HTTPS y se puede usar directo en ChatGPT."
    : "Esta URL es local. Para ChatGPT necesitas tunel HTTPS o dominio.";

  renderTools();
  renderDatabases();
  renderTables();
}

async function refresh() {
  const data = await api("/api/state");
  Object.assign(state, data);
  state.user = data.user;
  render();
}

async function hydrateSession() {
  if (!state.token) {
    render();
    return;
  }

  try {
    const data = await api("/api/auth/session");
    state.user = data.user;
    Object.assign(state, data.state);
    render();
  } catch (err) {
    show({ error: err.message });
  }
}

$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value,
        email: form.email.value,
        password: form.password.value,
      }),
    }, false);
    setSession(result.token, result);
    form.reset();
    setAuthModal(false);
    render();
    show("Cuenta creada. Ya puedes empezar a configurar tu portal.");
  } catch (err) {
    show({ error: err.message });
  }
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: form.email.value,
        password: form.password.value,
      }),
    }, false);
    setSession(result.token, result);
    form.reset();
    setAuthModal(false);
    render();
    show("Sesion iniciada.");
  } catch (err) {
    show({ error: err.message });
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // Ignore logout errors and clear local state anyway.
  }
  clearSession();
  render();
});

$("#refresh").addEventListener("click", () => {
  refresh().catch((err) => show({ error: err.message }));
});

$("#load-demo").addEventListener("click", async () => {
  try {
    const result = await api("/api/demo", { method: "POST" });
    show({ paso: "Demo cargada", result });
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ text: $("#command").value }),
    });
    show(result);
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#ai-command").addEventListener("click", async () => {
  try {
    const result = await api("/api/ai-command", {
      method: "POST",
      body: JSON.stringify({ text: $("#command").value }),
    });
    show(result);
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        openaiApiKey: form.openaiApiKey.value,
        openaiModel: form.openaiModel.value,
      }),
    });
    form.openaiApiKey.value = "";
    show({ paso: "Configuracion guardada", result });
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#ai-table-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/ai-table", {
      method: "POST",
      body: JSON.stringify({ prompt: form.prompt.value }),
    });
    show(result);
    form.reset();
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#table-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/tables", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value,
        title: form.title.value,
        description: form.description.value,
        rules: form.rules.value,
        fields: form.fields.value,
      }),
    });
    show({ paso: "Tabla guardada", result });
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#tool-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/tools", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value,
        title: form.title.value,
        method: form.method.value,
        url: form.url.value,
        description: form.description.value,
        inputSchema: form.inputSchema.value,
      }),
    });
    show({ paso: "Tool guardada", result });
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#db-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/databases", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value,
        title: form.title.value,
        sqlApiUrl: form.sqlApiUrl.value,
        documentation: form.documentation.value,
        rules: form.rules.value,
      }),
    });
    show({ paso: "Base guardada", result });
    await refresh();
  } catch (err) {
    show({ error: err.message });
  }
});

$("#copy-url").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.mcpUrl);
  show({ copiado: state.mcpUrl });
});

$("#copy-steps").addEventListener("click", async () => {
  const steps = [
    "1. Abre ChatGPT en Windows.",
    "2. Entra a Configuracion > Aplicaciones o Connectors.",
    "3. Crea un nuevo conector MCP.",
    `4. Pega esta URL: ${state.mcpUrl}`,
    "5. Guarda el conector.",
    "6. En un chat nuevo, activa ese MCP.",
    "7. Escribe una instruccion como:",
    "",
    "agrega al cliente:",
    "Fernando Hernandez",
    "fernando@email.com",
    "5526997998",
  ].join("\n");
  await navigator.clipboard.writeText(steps);
  show("Pasos copiados.");
});

$("#auth-open").addEventListener("click", () => {
  setAuthModal(true, "login");
});

$("#auth-close").addEventListener("click", () => {
  setAuthModal(false);
});

$("#auth-overlay").addEventListener("click", () => {
  setAuthModal(false);
});

$("#mcp-list").addEventListener("click", async () => {
  try {
    show(await mcp("tools/list"));
  } catch (err) {
    show({ error: err.message });
  }
});

document.addEventListener("click", async (event) => {
  const authTarget = event.target.closest("[data-auth-target]")?.dataset.authTarget;
  if (authTarget) {
    setAuthTab(authTarget);
    return;
  }

  const prompt = event.target.closest("[data-prompt]")?.dataset.prompt;
  if (prompt) {
    $("#command").value = prompt;
    $("#command").focus();
    show("Ejemplo cargado en el centro operativo.");
    return;
  }

  const toolName = event.target.closest("[data-delete-tool]")?.dataset.deleteTool;
  if (toolName) {
    try {
      await api(`/api/tools/${encodeURIComponent(toolName)}`, { method: "DELETE" });
      show(`Tool ${toolName} eliminada.`);
      await refresh();
    } catch (err) {
      show({ error: err.message });
    }
    return;
  }

  const dbName = event.target.closest("[data-delete-db]")?.dataset.deleteDb;
  if (dbName) {
    try {
      await api(`/api/databases/${encodeURIComponent(dbName)}`, { method: "DELETE" });
      show(`Base ${dbName} eliminada.`);
      await refresh();
    } catch (err) {
      show({ error: err.message });
    }
    return;
  }

  const tableName = event.target.closest("[data-delete-table]")?.dataset.deleteTable;
  if (tableName) {
    try {
      await api(`/api/tables/${encodeURIComponent(tableName)}`, { method: "DELETE" });
      show(`Tabla ${tableName} eliminada.`);
      await refresh();
    } catch (err) {
      show({ error: err.message });
    }
  }
});

hydrateSession().catch((err) => show({ error: err.message }));
