---
title: Estimate heating and cooling loads
summary: Each room's heat loss, its heating over a year by degree-days and its cooling peak, from what bounds it in the model and each element's U-value, with every input shown. A design aid, not a compliance calculation.
section: tasks
order: 49
keywords: energy, heating, cooling, heat loss, heat load, cooling load, u-value, thermal transmittance, degree-days, hdd, ventilation, air changes, internal gains, solar gain, lambda, conductivity, insulation, early design, analysis, rooms, spaces
---

In the {{ui:Daylight}} tab, after {{ui:Calculate}}, open {{ui:Heating and cooling loads}} and click {{ui:Work out the loads}}. Each room gets its **heat loss** on a cold design day, its **heating over a year** and its **cooling peak** on a hot one. Nothing is uploaded; nothing changes in the model unless you type a U-value.

:::warning
This is **a design aid, not a compliance calculation**: a steady-state estimate with every input on the screen. It is **not** the ISO 52016-1 method, not a simulation and not an energy certificate; it does not size boilers, heat pumps or chillers. Check results, and size equipment, with an engineer.
:::

## What bounds each room

BimCraft finds it in the model itself, so any program's IFC works (it does not need the space boundaries some programs export). From every bit of each room's own surface it looks straight out:

- the first wall, window, door, floor, roof, covering, curtain wall or beam it meets **bounds** that bit;
- just past that element, either **another room** (counted as next door, at the same temperature: no loss), **nothing** (outside), or, under a floor on the lowest level, **the ground**;
- an open doorway into another room counts as next door; a bit that meets nothing at all (within 1.5 m sideways or down, 8 m up) is listed under the room and left out.

Windows and doors take their own size from the IFC (overall width × height) from the wall they sit in. Click a room in the table to see every element that bounds it with its area, its U-value and where the U-value came from.

## U-values

For each element BimCraft uses, in this order:

1. **The IFC's own U-value** — the `ThermalTransmittance` in the element's common property set (for example `Pset_WallCommon`) or its type's. Most design programs can write it.
2. **Its material layers** — 1 ÷ (inside surface resistance + each layer's thickness ÷ its conductivity λ + outside surface resistance), with the usual surface resistances (0.13 and 0.04 m²K/W for walls; 0.10 upward, 0.17 downward inside). Typical conductivities to start (mineral wool 0.035, brick 0.77, concrete 1.4…); under {{ui:Materials' conductivity}} type the maker's, and every U-value from those layers follows.
3. **A typical value** (walls 0.3, roofs 0.2, floors 0.25, windows 1.4, doors 1.6 W/m²K), marked as such — type yours.

A U-value typed in a room's detail is written into the element's common property set as `ThermalTransmittance` (one step; {{key:Mod+Z}} undoes it). If several elements share that set (one wall type, say), they all change together, and the status line says how many.

## Heating

- **Heat loss** = Σ U × A × (inside − outside) for everything to outside + Σ U × A × (inside − ground) for floors on the ground + 0.335 × air changes an hour × the room's volume × (inside − outside). 0.335 Wh per m³ per kelvin is air's density (1.2 kg/m³) times its heat capacity (1005 J/kgK).
- **Heating a year** = (the room's loss per degree to outside, through the fabric and the air, plus its ground loss scaled to the same difference) × the **degree-days** × 24 ÷ 1000, in kWh. Type the degree-days for the place, or {{ui:Read degree-days from a CSV…}} (one row per day or month; the last number in each row is added up). Use degree-days to the base temperature your source uses: that base already allows for the free heat of people, lights and the sun.

## Cooling

The **cooling peak** = the heat through the fabric and the air at the summer design temperature + people (floor per person × heat per person) + lighting and equipment per m² of floor + **the sun**: the peak of {{ui:Sun through the windows on a date}} for that room. Work out the sun first, on a hot day; until then the sun counts 0 and the section says so. The peak of each part is added together even if they fall at different hours, which overstates a little.

## What it leaves out

- The ISO 52016-1 monthly and hourly methods (a paid standard), heat stored in the building's mass, thermal bridges, how heating and cooling systems perform, and climate files.
- Rooms next to each other are taken at the same temperature; unheated spaces are not modelled.

See also [Estimate the daylight in each room](topic:daylight-factor).
