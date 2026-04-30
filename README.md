# Legacy MCP Portal

Portal interno para que cada desarrollador cree su propio workspace, guarde su propia OpenAI API key, registre APIs legacy como tools MCP y genere tablas internas desde instrucciones.

## Lo nuevo

- Login y creacion de usuario
- Un workspace por desarrollador
- Una API key por cuenta
- URL MCP personal por workspace
- Constructor de tablas internas con IA
- Tools internas autogeneradas como `crear_clientes` o `listar_prospectos`
- Base interna consultable por SQL read-only demo

## Ejecutar

```powershell
cd C:\Users\ignac\mcp-server
$env:PORT=3060
npm start
```

Abre:

```text
http://localhost:3060
```

## Flujo recomendado

1. Crea tu usuario en la pantalla inicial.
2. Entra al sistema.
3. Guarda tu propia OpenAI API key en `Cuenta y MCP`.
4. Carga la demo si quieres un arranque rapido.
5. O crea una tabla con IA usando algo como:

```text
Crea una tabla prospectos con nombre, empresa, telefono, correo y status.
Status 1 significa activo y -1 significa descartado.
```

6. El portal crea la tabla y tambien tools internas para usarla desde chat.
7. Prueba en `Centro operativo` con una instruccion natural.

## Registrar APIs legacy

En `Tools API externas` puedes registrar endpoints reales de tu sistema:

- `agregaCliente`
- `emiteFactura`
- `actualizaPedido`
- cualquier otra accion que tu sistema exponga por HTTP

Cada tool se publica en el MCP personal del desarrollador.

## MCP por usuario

El MCP ya no vive en una sola URL global. Cada cuenta tiene su propia URL:

```text
http://localhost:3060/mcp/TU_WORKSPACE_KEY
```

Cuando uses tunel HTTPS, la forma es:

```text
https://tu-dominio-o-tunel/mcp/TU_WORKSPACE_KEY
```

## ChatGPT en Windows

ChatGPT no se conecta directo a `localhost`. Necesitas HTTPS publico. Para una prueba rapida:

```powershell
npx -y localtunnel --port 3060 --local-host 127.0.0.1
```

Luego entra al portal, copia tu `URL MCP personal` y pegala en ChatGPT.

## Verificacion

Chequeo sintactico:

```powershell
npm test
```

Chequeo MCP:

```powershell
node scripts/check-mcp.js http://127.0.0.1:3060/mcp/TU_WORKSPACE_KEY
```
