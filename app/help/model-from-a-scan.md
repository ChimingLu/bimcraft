---
title: Model from a scan
summary: A short walkthrough from a laser scan to walls: open the point cloud beside a new building, line it up with a level, and trace its walls on the plan.
section: tasks
order: 29
keywords: scan, laser scan, point cloud, as-built, existing building, survey, trace, scan to BIM, model from scan, slice, align, square, LAS, LAZ, E57, PLY
---

## What you'll do

Draw an existing building from its laser scan: walls where the scan shows them, on the right level, square to each other.

## Steps

1. **A building to draw in.** {{ui:File}} › {{ui:New building}}, with as many levels as the building has (you can add levels later, see [The site, the building on it, and its levels](topic:site-building-and-levels)). {{ui:Draw}} turns on.
2. **The scan.** {{ui:Show}} › {{ui:Point cloud}} and choose the file (LAS, LAZ, E57, PLY, PCD, PTX or XYZ: see [Show a point cloud beside the model](topic:point-clouds)). The cloud shows in the 3D view, and the plan shows its **slice**: the scanned points 1200 mm (4 feet) above the level, as dots. That is the height where walls, doors and windows read best.
3. **Line it up with the level.** Open the model bar's {{ui:Scan}} menu and click {{ui:Align its floor to this level}}: the cloud moves up or down until the floor it scanned sits on the level shown. Check the slice now cuts through the walls.
4. **Square to the building.** {{ui:Scan}} › {{ui:Turn it square to the building}} turns the cloud so the walls in its slice run along the plan's axes, so walls you draw with {{key:Shift}} held line up with the scan. It turns about the middle of the walls it found, so trees or a neighbour's wall caught in the slice don't swing the scan away. Align the floor first: the slice then cuts through the walls.
5. **Trace the walls.** Choose {{ui:Wall}} and click along the dots: the tool snaps to scanned points (the snap mark is a small diamond) as well as to the walls you have drawn. A wall is drawn on its center line, so click along the middle of the two rows of dots a wall leaves; type its thickness by choosing the wall type first. Then add the doors and windows where the slice shows the gaps.
6. **The next level.** Choose the level above in the plan's level list: the slice follows the level's cut height. Align the floor to that level again only if the scan's floors are not where your levels are.

## What you should see

- The slice changes as you change level, and a thicker slice ({{ui:Scan}} › {{ui:Slice thickness}}) shows more points where a scan is thin.
- {{ui:Scan}} › {{ui:Undo the alignment}} puts the cloud back where it was placed when it opened. Aligning moves the cloud in the view only: it is not saved in the IFC file, and walls you have drawn stay put. The alignment goes with the cloud when you change {{ui:Place}} or {{ui:Units}}, or open another model.
- {{ui:Scan}} › {{ui:Show the slice on the plan}} hides or shows the dots.

:::tip
Big scans: the plan draws up to 60,000 points of the slice and the 3D view a few million of the whole cloud, both picked evenly through the scan, so a large file stays quick. To trace in the drafting app instead, use the cloud bar's {{ui:Trace in CadCraft}}.
:::
