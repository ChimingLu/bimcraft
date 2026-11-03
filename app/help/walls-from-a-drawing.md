---
title: Walls from a traced drawing
summary: Turn a DWG or DXF plan into walls, doors and windows on a level, and keep the drawing under the plan as a reference.
section: tasks
order: 32
keywords: dwg, dxf, trace, traced, import plan, convert, cad to bim, 2d to 3d, walls from lines, layers, blocks, doors from blocks, underlay, reference drawing, background, xref, drafting app
---

## What you'll do

Use a plan you (or someone else) drew in the drafting app as the start of the model: its wall lines become walls, its door and window blocks become doors and windows.

## Steps

1. Turn on {{ui:Draw}} and choose the level the drawing shows in the plan's level list.
2. Choose {{ui:Build}} › {{ui:From a drawing…}}, then {{ui:Choose a drawing…}} and pick the DWG or DXF.
3. In the dialog:
   - **Drawing units** come from the drawing; choose others if they are wrong (a plan drawn in feet read as inches is twelve times too small).
   - **Layers with the walls**: tick the layers the wall lines are on. Layers whose names say "wall" are ticked for you.
   - **The lines are**: **both faces of each wall** (the usual way plans are drawn: each pair of parallel lines up to 600 mm apart becomes one wall as thick as the gap), **the walls' center lines**, or **one face** with the wall to its left or right. With center lines or one face, the wall type sets the thickness.
   - **Wall type** and **Wall height**, as for the {{ui:Wall}} tool.
   - **Blocks**: choose a door or window type for each block that is a door or a window, or leave it out. Blocks whose names say "door" or "window" are chosen for you. Each one is put in the wall it sits on, as wide as the block along the wall; a door opens to the side its swing is drawn on.
   - **Where it goes**: at the drawing's own coordinates, or with its lower-left corner on the plan's origin.
   - **Keep the drawing under the plan of this level**: leave it ticked to see the drawing as thin lines under what you make.
4. The line under the choices says how many walls, doors and windows it will make. Click {{ui:Make them}}.

## What you should see

- The walls, doors and windows on the level, joined where they meet, with the rooms they close; all of it is one step, so {{key:Mod+Z}} takes it back.
- The drawing as thin lines under the plan. {{ui:Build}} › {{ui:From a drawing…}} lists the drawings kept on the level, each with {{ui:Remove}}; removing one leaves the walls.
- In the IFC file the kept drawing is an annotation on the level (its lines), so other BIM programs show it too.

:::note
A PDF or a scan works too: see [Walls from a set of plans](topic:walls-from-plans). Arcs are left out (BimCraft draws straight walls), and so are lines inside blocks. Lines with no partner in "both faces" are counted in the dialog and left out: draw those walls with the {{ui:Wall}} tool, or tidy them with {{ui:Modify}} › {{ui:Trim / extend}} (see [Trim, extend and join walls](topic:trim-extend-walls)).
:::

:::tip
Traced over a scan in the drafting app? Open the scan here too and check the walls against it: see [Model from a scan](topic:model-from-a-scan).
:::
