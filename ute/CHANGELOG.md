# Changelog

## 0.3.9 — Períodos diarios históricos recuperables

- Agrega “Completar períodos anteriores” al menú Sincronizar.
- Muestra cuántos períodos diarios ya están guardados y cuántos quedan pendientes.
- Reintenta únicamente los períodos faltantes; los ya persistidos no se vuelven a consultar.

## 0.3.8 — Compatibilidad con token OAuth de UTE

- Acepta respuestas OAuth válidas cuando UTE omite el `scope` sin cambiarlo o no rota el `refresh_token`.
- Sigue bloqueando scopes distintos, tokens vacíos y respuestas sin vencimiento válido.
- Conserva el refresh token anterior cuando la renovación no devuelve uno nuevo.

## 0.3.7 — API-first con complemento de datos legacy

- Agrega cliente clean-room de la API móvil UTE con OAuth en memoria, allowlist HTTPS y diagnóstico saneado.
- `ute_document` es explícito para CI/RUT/BPS; `ute_user` queda disponible para complementar capacidades que la API no expone.
- Discovery y selección usan identidad técnica API; un suministro no autorizado no se puede seleccionar.
- La migración 1→1 conserva selección y cache sólo cuando se demuestra la misma cuenta; los casos ambiguos no reemplazan datos.
- La API resuelve discovery y consumo actual. Histórico mensual y curva diaria se complementan desde SelfService cuando se configura `ute_user`, sin caer a scraping por errores de API.

## 0.1.22-rc.1 — discovery multicuenta (campo privado)

- Clasifica el estado post-login con evidencia estructural, redirects y formularios seguros.
- Conserva campos hidden requeridos para transiciones GET/POST y admite redirects JS deterministas.
- Mantiene la canonicalización de suministros y bloquea contextos ambiguos o incompletos.
- El fallback Playwright requiere un `SupplyContext` técnico completo; no puede elegir ni mezclar suministros.
- No promocionar: requiere validación externa de discovery, selección, sync-one, sync-all y cambio de suministro.

## 0.1.21

- Corrige la ruta de Chart.js para Home Assistant Ingress: el asset ahora se resuelve dentro del prefijo del add-on en vez de pedir `/assets` al host de HA.
- Agrega un gate que impide volver a publicar el `src` absoluto incompatible con Ingress.

## 0.1.20

- Corrige el bootstrap del dashboard: serializa los feriados uruguayos al JavaScript cliente y elimina el `ReferenceError` que dejaba KPIs y gráficos en loading.
- Agrega un smoke browser reproducible del modo DEMO en 1280/768/430/390/360, con datos y gráficos cargados, consola limpia, sin requests a UTE y sin overflow horizontal de página.

## 0.1.19

- Repara de forma conservadora los namespaces creados por el falso multicuenta: sólo adopta una copia si es equivalente o un superset semántico verificable.
- Bloquea datos complementarios, contradictorios, corruptos o suministros anteriores sin cobertura; nunca oculta un multicuenta sano por un discovery parcial.
- Conserva intactos los namespaces descartados, registra evidencia anonimizada en el backup y revalida fingerprints antes del commit.

## 0.1.18

- Corrige el falso multicuenta: varias representaciones HTML del mismo suministro se canonicalizan como una sola identidad.
- Conserva histórico, período actual y exports al reparar un portfolio previo; usa backup, rollback y lock entre procesos.
- Falla cerrado ante opciones opacas, identidades ambiguas/incompletas o selección no verificable, sin caer al primer suministro.
- Sanea diagnósticos estructurales y aísla por completo el modo demo de datos y mutaciones reales.

## 0.1.11

- Portfolio refresh/gestión local y borrado seguro de suministros.
- Auto-refresh con jitter y sincronización all con recuperación parcial.

## 0.1.9

- Namespace activo seleccionado también en API, cache, exportaciones y auto-refresh.
- Job persistido con `supplyKey` y sincronización secuencial de todo el portfolio.

## 0.1.4

- Mueve el control de sincronizacion al bloque del periodo diario y elimina los botones viejos del header.
- Ajusta el auto-refresh interno para refrescar solo el periodo actual varias veces por dia.
- Separa `ute` como runtime default del addon dev.

## 0.1.3

- Respeta `UTE_RUNTIME_NAME` dentro del proceso Node para separar runtimes sin mezclar datos.

## 0.1.2

- Muestra una pantalla de Login cuando el add-on todavía no tiene usuario y contraseña configurados.
- Evita disparar descargas o actualizaciones contra UTE sin login.
- Corrige el primer arranque sin datos históricos.

## 0.1.0

- Primera versión local del app `UTE` para Home Assistant.
- UI completa servida por Ingress.
- Persistencia en `/data/ute`.
- Configuración de credenciales vía opciones del app.
## 0.1.8

- Discovery multi-cuenta con `navigateSelectUserType` y selector obligatorio.
- Portfolio schema v2, `SupplyContext`, storage aislado por suministro y migración single-supply.
- Jobs por suministro / todos y diagnóstico anonimizado descargable.
