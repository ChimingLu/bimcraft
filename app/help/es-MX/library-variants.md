---
title: Colocar y sustituir un elemento de biblioteca que tiene variantes
summary: Algunos elementos de la biblioteca vienen en varios tamaños u opciones. Elija la variante antes de colocarlo, vea cuál es un elemento colocado, sustitúyalo por otra variante con un clic y consérvela cuando el elemento se actualice.
keywords: variante, variantes, tamaños, opciones, configuración, biblioteca, librarycraft, colocar, sustituir, configurador, familia, tipo, actualizar, puertos
from: 77b218fb
---

## Qué hará

Coloque un elemento de la biblioteca en el tamaño u opción que necesita y cambie de opinión después sin volver a colocarlo. Un elemento con variantes es un solo elemento en la biblioteca (un nombre, una licencia, una versión) con una tabla de las variantes en que viene: por ejemplo una placa de montaje en Small, Medium y Large, o la misma placa sin orificios.

## Elija la variante y colóquela

1. Abra la pestaña {{ui:Biblioteca}} y haga clic en la tarjeta del elemento.
2. Debajo del nombre, la opción {{ui:Variante}} lista todas las variantes con su tamaño. Primero está elegida la predeterminada del elemento.
3. Elija una. La planta, el tamaño y la fila del cuerpo 3D siguen su elección.
4. Haga clic en {{ui:Colocar en el modelo}} y colóquelo como cualquier elemento: vea [Colocar equipo y mobiliario desde la biblioteca](topic:place-from-library).

El elemento colocado se llama como el elemento y la variante, por ejemplo *Mounting plate — Large*, de modo que la lista de {{ui:Equipos}} y el árbol los distinguen. Cada variante es su propio tipo IFC: colocar dos veces la misma variante comparte un tipo, y una variante distinta tiene el suyo.

## Vea qué variante es un elemento colocado

Elija el elemento. En {{ui:Propiedades}}, el cuadro **Elemento de biblioteca** tiene una línea **Variante**. El IFC la guarda en `CadCraft_LibraryItem`: `Variant` (el id de la variante), `VariantName` y `VariantValues` (los valores de las opciones, como texto), para que otros programas puedan leerla.

## Sustituir por otra variante

1. Elija el elemento colocado y haga clic en {{ui:Sustituir elemento…}} en el cuadro **Elemento de biblioteca**. Se abre la pestaña {{ui:Biblioteca}}.
2. Arriba, **Otras variantes de** *el elemento* lista cada variante con su tamaño. La colocada aparece marcada y no se puede elegir.
3. Haga clic en {{ui:Cambiar a …}} en la variante que quiere.

El elemento conserva su lugar, giro, nivel, número de elemento, cantidad y notas; su tipo, forma y datos cambian a los de la otra variante. {{key:Mod+Z}} devuelve la primera. Aún puede elegir cualquier otro elemento de la lista de abajo, como antes: vea [Sustituir un elemento colocado y actualizar elementos de la biblioteca](topic:swap-and-update-library-items).

## Copiar, pegar y actualizaciones

- Una copia de una variante colocada es la misma variante: en este modelo, y en otro modelo abierto en la misma pestaña del navegador, con Copiar y Pegar.
- Las **actualizaciones** conservan la variante: si la versión más nueva del elemento todavía la tiene, el elemento colocado pasa a ser esa variante de la versión nueva. Si la versión nueva ya no la tiene, toma la variante predeterminada del elemento.

## Conviene saber

- Solo algunos elementos de la biblioteca tienen variantes. Las tarjetas no lo dicen; verá la opción {{ui:Variante}} al abrir uno.
- Un elemento puede listar **puertos** (puntos de conexión de tuberías y ductos) por variante. La pestaña Biblioteca muestra cuántos tiene una variante. Todavía **no** se escriben en el IFC cuando coloca el elemento desde la pestaña Biblioteca.
- Una variante sin cuerpo 3D se coloca con una caja provisional, como cualquier símbolo 2D.
- Los tamaños de la opción están en milímetros, como los escribe la biblioteca.
