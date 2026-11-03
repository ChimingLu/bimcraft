---
title: Open a project bundle
summary: A project bundle is one zip with a model, its views, its layouts and its property groups. Open it, show a view with its storey and layers, open a layout, and see properties in the project's own groups.
section: tasks
order: 73
keywords: bundle, project bundle, ccbundle, zip, views, view map, layouts, layout book, layer combination, property groups, standards, pln, template
---

## What you'll do

Open a **project bundle** (`.ccbundle.zip`) and work with the project the way it was organised: its views, its layouts and its property groups, on top of the model.

A bundle holds:

- the model as IFC,
- the layouts as PDF and DWG,
- a list of what IFC leaves out: the views (each with its storey, layer combination and scale), the layouts and the drawings placed on them, property definitions in their groups, classifications, and standards such as layers, pen sets, line types, fills, surfaces and composites.

Bundles are written by an open-source script that runs inside Archicad and asks Archicad itself for these lists. BimCraft never reads `.pln` or `.tpl` files directly; see [Open .pln and .pla project files](topic:pln-project-files).

## Make a bundle

The script is a preview: it has not been tried on every Archicad version yet. Get it from [github.com/getcadcraft/bim-project-bundle](https://github.com/getcadcraft/bim-project-bundle). You need Archicad 24 or later and Python 3.8 or later; nothing else to install.

1. Save `archicad_bundle.py` into a folder, for example `C:\cc-bundle`.
2. In Archicad, open the project and make a publisher set named exactly **CadCraft bundle**: the 3D view as IFC, every layout as PDF, and every layout again as DWG, published to files on disk in one flat folder.
3. With the project open, run `python archicad_bundle.py --probe --out .` once. It only reads, and writes `probe.json`.
4. Run `python archicad_bundle.py --out . --translator "IFC4 Reference View"` (use the IFC translator you picked). Archicad publishes the set and the script writes `<project>.ccbundle.zip`.

If publishing through the script fails, publish the set by hand and run `python archicad_bundle.py --out . --no-publish --files <folder>\*.ifc <folder>\*.pdf <folder>\*.dwg`. The repository's README has every option. If something does not come through, open an issue there and attach `probe.json`.

## Open a bundle

1. Click {{ui:Choose a file}}, or drop the `.ccbundle.zip` on BimCraft. In a folder you opened with {{ui:Open a folder}}, bundles are listed under **Project bundles**; click one by name.
2. The model opens as any IFC does, and the **Project bundle** section appears on the left, under the file's facts.

Nothing is uploaded: the bundle is read on your computer, one file at a time, so a large model is not copied twice.

## Show a view

Under **Views**, views are grouped by the folders they had in the project. Click a view's name:

- **A floor plan** shows only its storey, seen from the top.
- **Its layer combination** hides the elements on the layers that combination hides. The status line says how many elements that hid.
- **Its scale** is shown beside the name and in the status line.
- **A 3D view** shows every storey.

To show everything again, use {{ui:Show all}} in {{ui:Show}} and tick every storey.

:::note
BimCraft finds the layers through the IFC file's layer assignments. If the IFC was exported without them, a layer combination hides nothing, and the status line says 0 elements hidden.
:::

## Open a layout

Under **Layouts**, each layout shows its number, name, paper size and the views placed on it.

- **PDF** saves the layout's PDF from the bundle.
- **DWG** opens the layout's drawing in the 2D view. Click any view to come back to the model.
- **Open in …** sends the layout's file to the app that works on it, in a new tab: the PDF to MarkupCraft, the DWG to CadCraft. It shows only where that app is open next to BimCraft. The file is read from the bundle as the tab loads, and nothing is uploaded.

A layout with neither says **No file in the bundle**.

## See properties in the project's groups

Pick an element. **Property groups** shows its properties under the groups the project defined, matched through the property set and name the definition gives for IFC, or else by its name. The rest stay in {{ui:Properties}} as usual. **Property definitions** lists every definition with its group, type and IFC name.

## Standards and notes

- **Standards** counts the layers, layer combinations, pen sets, line types, fills, surfaces, composites and materials in the bundle.
- **Notes** lists what the script could not get from that version of Archicad, any field BimCraft could not read, and any file the bundle names but does not hold.

## Troubleshooting

- **"… is a zip but not a project bundle."** The zip has no `manifest.json`. Unzip it and open the `.ifc` inside.
- **"… is a newer project bundle than this BimCraft reads."** Update BimCraft.
- **"… does not hold the model its manifest names."** The zip was cut short or edited. Make the bundle again.
- **A view shows every storey.** Its storey is not in the model's IFC (the status line says so). Check that the IFC export included that storey.

See also [Working between two BIM programs](topic:two-bim-programs) and [What BimCraft reads from each format](topic:file-formats).
