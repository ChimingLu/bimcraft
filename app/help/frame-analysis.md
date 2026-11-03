---
title: Analyse the structural frame
summary: Forces, reactions and deflections of the model's beams, columns and braces under load cases and combinations you set, kept in the IFC. An analysis aid, not a code check.
section: tasks
order: 60
keywords: analysis, structural analysis, design checks, utilisation, rolled, welded, AISC 360, EN 1993-1-1, frame analysis, analytical model, stiffness method, loads, load case, combination, dead load, live load, self weight, own weight, reactions, bending moment, shear, axial force, deflection, deflected shape, supports, pinned, fixed, release, report, pdf, csv, craftscript, frame3d, beams, columns, members
---

The {{ui:Analysis}} tab on the right finds the forces in the open model's beams, columns and braces, the reactions at the column feet and how far the members bend, for the loads you give it.

:::warning
It is an **analysis aid, not a code check**. The analysis applies no design code: it does not size members or check capacities, and it does not pick load factors. An engineer checks the analytical model, its loads and supports, and decides what the numbers mean. The {{ui:Design checks}} block below it checks rolled steel I-shapes to AISC 360 or EN 1993-1-1, an aid until an engineer has reviewed it: see [Design checks](topic:frame-analysis#design-checks).
:::

## Run it

1. Open an IFC model and the {{ui:Analysis}} tab.
2. Pick one or more beams, columns or braces in the view, choose a {{ui:Case}}, a {{ui:Load}} and a {{ui:Direction}}, type the value and press {{ui:Add load}}: kN/m for a load spread along a member, kN for a point load.
3. Press {{ui:Run analysis}}.

The table lists each member's largest axial force, shears, bending moments, torsion and deflection; click a member's name to pick it in the view. Below are the reactions. {{ui:On the model}} draws the deflected shape, or one action as a diagram beside each member. The results go out of date when the model changes: run it again.

Each load and setting is one change in the {{ui:Changes}} list: {{ui:Undo}} takes it back, and {{ui:Save as IFC}} keeps them in the file (the project's `CadCraft_Analysis` property set), so the next time the model opens here its loads are still there.

## How the analytical model is made

- Every IfcBeam, IfcColumn and IfcMember whose shape is one straight extrusion becomes a member on its section's centroid line. Its section properties come from the profile: I, U, L and T shapes, rectangles and tubes, circles and round tubes, or any closed outline (then the torsion constant is an estimate, said in the report). Anything else is left out and counted.
- In a model, beams stop at a column's face and sit below the floor. Each member end is carried along its own line onto the axis of the member it frames into, when that axis is close (within about the size of the sections), and that member is split there. The report says how many ends moved.
- **Column feet** nothing goes below are supports: fixed (the start) or pinned (held in place and against twisting, free to turn).
- **Beam ends** are rigid or pinned by the {{ui:Beam ends with no connection}} rule; **braces** (IfcMember) are pinned at both ends. Pick one member to give its ends, or a column's foot, a rule of their own.
- Materials by name: concrete (E = 30 GPa), timber (E = 11 GPa), otherwise steel (E = 200 GPa).

If the frame can move without bending anything — a mechanism — the run stops and says where and which way.

## Cases, combinations, signs and the report

The analysis starts with **Dead** (own weight), **Live** and **Dead + live**; add cases and combinations with the factors your design code asks for. N > 0 is tension; My > 0 puts the member's local −z side in tension (a beam sagging under gravity has My > 0). {{ui:Report (PDF)}} and {{ui:Report (CSV)}} hold the assumptions, sections, cases, reactions with their sums, member forces, displacements and an envelope. {{ui:Export as CraftScript}} writes the frame for PartCraft's Script workspace, where the library function `frame3d` solves it in readable code.

The method is the direct stiffness method, first order and linear, checked against textbook cases. Not built yet: P-Δ, buckling, dynamics, area loads, member offsets, tension-only braces, walls and slabs in the frame, design code checks of welded shapes and of sections other than rolled I-shapes. See [Not built yet](topic:not-built-yet).

## Design checks

The {{ui:Design checks}} block (the same as DetailCraft's) takes a {{ui:Design code}}, ASCE 7 + AISC 360 or EN 1990 + EN 1993-1-1, and a {{ui:Steel grade}}. Give each load case its kind (dead, live, wind …) and {{ui:Make combinations}} writes the code's load combinations of your cases; the analysis then runs them like any combination.

{{ui:Check members}} then checks each **rolled steel I-shape** with DetailCraft's checks (tension, compression with buckling, bending with lateral-torsional buckling, shear, bending with axial force, deflection; the clauses are in the report) and shows how much of its capacity it uses, coloured on the model. It is an **aid until an engineer has reviewed it**.

**Which members are checked.** An IFC profile does not say whether a steel I-shape is rolled or welded, so BimCraft calls it rolled only when its profile name (else the element's type name) is a size from the AISC W or S tables or the EN 10365 IPE, HEA or HEB tables (`W12x26`, `IPE 300`, `HEA200`, `HE 200 A`) **and** the depth, width, web and flange in the file match that size within 1 %. Every other I-shape (a plate girder, a size under another name, an edited size) is taken as welded and comes back **not checked**, as are tubes, angles, channels and other sections, slender parts and torsion. Check those members with an engineer.
