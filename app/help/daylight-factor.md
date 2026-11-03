---
title: Estimate the daylight in each room
summary: The average daylight factor of every room from its windows, its inside surfaces and the sky each window sees, with the sky angle measured in the model. An early-design estimate, not a simulation or a code check.
section: tasks
order: 48
keywords: daylight, daylight factor, average daylight factor, adf, vertical sky component, vsc, solar gain, sun, g-value, grid, split flux, sky component, internally reflected component, natural light, window, glazing, sky angle, obstruction, overshadowing, balcony, overhang, reflectance, transmittance, early design, analysis, rooms, spaces
---

The {{ui:Daylight}} tab in the right panel works out each room's **average daylight factor**: how much of the light of an overcast sky outside reaches the room, on average, as a percentage. It reads the open IFC model's rooms (spaces) and windows. Nothing is changed in the model and nothing is uploaded.

:::warning
Everything in this tab is **a design aid, not a compliance calculation**: early-design estimates by published methods, **not a simulation** and **not a check against a building code or a standard**. BS EN 17037, LEED, BREEAM and energy codes ask for a daylight simulation with the climate of the place; use a daylight simulation program for those.
:::

## Work it out

1. Open an IFC model that has rooms (spaces) and windows. Models drawn here have a room inside every closed set of walls.
2. Open the {{ui:Daylight}} tab and click {{ui:Calculate}}.
3. Each room shows its daylight factor and a band: under 2 %, 2–5 %, 5 % or more. Click a room to see its surfaces and each window's area and sky angle; the room and its windows are picked in the model.

Change an input and the numbers follow at once; after changing the model, {{ui:Calculate again}}. {{ui:CSV}} saves every room with its numbers and the inputs used.

## The formula

Average daylight factor (%) = T × Ag × θ × M ÷ (A × (1 − R²)), added up over the room's windows (Littlefair's formula, used by BRE 209, BS 8206-2 and CIBSE LG10):

- **T**, the glass's light transmittance (0.7 to start: use the maker's figure).
- **Ag**, the glazed area: each window's area (its overall width × height, else its size in the model) × the **glazed share** (0.75 to start: the rest is frame).
- **θ**, the angle of sky the window sees, in degrees (below).
- **M**, the maintenance factor for dirt on the glass (1 to start).
- **A**, every inside surface of the room: floor, walls, ceiling and windows, taken from the room's own shape.
- **R**, their mean reflectance, weighted by area: floor 0.2, walls 0.5, ceiling 0.7 to start; glass counts as 0.1.

## How the sky angle is measured

For each window BimCraft cuts the model with an upright plane square to the window, from the outside face of the glass, and looks from the horizon straight up: everything the cut meets in front of the window (a building opposite, a balcony or an overhang above, the eaves) hides part of that 90°. θ is what is left. The window itself and the wall it sits in are left out. It does this at five places across the window's width and takes the mean, so a thin post in front of the middle takes its share, not the whole sky.

A building 8.5 m above the window's centre and 9.9 m away hides 40.65° (the angle whose tangent is 8.5 ÷ 9.9), leaving θ = 49.35°.

## Vertical sky component of each window

{{ui:Calculate}} also measures, for every window, what it sees of the whole sky: the same upright cut, turned to every direction across the window's front (every 2°, from one side to the other), so a building to one side, a fin or a deep reveal takes its share. From that BimCraft works out the **vertical sky component (VSC)**: how much of the overcast sky's light reaches the glass, as a share of what an open, flat roof would get. A window with nothing in front of it gets **39.6 %**, the most a vertical window can; a long building rising 25° above the window leaves about **27 %**, the figure UK guidance (BRE 209) uses as a rule of thumb. Each window in a room's detail shows its VSC and its **angle of obstruction** (how high things rise straight in front of it).

The sky is the CIE standard overcast sky, which is three times brighter straight up than at the horizon, and the cut is exact: nothing is sampled.

## The sun through the windows on a date

Open {{ui:Sun through the windows on a date}} and pick a date. BimCraft follows the sun through that day in quarter-hours and adds up, for each window, the heat the sun brings through the glass:

- the **direct sun**, when it is in front of the window and nothing in the model hides it (the same exact cut, turned toward the sun: a balcony that shades the high summer sun at noon lets the low winter sun in);
- the **sky's light** on the glass, less what the window cannot see;
- the light **off the ground** (its reflectance: 0.2 to start);
- all through the glass's **g-value** (the share of the sun's energy it lets through: 0.6 to start; use the maker's figure) and its glazed share.

Each room shows the day's total in kWh and its peak in watts with the time; a room's detail draws the day as a chart. The sky is a clear one by Hottel's model (Duffie & Beckman, *Solar Engineering of Thermal Processes*), with the summer or winter figures for the place and season and the site's height; the sun's place is NOAA's. The site's latitude and longitude come from the IFC's site, and north from the model's true north; if the model has no site, type a latitude and longitude. Times are standard time (no summer time) in the time zone you type, else the one the longitude suggests.

What it leaves out: clouds (it is a clear day), the glass letting in less at low angles, frames shading the glass, blinds, and what the walls and roof take in. The cooling estimate in the same tab uses the peak.

## The daylight factor on a grid

Open {{ui:Daylight factor on a grid}} and {{ui:Work out the grid}}: BimCraft lays a grid over each room's floor at the working-plane height (0.85 m to start), half a metre in from the walls, and works out the daylight factor at every point by the **BRE split-flux method**:

- the **sky component**: the overcast sky seen from the point through each window's opening, less the frames;
- the **externally reflected component**: what the point sees of buildings outside through the window, shining at a tenth of the sky behind them (change the obstruction brightness if they are much lighter or darker);
- the **internally reflected component**: the light bouncing around the room, from the room's surfaces and reflectances, the windows' area and how much is outside them (the BRE formula, with the glass's transmittance in place of the clear glass it assumed).

Each room shows its mean, its lowest point and how much of it gets 2 % or more; a room's detail draws its plan with every point coloured by its daylight factor and the windows in red. To keep it quick on any computer a room gets at most **400 points**: in a big room the spacing grows to fit (type a spacing to choose your own).

## What it leaves out

- Roof windows (glass lying flat or sloping) are listed but not counted: the formulas here are for windows in walls.
- Windows with no room behind them (a hall without a space, for example) are listed apart.
- Window reveals (the opening is taken on the outside face), glare, sun hours and climate-based daylight. For BS EN 17037, LEED or BREEAM use a daylight simulation program.
- The bands are from older British guidance (BS 8206-2), shown as a guide, never as a pass or fail.
