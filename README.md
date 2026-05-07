# Legacy MCP Portal

Portal interno para que cada desarrollador cree proyectos por sistema, guarde su propia OpenAI API key, registre APIs legacy como tools MCP y conecte bases MySQL o tablas internas desde instrucciones.

## Lo nuevo

- Login y creacion de usuario
- Un workspace por desarrollador
- Multiples proyectos por cuenta
- Una API key por cuenta
- URL MCP por proyecto
- Constructor de tablas internas con IA
- Tools internas autogeneradas como `crear_clientes` o `listar_prospectos`
- Base interna consultable por SQL read-only demo
- Registro de salida esperada por tool
- Configuracion de bases en modo MySQL directa, SQL por HTTP o solo documentacion
- Guia MCP para que ChatGPT sepa cuando ejecutar, consultar, visualizar o pedir datos faltantes

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
3. Crea o selecciona un proyecto.
4. Guarda tu propia OpenAI API key en `Cuenta y MCP`.
5. Registra sus APIs, su MySQL o carga la demo si quieres un arranque rapido.
6. O crea una tabla con IA usando algo como:

```text
Crea una tabla prospectos con nombre, empresa, telefono, correo y status.
Status 1 significa activo y -1 significa descartado.
```

7. El portal crea la tabla y tambien tools internas para usarla desde chat.
8. Prueba en `Centro operativo` con una instruccion natural.

## Registrar APIs legacy

En `Tools API externas` puedes registrar endpoints reales de tu sistema:

- `agregaCliente`
- `emiteFactura`
- `actualizaPedido`
- cualquier otra accion que tu sistema exponga por HTTP

Cada tool se publica en el MCP del proyecto activo.

## Bases y SQL

En `Documentacion de base` puedes registrar:

- una conexion MySQL directa (`host`, `puerto`, `usuario`, `password`, `database`)
- un endpoint SQL por HTTP si tu sistema ya lo expone
- o solo documentacion y reglas para que el modelo entienda tu schema

Con eso el MCP puede responder preguntas como:

```text
cuantas polizas tiene el sistema
cuantas polizas siguen vigentes
muestrame las polizas vigentes
que acciones puedes hacer dentro de este proyecto
```

## MCP por proyecto

El MCP ya no vive en una sola URL global. Cada proyecto tiene su propia URL:

```text
http://localhost:3060/mcp/TU_WORKSPACE_KEY/TU_PROJECT_KEY
```

Cuando uses tunel HTTPS, la forma es:

```text
https://tu-dominio-o-tunel/mcp/TU_WORKSPACE_KEY/TU_PROJECT_KEY
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
