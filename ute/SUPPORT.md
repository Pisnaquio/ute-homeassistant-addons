# Alcance de soporte de UTE

**Vigente desde:** 0.3.10 — 2026-07-17

## Soportado

- Una cuenta con un único suministro canónico (`single-supply`).
- Autenticación, discovery y consumo corriente mediante la API móvil UTE.
- Histórico mensual y curva diaria mediante SelfService cuando se configura
  `ute_user`.
- Persistencia local, dashboard Ingress y recuperación incremental de períodos.

## Experimental

El código conserva selección, namespaces y guardas para múltiples suministros,
pero no se declara GA. La validación externa no pudo completarse y no hay un
entorno real disponible para seguir probando sin riesgo de mezclar datos.

No se garantiza en multi-supply:

- atribución de importes o facturas que la API entrega a nivel de cuenta;
- sincronización completa de todos los suministros;
- cambio A/B sin regresiones en un portal real;
- soporte de incidencias sin diagnóstico reproducible.

## Estado del proyecto

UTE está en mantenimiento. Sólo se reabre desarrollo por:

- cambio de contrato del portal o la API;
- cambio tarifario;
- vulnerabilidad de seguridad;
- bug reproducible de la versión estable;
- disponibilidad de un nuevo tester multi-supply con un entorno controlado.

La app mobile y la distribución Docker son iniciativas separadas y están
pausadas; no forman parte del soporte de este add-on.
