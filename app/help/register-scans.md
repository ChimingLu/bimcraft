---
title: Register several scans into one
summary: Place scans taken from different positions in one frame by picked point pairs or typed targets, refine them with ICP, save the registration as a project, and export the registered cloud as LAS or E57.
section: tasks
order: 28
keywords: register, registration, scans, point cloud, icp, iterative closest point, targets, point pairs, rigid transform, align, merge, e57, las, scan to bim
---

## What you'll do

Several scans of one place (each from its own scanner position) start in their own coordinates. Register them: give each scan one placement so they all sit in one frame, then save that as a project and write the registered cloud as one LAS or E57 file.

## Place the scans

1. Open the dialog ({{ui:Register scans…}} on the start panel, or {{ui:Show}} › {{ui:Register scans…}} once a model is open). {{ui:Add scans…}} takes LAS, LAZ, E57, PLY, PCD, PTX, PTS or XYZ files, or drop them on the dialog. Scans that use different units are refused with a note: convert one first.
2. Choose {{ui:Scan to move}} and {{ui:Place against}}. The picture shows every scan in the frame as it is now, one color each: {{ui:Plan}}, {{ui:Front}} or {{ui:Side}}; drag to pan, use the wheel to zoom.
3. **By point pairs.** Click {{ui:Pick a pair}}, then a point on the scan to move, then the same place on another scan (a corner, a target, the foot of a column). Do this at least three times, with points that are not in one line and are spread apart. Click {{ui:Place by pairs}}: the scan is placed by a least-squares fit, and **Left over** shows how far each pair still misses. A pair with a large number is a bad pick: remove it with the cross and place again.
4. **By targets.** If a point's true coordinates are known (surveyed targets), click {{ui:Pick, then type target}}, click the point on its scan, and type the target's X, Y and Z in the row. Pairs and typed targets mix freely.

## Refine with ICP

Pairs give a rough placement. {{ui:Refine}} moves the scan until its surfaces sit on the other scan's: first **point to point**, then **point to plane**. The table lists every step with its error and how many points matched; the line above it draws the error falling. {{ui:Stop}} ends the run after the step in progress and keeps what it reached. {{ui:Undo}} takes the whole run (or the last placement) back; {{ui:Reset}} puts the scan back at its file coordinates.

To keep it quick on a laptop, ICP works on a decimated share of the points ({{ui:Points used}}, 5,000 to 60,000) and ignores matches farther than {{ui:Largest match distance}} (by default 5% of the scan's size, shrinking as it settles). It needs a rough placement first: scans that barely overlap report that they cannot be matched. Surfaces that are only flat or only straight cannot fix a position along themselves; add pairs in that case.

## Save and export

- {{ui:Save project}} writes a small `.ccscans.json` file: each scan's name, size and a fingerprint of its first 64 KB, with its transform. It holds no points. {{ui:Open project…}} finds the scan files by those references (the files must be added first) and puts every transform back.
- {{ui:Export LAS}} and {{ui:Export E57}} write one file with every scan in its registered place. Points are never rewritten in the originals; the transform is applied on the way out. With {{ui:Read every point from the files}} on, each file is read again for every point (up to 20 million per scan); off, only the points shown in the viewer are written.
- {{ui:Show registered cloud}} (BimCraft) writes the LAS and opens it in the 3D view beside the model, like any cloud.

:::note
Nothing is uploaded. Registration works in the files' own units and keeps millimeters: a LAS is written with a scale that fits (down to 0.1 mm), an E57 with doubles. A coordinate system is carried into the LAS only when every scan names the same EPSG code. The E57 writer is our own; it is checked by reading its files back with this reader and with libE57Format.
:::
