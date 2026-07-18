# UTE

App local de Home Assistant para hostear la UI completa de UTE dentro de Home Assistant mediante Ingress.

Incluye:

- Dashboard web embebido en la sidebar como `UTE`
- API móvil UTE para autenticación, discovery y consumo corriente
- SelfService HTTP para histórico mensual y curvas diarias
- Playwright como fallback legacy acotado
- Persistencia en `/data/ute`
- Configuración de credenciales desde las opciones del app

## Estado

La versión 0.3.10 es el cierre funcional y queda en mantenimiento. Single-supply
es el alcance soportado. Multi-supply se conserva como experimental y no GA.

Ver [`SUPPORT.md`](./SUPPORT.md).
