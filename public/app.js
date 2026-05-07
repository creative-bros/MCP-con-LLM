const tokenKey = "legacyMcpPortalToken";
const state = {
  token: localStorage.getItem(tokenKey) || "",
  user: null,
  projects: [],
  project: null,
  tools: [],
  databases: [],
  tables: [],
  mcpUrl: "",
  legacyMcpUrl: "",
  ai: null,
  chatGptReady: false,
};
let flashTimer = null;
let createProjectMode = false;
let editingProjectId = "";

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
        : value?.message
          ? value.message
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
  state.projects = [];
  state.project = null;
  state.tools = [];
  state.databases = [];
  state.tables = [];
  state.mcpUrl = "";
  state.legacyMcpUrl = "";
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
  if (!state.project) {
    return {
      title: "Crea tu primer proyecto",
      copy: "Cada sistema que conectes tendra su propia URL MCP, sus tools y su propia configuracion.",
    };
  }

  if (!state.ai?.configured) {
    return {
      title: "Guarda la API key del desarrollador",
      copy: "Eso activa la creacion de tablas con IA y el modo conversacional para este proyecto.",
    };
  }

  if (!state.tools.length && !state.tables.length && !state.databases.length) {
    return {
      title: "Conecta el proyecto",
      copy: "Registra una tool API, configura una base MySQL o crea una tabla interna para empezar.",
    };
  }

  if (!state.chatGptReady) {
    return {
      title: "Publica el MCP del proyecto por HTTPS",
      copy: "El proyecto ya existe. Solo falta sacar la URL con tunel o dominio para usarla en ChatGPT.",
    };
  }

  return {
    title: "El proyecto ya esta listo para pruebas",
    copy: "Usa el centro operativo, valida las tools y comparte la URL MCP especifica de este proyecto.",
  };
}

function describeDatabase(database) {
  if (database.mode === "mysql") {
    const host = database.mysql?.host || "host pendiente";
    const db = database.mysql?.database || "base pendiente";
    return `MySQL directa | ${esc(host)} | ${esc(db)}`;
  }
  if (database.mode === "http") {
    return `SQL por HTTP | ${esc(database.sqlApiUrl || "sin URL")}`;
  }
  if (database.mode === "internal") {
    return "Base interna del proyecto";
  }
  return "Solo documentacion";
}

function resetProjectForm() {
  const form = $("#project-form");
  form.reset();
  form.projectId.value = "";
}

function fillProjectForm(project) {
  const form = $("#project-form");
  if (!project) {
    resetProjectForm();
    return;
  }
  form.projectId.value = project.id || "";
  form.title.value = project.title || "";
  form.name.value = project.name || "";
  form.description.value = project.description || "";
  form.context.value = project.context || "";
  form.apiBaseUrl.value = project.apiBaseUrl || "";
}

function renderProjects() {
  const select = $("#project-select");
  select.innerHTML = state.projects.length
    ? state.projects.map((project) => `
      <option value="${esc(project.id)}" ${state.project?.id === project.id ? "selected" : ""}>
        ${esc(project.title)}
      </option>
    `).join("")
    : '<option value="">Sin proyectos</option>';

  $("#project-cards").innerHTML = state.projects.length
    ? state.projects.map((project) => `
      <article class="item project-card ${state.project?.id === project.id ? "is-active" : ""}">
        <div class="item-row">
          <div>
            <strong>${esc(project.title)}</strong>
            <small>${esc(project.key)} | ${esc(project.mcpUrl)}</small>
          </div>
          ${state.project?.id === project.id
            ? '<span class="badge">activo</span>'
            : `<button class="ghost" data-project-select="${esc(project.id)}" type="button">Abrir</button>`}
        </div>
        <p>${esc(project.description || "Sin descripcion todavia.")}</p>
        <div class="chips">
          <span class="chip">${project.counts.tools} tools</span>
          <span class="chip">${project.counts.databases} bases</span>
          <span class="chip">${project.counts.tables} tablas</span>
          <span class="chip">${project.counts.rows} registros</span>
        </div>
        <div class="row project-actions">
          <button class="ghost" data-project-edit="${esc(project.id)}" type="button">Editar</button>
          ${state.projects.length > 1
            ? `<button class="ghost" data-project-delete="${esc(project.id)}" type="button">Eliminar</button>`
            : ""}
        </div>
      </article>
    `).join("")
    : '<div class="item"><small>Aun no hay proyectos en esta cuenta.</small></div>';

  $("#project-title").textContent = state.project?.title || "Sin proyecto";
  $("#project-summary").textContent = state.project
    ? `${state.project.description || "Proyecto listo para registrar APIs, MySQL y reglas."}`
    : "Selecciona el sistema que quieres exponer en el MCP.";
  $("#project-context").textContent = state.project?.context
    || "Todo lo que registres abajo se guarda dentro del proyecto activo.";

  if (createProjectMode) {
    resetProjectForm();
    return;
  }

  const targetId = editingProjectId || state.project?.id;
  const target = state.projects.find((project) => project.id === targetId) || state.project;
  fillProjectForm(target);
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
        <small>${esc(tool.url || "Tool interna del proyecto")}</small>
        ${tool.outputExample ? `<small>Salida: ${esc(tool.outputExample)}</small>` : ""}
      </div>
    `).join("")
    : '<div class="item"><small>Aun no hay tools en este proyecto.</small></div>';
}

function renderDatabases() {
  $("#databases").innerHTML = state.databases.length
    ? state.databases.map((db) => `
      <div class="item">
        <div class="item-row">
          <strong>${esc(db.title || db.name)}</strong>
          ${db.locked ? '<span class="badge">interna</span>' : `<button class="ghost" data-delete-db="${esc(db.name)}" type="button">Eliminar</button>`}
        </div>
        <small>${esc(db.toolName)} | ${esc(db.mode)}</small>
        <small>${describeDatabase(db)}</small>
        <small>${esc(db.rules || db.documentation || "Sin reglas")}</small>
      </div>
    `).join("")
    : '<div class="item"><small>No hay bases documentadas en este proyecto.</small></div>';
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
              <p>${esc(table.description || table.rules || "Tabla interna del proyecto")}</p>
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
    : '<div class="item"><small>No hay tablas internas creadas en este proyecto.</small></div>';
}

function render() {
  const logged = Boolean(state.user && state.token);
  authVisible(logged);
  if (!logged) return;

  const step = nextStep();
  const httpsReady = state.chatGptReady;
  $("#welcome-title").textContent = state.project?.title || "Workspace";
  $("#welcome-subtitle").textContent = `${state.user.email} | proyecto activo: ${state.project?.title || "Sin proyecto"}`;
  $("#ai-status").textContent = state.ai?.configured
    ? `${state.ai.model} (${state.ai.keyPreview})`
    : "Sin key guardada";
  $("#workspace-key").textContent = state.user.workspaceKey;
  $("#project-key").textContent = state.project?.key || "-";
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
  $("#mcp-url").value = state.mcpUrl || "";
  $("#ready-note").textContent = httpsReady
    ? "Tu URL ya esta en HTTPS y se puede usar directo en ChatGPT."
    : "Esta URL es local. Para ChatGPT necesitas tunel HTTPS o dominio.";

  renderProjects();
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
    show("Cuenta creada. Ya puedes empezar a configurar tu proyecto.");
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

$("#new-project").addEventListener("click", () => {
  createProjectMode = true;
  editingProjectId = "";
  resetProjectForm();
  $("#project-form [name='title']").focus();
});

$("#project-select").addEventListener("change", async (event) => {
  const projectId = event.currentTarget.value;
  if (!projectId || projectId === state.project?.id) return;
  try {
    await api("/api/projects/select", {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
    createProjectMode = false;
    editingProjectId = "";
    await refresh();
    show("Proyecto activo actualizado.");
  } catch (err) {
    show({ error: err.message });
  }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        id: form.projectId.value,
        title: form.title.value,
        name: form.name.value,
        description: form.description.value,
        context: form.context.value,
        apiBaseUrl: form.apiBaseUrl.value,
      }),
    });
    createProjectMode = false;
    editingProjectId = "";
    await refresh();
    show("Proyecto guardado.");
  } catch (err) {
    show({ error: err.message });
  }
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
        outputExample: form.outputExample.value,
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
        toolName: form.toolName.value,
        mode: form.mode.value,
        sqlApiUrl: form.sqlApiUrl.value,
        host: form.host.value,
        port: form.port.value,
        user: form.user.value,
        password: form.password.value,
        database: form.database.value,
        documentation: form.documentation.value,
        rules: form.rules.value,
      }),
    });
    form.password.value = "";
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
    `4. Pega esta URL del proyecto: ${state.mcpUrl}`,
    "5. Guarda el conector.",
    "6. En un chat nuevo, activa ese MCP.",
    "7. Puedes preguntar cosas como:",
    "",
    "cuantas polizas tiene el sistema",
    "agrega al cliente Fernando Hernandez, fernando@email.com, 5526997998",
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

  const selectProjectId = event.target.closest("[data-project-select]")?.dataset.projectSelect;
  if (selectProjectId) {
    try {
      await api("/api/projects/select", {
        method: "POST",
        body: JSON.stringify({ projectId: selectProjectId }),
      });
      createProjectMode = false;
      editingProjectId = "";
      await refresh();
      show("Proyecto activo actualizado.");
    } catch (err) {
      show({ error: err.message });
    }
    return;
  }

  const editProjectId = event.target.closest("[data-project-edit]")?.dataset.projectEdit;
  if (editProjectId) {
    createProjectMode = false;
    editingProjectId = editProjectId;
    const project = state.projects.find((item) => item.id === editProjectId);
    fillProjectForm(project);
    $("#project-form [name='title']").focus();
    return;
  }

  const deleteProjectId = event.target.closest("[data-project-delete]")?.dataset.projectDelete;
  if (deleteProjectId) {
    try {
      await api(`/api/projects/${encodeURIComponent(deleteProjectId)}`, { method: "DELETE" });
      createProjectMode = false;
      editingProjectId = "";
      await refresh();
      show("Proyecto eliminado.");
    } catch (err) {
      show({ error: err.message });
    }
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
