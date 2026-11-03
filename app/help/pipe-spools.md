---
title: Steel pipe spools and spool sheets
summary: Cut a steel butt-weld pipe run into spools at a longest length and at the field welds you place, number them, and download a spool sheet per spool (3D view, cut lengths, fittings, welds, bill of materials) as PDF and CSV; ducts get a cut list of straight pieces.
section: tasks
order: 40
keywords: spool, spools, spool sheet, isometric, fabrication, prefabrication, field weld, shop weld, butt weld, cut length, cut list, bill of materials, bom, steel pipe, schedule 40, line number, duct cut list, ductwork pieces
---

## What you'll do

Turn a steel pipe run into the pieces a shop welds up and a fitter puts in: spools no longer than a length you choose, split where you place field welds, each with its own sheet.

Only **steel butt-weld pipe** is cut into spools (pipe sizes ASME B36.10M, elbows at the ASME B16.9 long radius). Copper, PVC and PEX joints are not butt welds, so their runs have no spools.

## Cut a run into spools

1. Pick a steel pipe run. In Properties, tick **Cut into spools**.
2. **Longest spool**: the most centre-line length one spool may have (6 m, about 20 ft, to start with).
3. **Line number**: part of every spool's number. A new spooled run gets the next free number of its system.

The spools are numbered along the run from its first point: `CHW-12-S01`, `CHW-12-S02` … (the system, the line number, the spool). A spool grows part by part; the part that would make it too long starts the next one, and a straight length longer than a spool is cut where the spool is full.

## Place field welds

1. Open {{ui:Build}} and choose {{ui:Field weld}}.
2. Click on a spooled pipe where the field weld goes. Inside a straight length the pipe is cut there; inside a fitting or a valve, the weld moves to the nearer joint.

Properties lists the run's field welds, each with {{ui:Remove}}. Each change is one step of {{ui:Undo}}.

## Spool sheets

In Properties of a spooled run:

- {{ui:Spool sheets (PDF)}}: one page per spool. On the left, the spool in a 30° isometric view: its straight lengths numbered, shop welds as dots, field welds marked FW, and the plan's north. On the right, the spool's number, size, schedule and length, then its **cut lengths**, **fittings**, **welds** (a shop butt weld at every joint inside the spool, a field weld where it meets the next spool) and its **bill of materials** with the pipe's weight (ASME B36.10M plain-end weight).
- {{ui:Spool list (CSV)}}: the same, a block per spool.

:::note
Cut lengths are end to end as drawn: no root gap or weld allowance is taken off. Elbows are at the B16.9 long radius; tees, reducers and valves are generic, sized from the pipe, not from B16.9 or a maker, and the sheet says so. Fitting weights are not given. A drafting and coordination aid, sized by an engineer.
:::

## In the IFC file

Every part of a spooled run carries **CadCraft_Spool** with its SpoolId, the run, the spool's number in the run, and where it starts and ends along the run. The run keeps its rules (longest spool, field welds, line number) in its own set, so the spools come back the same when the file is opened again.

## Ducts: a cut list

Open {{ui:Build}} and click {{ui:Duct cut list}}: a CSV of the straight duct pieces by system, shape and size, each straight length cut into pieces of the **Piece length** in the Duct bar (1500 mm, about 5 ft, to start with) and what is left. Lengths only: no seams, gauges or connectors.
