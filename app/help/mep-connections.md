---
title: Connect pipes and ducts to equipment
summary: Start or end a pipe or duct on a port so it takes the port's size and system and stays fixed to it, then check the connections — open ports, size and system mismatches, runs with no source.
section: tasks
order: 38
keywords: mep, connect, connection, connections, port, ports, open port, size mismatch, system mismatch, source, check connections, fixed, follow, move equipment, ifcrelconnectsports, coordination
---

## What you'll do

Join the runs to the equipment so the model is one connected system: a pump's outlet to the pipe that leaves it, a diffuser's neck to its branch duct. Then let BimCraft list what is not joined up.

## Draw from a port

1. Choose {{ui:Pipe}} or {{ui:Duct}}.
2. Move the pointer onto a port of a piece of equipment (the small circles; an open port is drawn in the warning colour). The pointer snaps to it and says **on a port**.
3. Click: the run starts at the port's height and **takes its size and system** (a pipe also takes the system's usual material). The status line says what it took.
4. Draw on as usual. Ending a run on another port fixes that end too.

A run's end on a port is **fixed** to it: move or turn the equipment (in Properties) and the run's end goes with it; edit the run and that end stays on the port. The run's other corners stay where they are, so after a big move the first leg may come off the port at an angle: move the next corner too.

## Check the connections

Open {{ui:Build}} and click {{ui:Check connections}}. The list under the bar shows:

| Line | What it means |
|---|---|
| A port is not connected | A piece of equipment has a connection nothing is drawn to |
| Nothing on its end | A run ends in the air |
| Joined ports of different sizes | A run of one size meets a port or run of another without a reducer (a pipe's nominal size, a duct's shape and sides) |
| Joined ports of different systems | For example a return duct on a supply diffuser |
| A pipe joined to a duct | Two connections of different kinds meet |
| No equipment in its network supplies it | Nothing that a run is joined to, however far along, has an outlet. Drains, storm and vents are not asked this: their water comes from fixtures |
| Fixed to a port of equipment that is not in the model any more | The equipment was deleted; draw the end again or delete the run |

Errors come first. Click a line to pick what it names. {{ui:Close}} hides the list. The check reads the model as drawn: it checks connections and sizes, never flows, pressures or balancing.
