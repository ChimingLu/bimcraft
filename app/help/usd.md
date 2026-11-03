---
title: Export the model as USD
summary: Write the open IFC models as USD for rendering, scene assembly and other 3D programs, with every element's IFC class, GlobalId and properties.
section: tasks
order: 140
keywords: usd, usda, usdc, usdz, openusd, export, ifc, globalid, properties, storeys, disciplines, scene assembly, archviz, rendering
---

{{ui:USD}} on the toolbar writes what is open (every model, federated ones where you placed them) as one USD file.

## Export

1. Choose {{ui:USD}} on the toolbar.
2. Pick {{ui:Text (.usda)}}, {{ui:Binary (.usdc)}} or {{ui:Package (.usdz)}}.
3. The file downloads. The status bar says how many elements went in.

## What is in the file

| In the IFC model | In the USD file |
|---|---|
| Site, building, storeys | Nested groups, storeys in order of elevation |
| Each element | One prim under its storey and discipline (Architecture, Structure, MEP, Furnishing, Site, Spaces, Other), with its geometry as a mesh |
| Class, GlobalId, name, type, tag | Attributes named `ifc:class`, `ifc:globalId`, `ifc:name` and so on |
| Property and quantity sets | One attribute per property; lengths, areas and volumes in metres, square metres and cubic metres |
| Colours | Materials (with transparency) |
| Spaces | Kept, marked as guides so renderers skip them |

The geometry sits at the IFC file's own coordinates. The layout follows CadCraft's written USD conventions for buildings.
