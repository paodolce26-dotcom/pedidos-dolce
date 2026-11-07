// Dolce - servidor de pedidos (Express + Postgres/Neon)
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 6) {
  console.error("Falta ADMIN_PASSWORD (mínimo 6 caracteres).");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL (la cadena de conexión de Neon).");
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("dolce:" + ADMIN_PASSWORD).digest("hex");

// Neon exige SSL; la cadena trae ?sslmode=require. Pocas conexiones y cortas: Neon duerme la base si no se usa.
const pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
pool.on("error", (e) => console.error("pg idle error", e.message));
const q = (text, params) => pool.query(text, params);
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next); // errores async -> manejador general

async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    sizes JSONB NOT NULL,
    groups JSONB NOT NULL DEFAULT '[]',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort INTEGER NOT NULL DEFAULT 0
  )`);
  await q(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    whatsapp TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    items JSONB NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendiente',
    paid BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_date TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`);
  // Las fotos subidas viven en la base de datos (el disco de Render se borra al reiniciar)
  await q(`CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data BYTEA NOT NULL
  )`);
  const { rows } = await q("SELECT COUNT(*)::int AS c FROM products");
  if (rows[0].c === 0) {
    const SALSAS = ["Chocolate", "Chocolate derretido", "Fresa", "Arequipe", "Nutella"];
    const TOPPINGS = ["Brownie", "Barquillo", "Oreo", "Minichips", "Chispas de colores"];
    const two = [{ label: "9 oz", price: 12000 }, { label: "12 oz", price: 15000 }];
    const seed = [
      ["Fresas con crema", "Fresas y crema en capas, con tu salsa y tu topping.", "/img/fresas.jpg", two,
        [{ name: "Salsa", choices: SALSAS }, { name: "Topping", choices: TOPPINGS }]],
      ["Torta de chocolate", "Torta, crema de chocolate y brownie.", "/img/chocolate.jpg", two, []],
      ["Torta tres leches", "Torta, crema tres leches, arequipe y crema de frutos rojos.", "/img/tresleches.jpg", two, []],
      ["Napoleón", "Salsa de frutos rojos, Oreo, arequipe y chocolate.", "/img/napoleon.jpg", [{ label: "8 oz", price: 7000 }], []],
    ];
    for (let i = 0; i < seed.length; i++) {
      const s = seed[i];
      await q("INSERT INTO products (name,description,image,sizes,groups,sort) VALUES ($1,$2,$3,$4,$5,$6)",
        [s[0], s[1], s[2], JSON.stringify(s[3]), JSON.stringify(s[4]), i]);
    }
  }
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "50kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

/* ---------- utilidades ---------- */
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const rowToProduct = (r) => ({
  id: r.id, name: r.name, description: r.description, image: r.image,
  sizes: r.sizes, groups: r.groups, active: r.active, sort: r.sort,
});
const rowToOrder = (r) => ({
  id: r.id, code: r.code, name: r.name, location: r.location, whatsapp: r.whatsapp, notes: r.notes,
  items: r.items, total: r.total, status: r.status, paid: r.paid,
  deliveryDate: r.delivery_date, createdAt: Number(r.created_at),
});
const hits = new Map(); // límite simple por IP
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.path + "|" + req.ip, now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "Demasiados intentos. Espera un momento." });
    arr.push(now); hits.set(k, arr); next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

/* ---------- sesión de administradora (cookie firmada) ---------- */
const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeToken() { const exp = String(Date.now() + 30 * 24 * 3600 * 1000); return exp + "." + sign(exp); }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const m = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
function requireAdmin(req, res, next) {
  if (validToken(getCookie(req, "dolce_admin"))) return next();
  res.status(401).json({ error: "No autorizada" });
}

app.post("/api/admin/login", limit(8, 15 * 60 * 1000), (req, res) => {
  const given = Buffer.from(String(req.body?.password ?? ""));
  const real = Buffer.from(ADMIN_PASSWORD);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `dolce_admin=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${secure}`);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "dolce_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true }));

/* ---------- público: menú y pedidos ---------- */
app.get("/api/products", h(async (req, res) => {
  const { rows } = await q("SELECT * FROM products WHERE active ORDER BY sort, id");
  res.json(rows.map(rowToProduct));
}));

function randomCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "D-";
  for (let k = 0; k < 4; k++) c += abc[crypto.randomInt(abc.length)];
  return c;
}

app.post("/api/orders", limit(10, 60 * 60 * 1000), h(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80), location = clean(b.location, 200);
  const whatsapp = clean(b.whatsapp, 25), notes = clean(b.notes, 400);
  if (!name || !location) return res.status(400).json({ error: "Escribe tu nombre y dónde te lo entregamos." });
  if (whatsapp && !/^[\d\s+()-]{7,25}$/.test(whatsapp)) return res.status(400).json({ error: "El WhatsApp solo debe tener números." });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return res.status(400).json({ error: "Tu pedido está vacío." });

  const items = []; let total = 0;
  for (const it of b.items) {
    const { rows } = await q("SELECT * FROM products WHERE id=$1 AND active", [Number(it.productId) || 0]);
    if (!rows[0]) return res.status(400).json({ error: "Uno de los postres ya no está disponible. Recarga la página." });
    const p = rowToProduct(rows[0]);
    const size = p.sizes[Number(it.sizeIndex)];
    const qty = Number(it.qty);
    if (!size || !Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: "Revisa el tamaño y la cantidad." });
    const opts = [];
    for (const g of p.groups) {
      const v = it.opts?.[g.name];
      if (!g.choices.includes(v)) return res.status(400).json({ error: `Elige ${g.name.toLowerCase()} para ${p.name}.` });
      opts.push({ k: g.name, v });
    }
    // el precio SIEMPRE sale del servidor, nunca del navegador
    items.push({ name: p.name, size: size.label, price: size.price, qty, opts });
    total += size.price * qty;
  }
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    try {
      await q("INSERT INTO orders (code,name,location,whatsapp,notes,items,total,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [code, name, location, whatsapp, notes, JSON.stringify(items), total, Date.now()]);
      return res.status(201).json({ code, name, location, notes, items, total });
    } catch (e) { if (e.code !== "23505") throw e; } // código repetido: genera otro
  }
  throw new Error("no se pudo generar código");
}));

/* ---------- panel: pedidos ---------- */
app.get("/api/admin/orders", requireAdmin, h(async (req, res) => {
  const { rows } = await q("SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
  res.json(rows.map(rowToOrder));
}));
app.patch("/api/admin/orders/:id", requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const { rows } = await q("SELECT * FROM orders WHERE id=$1", [id]);
  const o = rows[0];
  if (!o) return res.status(404).json({ error: "No existe" });
  const b = req.body || {};
  let status = o.status, paid = o.paid, date = o.delivery_date;
  if (b.deliveryDate !== undefined) {
    date = clean(b.deliveryDate, 10);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Fecha inválida" });
    if (date && status === "pendiente") status = "confirmado";
  }
  if (b.status !== undefined) {
    if (!["pendiente", "confirmado", "entregado"].includes(b.status)) return res.status(400).json({ error: "Estado inválido" });
    status = b.status;
  }
  if (b.paid !== undefined) paid = !!b.paid;
  const r = await q("UPDATE orders SET status=$1, paid=$2, delivery_date=$3 WHERE id=$4 RETURNING *", [status, paid, date, id]);
  res.json(rowToOrder(r.rows[0]));
}));
app.delete("/api/admin/orders/:id", requireAdmin, h(async (req, res) => {
  await q("DELETE FROM orders WHERE id=$1", [Number(req.params.id) || 0]);
  res.json({ ok: true });
}));

/* ---------- panel: productos ---------- */
function readProduct(b) {
  const name = clean(b.name, 80);
  if (!name) throw new Error("El producto necesita un nombre.");
  const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map((s) => ({ label: clean(s.label, 30), price: Math.round(Number(s.price)) }))
    .filter((s) => s.label && Number.isFinite(s.price) && s.price > 0);
  if (!sizes.length) throw new Error("Agrega al menos un tamaño con precio.");
  const groups = (Array.isArray(b.groups) ? b.groups : []).map((g) => ({
    name: clean(g.name, 40), choices: (Array.isArray(g.choices) ? g.choices : []).map((c) => clean(c, 50)).filter(Boolean),
  })).filter((g) => g.name && g.choices.length);
  return { name, description: clean(b.description, 300), image: clean(b.image, 200), sizes, groups, active: !!b.active };
}
app.get("/api/admin/products", requireAdmin, h(async (req, res) => {
  const { rows } = await q("SELECT * FROM products ORDER BY sort, id");
  res.json(rows.map(rowToProduct));
}));
app.post("/api/admin/products", requireAdmin, h(async (req, res) => {
  let p;
  try { p = readProduct(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const s = await q("SELECT COALESCE(MAX(sort),0)+1 AS n FROM products");
  const r = await q("INSERT INTO products (name,description,image,sizes,groups,active,sort) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [p.name, p.description, p.image, JSON.stringify(p.sizes), JSON.stringify(p.groups), p.active, s.rows[0].n]);
  res.status(201).json({ id: r.rows[0].id });
}));
app.put("/api/admin/products/:id", requireAdmin, h(async (req, res) => {
  let p;
  try { p = readProduct(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const r = await q("UPDATE products SET name=$1,description=$2,image=$3,sizes=$4,groups=$5,active=$6 WHERE id=$7",
    [p.name, p.description, p.image, JSON.stringify(p.sizes), JSON.stringify(p.groups), p.active, Number(req.params.id) || 0]);
  if (!r.rowCount) return res.status(404).json({ error: "No existe" });
  res.json({ ok: true });
}));
app.delete("/api/admin/products/:id", requireAdmin, h(async (req, res) => {
  await q("DELETE FROM products WHERE id=$1", [Number(req.params.id) || 0]); // los pedidos viejos guardan su propia copia
  res.json({ ok: true });
}));

// Subir foto de un producto (JPG, PNG o WebP, máx. 4 MB). Se guarda en la base de datos.
const EXT = { "image/jpeg": 1, "image/png": 1, "image/webp": 1 };
app.post("/api/admin/upload", requireAdmin, express.raw({ type: Object.keys(EXT), limit: "4mb" }), h(async (req, res) => {
  const mime = req.headers["content-type"]?.split(";")[0];
  if (!EXT[mime] || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Sube una imagen JPG, PNG o WebP de hasta 4 MB." });
  const id = crypto.randomBytes(10).toString("hex");
  await q("INSERT INTO uploads (id,mime,data) VALUES ($1,$2,$3)", [id, mime, req.body]);
  res.json({ url: "/uploads/" + id });
}));
app.get("/uploads/:id", h(async (req, res) => {
  const { rows } = await q("SELECT mime,data FROM uploads WHERE id=$1", [String(req.params.id).slice(0, 40)]);
  if (!rows[0]) return res.status(404).end();
  res.setHeader("Content-Type", rows[0].mime);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(rows[0].data);
}));

/* ---------- archivos estáticos ---------- */
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/healthz", h(async (req, res) => { await q("SELECT 1"); res.send("ok"); }));
app.use("/api", (req, res) => res.status(404).json({ error: "No existe" }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status === 413 ? "Archivo muy grande" : "Error del servidor" });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`Dolce listo en el puerto ${PORT} (panel: /admin)`)))
  .catch((e) => { console.error("No pude conectar con la base de datos:", e.message); process.exit(1); });
