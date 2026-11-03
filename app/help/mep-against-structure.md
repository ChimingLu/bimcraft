---
title: Check pipes and ducts against the structure
summary: Run the ready-made clash sets of pipes and ducts against walls, slabs, beams and columns, find runs closer to the structure than their insulation and a gap, and list the openings runs need through walls and slabs as CSV and BCF.
section: tasks
order: 39
keywords: mep, clash, clash check, coordination, structure, walls, slabs, beams, columns, clearance, soft clash, insulation, gap, opening, openings, penetration, sleeve, core, builder's work, bcf, csv
---

## What you'll do

Make sure the services fit the building: what runs into the structure, what passes too close to it, and where the walls and slabs need holes. Open {{ui:Clash check}} in the left panel; the section **Pipes and ducts against the structure** is under the usual check.

## Hard clashes

The two set lists now also offer **Pipes and ducts**, **Walls**, **Slabs and roofs**, **Beams**, **Columns** and **Structure** (all four), with how many elements each holds. Click {{ui:Pipes and ducts × structure}} to pick the first and the last and run the check; or pick any pair yourself and click {{ui:Run}}. See [Check for clashes](topic:clash-check).

## Clearances

Some services need room round them: their insulation, and space to work or for a sleeve.

1. Give a pipe or duct run its **Insulation** thickness in Properties (nothing is drawn for it).
2. Type the **Gap round pipes and ducts** (mm) in the Clash check.
3. Click {{ui:Check clearances}}: each part closer to a wall, slab, beam or column than its insulation plus the gap is listed with the distance it has and the distance it wants. Click a line to see the two.

A part that passes through a wall or slab is an opening, not a clearance, and is listed there instead.

## Openings needed

Click {{ui:Openings needed}}. Where a run's centre line passes through a wall or a slab, BimCraft lists the opening it needs: round for a round pipe or duct, otherwise rectangular, as big as the run's outside size plus twice its insulation plus twice the gap, centred where the run crosses. Click a line to see the run and the wall or slab.

- {{ui:Openings as CSV}}: one line per opening with the run, its size and insulation, the opening's size, the element it passes through and its GlobalId, the level, the centre's X, Y and Z, and how far the run goes through.
- {{ui:Openings as BCF issues}}: one issue per opening, with a camera looking at it and the run and the element picked, for the structural engineer's program.

:::note
Nothing is cut: the openings are a list for the people who size them. The gap is yours to type; no code says how big an opening must be. Beams and columns are clashes, not openings: whether a pipe may pass through one is the structural engineer's call.
:::
