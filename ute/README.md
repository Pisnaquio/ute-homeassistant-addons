# UTE

App local de Home Assistant para hostear la UI completa de UTE dentro de Home Assistant mediante Ingress.

Incluye:

- Dashboard web embebido en la sidebar como `UTE`
- Descubrimiento de una o varias cuentas/suministros del mismo usuario UTE
- Selector obligatorio cuando el portal devuelve más de un suministro
- Descarga HTTP-first; el fallback Playwright queda deshabilitado en multicuenta para evitar cruces
- Persistencia aislada por suministro en `/data/ute`
- Configuración de credenciales desde las opciones del app
- Diagnóstico descargable anonimizado para soporte

## Primer uso

1. Instalá o actualizá la app `UTE` y abrí **Settings > Apps > UTE > Configuration**.
2. Ingresá el usuario o número de cuenta UTE y la contraseña.
3. Abrí la interfaz web. Si el usuario tiene más de un suministro, elegí uno en el selector antes de sincronizar.
4. En **Sincronizar**, ejecutá **Descargar historial completo**.

Si el portal no permite completar el discovery o la sincronización, descargá el diagnóstico desde la interfaz y compartilo con soporte. El archivo no incluye contraseña, número de cuenta, alias, dirección ni identificadores técnicos del portal.

En usuarios con varias cuentas, la versión 0.3.0 no asocia facturas reales mientras UTE no exponga un filtro inequívoco por suministro. El consumo y la estimación local siguen disponibles; se omite el importe histórico antes que mostrar el de otra cuenta.
