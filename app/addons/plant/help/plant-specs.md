---
title: Plant: pipe specs
summary: What a pipe spec is, the five that come with the add-on, and how a pipe run is checked against its spec.
section: tasks
order: 10
keywords: pipe spec, specification, class, size, valve, branch, bend, elbow, steel, copper, pvc, pex
---

## What a spec is

A pipe spec is a class of pipe the way a plant writes it: the material and wall, the smallest and largest size, the valves it may carry and at which sizes, whether its elbows are long or short radius, and how a branch is made off a header of each size.

Five come with the add-on, written from the public size tables (steel to ASME B36.10M, copper to ASTM B88, PVC to ASTM D1785, PEX to ASTM F876): carbon steel Sch 40 (`CS40`) and Sch 80 (`CS80`), copper type L (`CU-L`), PVC Sch 40 (`PVC40`) and PEX (`PEX9`). They are general-service starting points and ours; a plant's own spec book overrides them.

A run is matched to its spec by the **material and class** it already carries, so nothing has to be added to a run to check it.

## Check a run

Select a pipe run: {{ui:Properties}} shows a {{ui:Pipe spec}} section — the spec, the sizes it allows, whether this run's size and each valve are allowed, the bends, and how branches of 4:1, 2:1 and 1:1 are made. Select several runs and press {{ui:Check the selected pipe runs}} in the {{ui:Plant}} tab to list every finding.

| Finding | Level | Means |
|---|---|---|
| No pipe spec | warning | the run's material and class match no spec |
| Size not allowed | error | the run's size is outside the spec's sizes |
| Valve not allowed | error | the spec does not allow that kind of valve at that size |

## Branches and bends

A branch up to a quarter of its header's size is a stub-in on the steel specs; larger ones are reducing tees; equal sizes are tees. A branch larger than its header is not a branch. A long-radius elbow's centre line is 1.5 × the nominal size; a short one is one nominal size (at least the outside diameter).
