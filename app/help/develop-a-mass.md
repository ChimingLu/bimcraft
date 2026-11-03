---
title: Develop a building mass from a site study
summary: Take a building mass studied in CivilCraft's site view and develop it into levels, walls and floors, with the site's place on the map kept.
section: tasks
order: 71
keywords: mass, building mass, massing, site study, develop, CivilCraft, hand over, levels, walls, floors, footprint, georeference, IFC
---

CivilCraft's site view can draw building masses on a parcel and test them against the ground, the limits you type and the sun. **Develop in BimCraft** there opens BimCraft in a new tab with the masses; **Masses as IFC** saves them as a file you open here the usual way. Either way each mass arrives as a site, a building with one level per floor, and one block (the mass itself) carrying its numbers.

## Develop a mass

1. Pick a mass in the 3D view. Properties shows its use, floors and floor height, footprint, gross floor area, how it sits on the slope, and its parcel.
2. Click **Develop this mass**.

In one undo step, every level of that building gets walls round the footprint (the footprint is the walls' outer face; each wall goes up to the level above, and the top one is one floor high) and a floor under the whole building. The block is replaced, and the building keeps the study's numbers in the property set `CadCraft_SiteMass`, marked as developed. There is no roof: a roof depends on the design.

## The site's place

A file from CivilCraft is written in the project's own length unit and, when CivilCraft's project had a coordinate system, carries it as the project's map conversion. Developing a mass leaves that alone, so the building stays where the map says it is.
