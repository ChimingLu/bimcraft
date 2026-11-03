---
title: Desarrollar un volumen de edificio de un estudio de sitio
summary: Tome un volumen de edificio estudiado en la vista de sitio de CivilCraft y desarróllelo en niveles, muros y pisos, conservando la ubicación del sitio en el mapa.
keywords: volumen, volumetría, estudio de sitio, desarrollar, CivilCraft, traspaso, niveles, muros, pisos, huella, georreferencia, IFC
from: 557b94d1
---

La vista de sitio de CivilCraft puede dibujar volúmenes de edificios sobre un predio y probarlos contra el terreno, los límites que usted escribe y el sol. **Desarrollar en BimCraft**, allí, abre BimCraft en una pestaña nueva con los volúmenes; **Volúmenes como IFC** los guarda en un archivo que se abre aquí como de costumbre. De cualquier modo, cada volumen llega como un sitio, un edificio con un nivel por piso y un bloque (el propio volumen) con sus datos.

## Desarrollar un volumen

1. Elija un volumen en la vista 3D. Propiedades muestra su uso, pisos y altura de piso, huella, área bruta construida, cómo se asienta en la pendiente y su predio.
2. Haga clic en **Desarrollar este volumen**.

En un solo paso de deshacer, cada nivel de ese edificio recibe muros alrededor de la huella (la huella es la cara exterior de los muros; cada muro sube hasta el nivel de arriba y el de la planta alta mide un piso) y un piso bajo todo el edificio. El bloque se reemplaza, y el edificio conserva los datos del estudio en el conjunto de propiedades `CadCraft_SiteMass`, marcado como desarrollado. No hay techo: un techo depende del diseño.

## La ubicación del sitio

Un archivo de CivilCraft está escrito en la unidad de longitud del propio proyecto y, cuando el proyecto de CivilCraft tenía sistema de coordenadas, lo lleva como la conversión de mapa del proyecto. Desarrollar un volumen no la toca, así que el edificio sigue donde dice el mapa.
