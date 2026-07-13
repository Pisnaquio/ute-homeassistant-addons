# UTE Home Assistant Add-ons

Repositorio dedicado de Home Assistant para instalar el addon `UTE`.

Este repo contiene:

- `repository.yaml` para que Home Assistant lo reconozca como custom addon repository
- `ute/` con el canal estable listo para instalar

El addon levanta una UI local dentro de Home Assistant y descarga datos del
portal de UTE usando Playwright dentro del contenedor del propio addon.

## Que necesita el usuario

- Home Assistant con Supervisor / soporte para addons
- sus propias credenciales de UTE

No necesita instalar Node, Playwright ni Chromium manualmente.

## Estructura

- `ute/`: add-on estable, aparece como `UTE`
- `repository.yaml`: metadata del repo de addons

## Instalacion recomendada

### Opcion 1: instalar por URL del repositorio

Esta es la via mas simple si el repositorio esta publicado y es accesible desde
la instancia destino.

1. Publicar este contenido en un repositorio Git dedicado.
2. En Home Assistant, abrir la tienda de addons/apps.
3. Agregar la URL del repositorio como custom repository.
4. Instalar `UTE`.
5. Configurar:
  - `ute_user` (número de cuenta o usuario de UTE; no es un email)
   - `ute_password`
6. Iniciar el addon y abrir `UTE` desde la sidebar.

## Estado recomendado del repo

Mientras siga pendiente la validacion con cuentas ajenas y una instancia limpia
de Home Assistant, conviene mantener este repositorio como privado. Cuando esa
validacion cierre bien, se puede volver publico sin cambiar la estructura.

### Opcion 2: copia manual / zip

Usar esto si queres compartirlo de forma privada sin exponer un repositorio
publico.

1. Descargar o descomprimir este repo.
2. Copiar `ute/` a `addons/local/ute` en la instancia destino.
3. Refrescar la tienda de addons/apps.
4. Instalar `UTE`.

## Validacion rapida

Despues de instalar:

- la UI de `UTE` deberia abrir dentro de Home Assistant
- al primer arranque no se incluyen datos historicos precargados en el paquete compartible
- `Refrescar periodo actual` deberia responder sin error
- `Descargar datos` deberia completar el historial una vez configuradas las credenciales
- tras reiniciar el addon, los datos deberian seguir presentes

## Credenciales y privacidad

- el usuario final solo necesita sus credenciales de UTE
- no necesita proveedor de AI ni API keys
- las credenciales quedan guardadas en la configuracion del addon de Home
  Assistant y el runtime las lee desde ahi
- el campo de password queda oculto en la UI, pero esto no reemplaza un vault
  externo dedicado
- este export no incluye datos reales del autor ni historial precargado

## Notas de distribucion

- HACS no aplica a este addon porque HACS no gestiona addons/apps de Supervisor.
- Si queres instalacion por URL, el repo debe ser accesible por la instancia de Home Assistant.
- Si el repo es privado, la opcion mas robusta sigue siendo compartir zip o copia manual.
