# UTE

## Qué hace

Hostea la UI completa de UTE dentro de Home Assistant usando Ingress. No usa `panel_iframe` ni una tarjeta Lovelace como arquitectura principal.

## Configuración

- `ute_document`: CI/RUT/BPS para API móvil UTE
- `ute_user`: usuario de SelfService para histórico/curva diaria cuando corresponda
- `ute_password`: contraseña de UTE
- `debug`: habilita logs más verbosos
- `timezone`: zona horaria para el runtime

## Persistencia

Los datos viven en `/data/ute` dentro del almacenamiento persistente del app:

- `/data/ute/data`
- `/data/ute/reportes`
- `/data/ute/logs`
- `/data/ute/temp`

El paquete público no incluye datos iniciales ni información de otras cuentas.

## Uso

1. Instalar el app local desde `Settings > Apps`.
2. Abrir la configuración del app y cargar las credenciales propias.
3. Iniciar el app.
4. Abrir `UTE` desde la sidebar.

## Validación rápida

- La UI abre dentro de Home Assistant.
- `Refrescar período actual` responde sin errores.
- `Descarga completa` dispara el job en segundo plano.
- Tras reiniciar el app, los datos siguen presentes.

## Notas

- Este app usa Chromium del contenedor junto con Playwright.
- Si la descarga en vivo falla, la UI sigue mostrando los datos persistidos ya guardados.
