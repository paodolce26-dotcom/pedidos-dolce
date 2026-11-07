# Dolce – Pedidos en línea

Página para que cualquier persona pida postres sin crear cuenta. Tú confirmas la fecha de entrega desde un panel con contraseña.
Node.js + Express + Postgres (Neon). Pensado para publicarse en Render.

## Cómo funciona
- **Clientes** (`/`): eligen postre → tamaño → salsa/topping (solo fresas con crema) → dejan nombre, lugar de entrega y WhatsApp (opcional). Ven los datos de pago y un botón para avisarte por WhatsApp.
- **Tú** (`/admin`): ves los pedidos, eliges la fecha de entrega, marcas pagado/entregado y avisas al cliente por WhatsApp. Con el panel abierto suena un aviso cuando llega un pedido nuevo.
- **Productos**: en el panel, pestaña *Productos*, agregas, editas, ocultas o eliminas postres, con foto, tamaños y opciones. No hay que tocar código.
- Los precios los calcula el servidor; el cliente no puede cambiarlos.
- Pedidos, productos y fotos subidas se guardan en Neon, así que no se pierden cuando Render reinicia el servicio. Las tablas se crean solas la primera vez.

## Publicar con Neon + Render

### 1. Neon (base de datos)
1. Crea un proyecto en neon.tech.
2. Botón **Connect** → copia la cadena de conexión (`postgresql://...?sslmode=require`). Esa es tu `DATABASE_URL`.

### 2. GitHub
Sube esta carpeta a un repositorio (`node_modules` y `.env` ya están en `.gitignore`).

### 3. Render
1. **New → Web Service** → elige el repositorio.
2. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
3. En **Environment** agrega:
   - `DATABASE_URL` = la cadena de Neon.
   - `ADMIN_PASSWORD` = tu contraseña del panel (larga y que no uses en otro sitio).
4. Deploy. Cuando termine, abre `https://tu-servicio.onrender.com/admin` e inicia sesión.
5. Comprueba que `https://tu-servicio.onrender.com/healthz` responda `ok` (confirma que Render llega a Neon).

### Cosas del plan gratuito
- **Render gratis** apaga el servicio tras unos 15 minutos sin visitas; la primera visita después tarda cerca de un minuto en abrir. Para pedidos de clientes conviene un plan de pago, o que tú abras la página antes de compartirla.
- **Neon gratis** también "duerme" la base cuando no se usa y despierta en segundos; el servidor ya está configurado para tolerarlo.

## Probar en tu computador
```bash
npm install
# Mac/Linux
DATABASE_URL="tu-cadena-de-neon" ADMIN_PASSWORD="tu-clave" npm start
# Windows PowerShell
$env:DATABASE_URL="tu-cadena-de-neon"; $env:ADMIN_PASSWORD="tu-clave"; npm start
```
Abre http://localhost:3000 (clientes) y http://localhost:3000/admin (panel). Usa una base de Neon aparte (branch) si no quieres mezclar pedidos de prueba con los reales.

## Datos que puedes cambiar en el código
- Número de WhatsApp y de pago: arriba en `public/app.js` (`WHATSAPP`, `WHATSAPP_SHOW`, `PAGO`).
- Menú inicial: `server.js` (solo se carga la primera vez; después se edita desde el panel).
- Colores y letras: `public/style.css`.

## Estructura
```
server.js                    API (Express + Postgres), login, validación de pedidos
public/index.html, app.js    Página de clientes
public/admin.html, admin.js  Panel de la dueña
public/style.css             Estilos
```
