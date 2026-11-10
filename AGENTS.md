# Reglas para agentes en ute-homeassistant-addons

Repositorio **público** de add-ons de Home Assistant. Es el **canal estable**
del add-on `UTE`: lo que está en `main` es lo que instalan y actualizan los
usuarios. `CLAUDE.md` solo importa este archivo (`@AGENTS.md`); las reglas se
escriben acá.

## Qué hay acá

| Ruta | Qué es |
|---|---|
| `repository.yaml` | Metadata para que Home Assistant reconozca el repo. |
| `ute/config.yaml` | Manifiesto del add-on: versión, Ingress, opciones y su esquema. |
| `ute/Dockerfile`, `ute/run.sh` | Imagen y arranque. La imagen se construye en el equipo de cada usuario. |
| `ute/app/` | App Node.js: `web.js` (UI y API), `ute_monitor.js` (CLI) y `lib/`. |
| `ute/CHANGELOG.md` | Una entrada por versión publicada. |
| `ute/DOCS.md`, `ute/README.md`, `ute/SUPPORT.md` | Documentación que ve el usuario y alcance de soporte. |
| `.github/workflows/ci.yml` | Validación en cada PR y en cada push a `main`. |

El proyecto está en mantenimiento (`ute/SUPPORT.md`): solo se aceptan cambios
de compatibilidad con UTE, tarifa, seguridad y bugs reproducibles. No se
agregan funcionalidades.

## Reglas

1. **`main` publica.** No hay paso de release aparte: Home Assistant lee
   `ute/config.yaml` de `main` y ofrece la versión nueva a todos los usuarios.
   Todo cambio entra por rama y PR, con el CI en verde. Nunca se pushea directo
   a `main`, y mergear un PR requiere la aprobación explícita del dueño del
   repo.
2. **Versión y changelog van juntos.** Todo cambio que modifique lo que corre
   en el add-on (`ute/app/`, `ute/Dockerfile`, `ute/run.sh`, `ute/config.yaml`)
   sube `version` en `ute/config.yaml` y agrega arriba de `ute/CHANGELOG.md`
   una entrada `## X.Y.Z — título` que le cuente al usuario qué cambia. El CI
   falla si la versión no tiene entrada. Una versión ya publicada no se
   reescribe ni se reutiliza: se corrige con una versión nueva.
3. **Credenciales solo por las opciones del add-on.** Usuario, documento y
   contraseña de UTE llegan por las opciones declaradas en `ute/config.yaml`
   (el Supervisor las entrega en `/data/options.json`, que lee
   `app/lib/runtime_env.js`). No se agregan otras vías de entrada, no se
   escriben credenciales ni tokens en archivos fuera de `/data`, y los
   valores por defecto de las opciones quedan vacíos.
4. **Los logs pasan por `app/lib/safe_log.js`.** Todo log nuevo usa `logEvent`
   o `redact`. Nunca se registran credenciales, tokens, cookies, encabezados
   de autorización, cuerpos de pedidos o respuestas, HTML del portal, ni
   identificadores de cuenta, suministro, medidor o dirección. Si aparece un
   campo sensible nuevo, se agrega a las listas de `safe_log.js` en el mismo
   cambio.
5. **La UI y la API se sirven solo por Ingress.** `ute/config.yaml` no declara
   `ports:` ni `host_network`, y así se queda: el add-on no se expone a la red
   local ni a Internet. Los controles de origen de los pedidos se mantienen o
   se endurecen, nunca se aflojan. Las rutas de lectura que consume Home
   Assistant sin Ingress (`/health` y el resumen para sensores) no devuelven
   credenciales ni datos identificatorios.
6. **Nada personal en el repo.** Es público: no se commitean datos reales de
   consumo, facturas, capturas del portal, credenciales, tokens, direcciones
   IP, rutas locales, nombres de equipos ni datos de ninguna cuenta. Los tests
   usan datos inventados. El paquete no incluye historial precargado.
7. **Dependencias.** `ute/app/package-lock.json` siempre se commitea junto con
   `package.json`, y la imagen instala con `npm ci --omit=dev`. Los cambios de
   dependencias van en su propio PR. La versión de Node.js se fija en
   `ute/Dockerfile`, y el CI prueba con esa misma versión.
8. **No se saltea, desactiva ni comenta un test o un paso del CI** para
   ponerlo en verde. Si la auditoría de dependencias falla, se actualiza la
   dependencia en una versión nueva del add-on.

## Validación antes de publicar

Desde `ute/app`, con la versión de Node.js que fija `ute/Dockerfile`:

```sh
npm ci
node --test
npm audit --omit=dev --audit-level=high
```

El CI corre eso mismo, más un `node --check` de cada `.js`, un `bash -n` de
`ute/run.sh` y el control de que la versión de `ute/config.yaml` tiene su
entrada en `ute/CHANGELOG.md`. Los tests viven en `ute/app/test/` como
`*.test.js` (`node:test`, sin dependencias extra); un cambio de comportamiento
llega con su test.

El CI no construye la imagen ni la prueba dentro de Home Assistant. Antes de
mergear un cambio que toque `ute/Dockerfile`, `ute/run.sh` o `ute/config.yaml`,
hay que instalar o actualizar el add-on desde la rama en una instancia de
prueba y repasar la «Validación rápida» de `ute/DOCS.md`. El PR dice qué se
validó y qué no.

## Estilo

- Documentación, changelog y textos de la interfaz en español rioplatense.
- Commits en inglés, convencionales (`fix(ute):`, `docs:`, `ci:`, `chore:`).
  PR en español: qué cambia, verificación y qué queda sin validar.
- Cambios mínimos: no se reescriben archivos ni dependencias que la tarea no
  pida.
