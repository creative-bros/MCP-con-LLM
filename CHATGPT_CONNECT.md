# Conectar ChatGPT al MCP

La idea es que el usuario final use **solo ChatGPT** y desde ahi escriba instrucciones como:

```text
agrega al cliente Fernando Hernandez, fernando@email.com, 5526997998
```

o preguntas como:

```text
cuantas polizas tiene el sistema
muestrame las polizas vigentes
que puedes hacer en este proyecto
```

## 1. Levanta el portal

```powershell
cd C:\Users\ignac\mcp-server
$env:PORT=3072
npm start
```

## 2. Publica una URL HTTPS

Ejemplo con LocalTunnel:

```powershell
npx -y localtunnel --port 3072 --local-host 127.0.0.1
```

Si te da una URL como:

```text
https://twenty-moose-search.loca.lt
```

entonces el endpoint simple para ChatGPT sera:

```text
https://twenty-moose-search.loca.lt/mcp
```

## 3. Verifica el MCP antes de pegarlo en ChatGPT

```powershell
npm run mcp:check -- https://twenty-moose-search.loca.lt/mcp
```

Si todo esta bien, veras algo como:

```text
Servidor: Legacy MCP Portal
Tools: guiaProyecto, ...
MCP OK
```

## 4. Pegalo en ChatGPT

En ChatGPT desarrollador:

1. Abre la parte de conectores o aplicaciones.
2. Agrega un nuevo servidor MCP.
3. Pega la URL:

```text
https://twenty-moose-search.loca.lt/mcp
```

## 5. Da las indicaciones desde el chat

Ya conectado, el usuario final puede escribir directamente en ChatGPT:

```text
que puedes hacer en este proyecto
```

```text
quiero ver las polizas vigentes
```

```text
agrega al cliente Fernando Hernandez, fernando@email.com, 5526997998
```

Tambien puede preparar el proyecto desde el mismo chat, por ejemplo:

```text
crea una tabla clientes con nombre, email, telefono y status.
status 1 significa activo y -1 significa inactivo.
```

```text
registra la api /agregaCliente como tool del proyecto.
Es POST y recibe nombre, email y telefono.
```

```text
guarda este archivo como polizas.sql y luego dime que consultas soporta:
SELECT folio, cliente, status FROM polizas WHERE status = 1;
```

## Como decide ChatGPT que hacer

Este MCP ya expone una guia llamada `guiaProyecto` para que ChatGPT sepa si la solicitud del usuario es:

- una accion
- una consulta
- una visualizacion
- una solicitud de ayuda

Con eso ChatGPT puede:

- pedir datos faltantes
- consultar una base
- mostrar resultados
- ejecutar una tool
- crear tablas internas
- registrar APIs legacy
- documentar bases
- guardar codigo, SQL o documentos del proyecto

## Nota importante

La URL simple `.../mcp` funciona asi:

- si hay un solo usuario/proyecto, lo publica automaticamente
- si hay varios proyectos, puedes fijar uno con variables de entorno:

```powershell
$env:PUBLIC_MCP_WORKSPACE_KEY="TU_WORKSPACE_KEY"
$env:PUBLIC_MCP_PROJECT_KEY="TU_PROJECT_KEY"
npm start
```
