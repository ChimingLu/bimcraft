---
title: What your machine renders with
summary: Settings › Rendering shows the graphics, processor cores and memory this browser lets the app use, and the level that sets where rendering starts.
section: reference
order: 60
keywords: your machine, graphics card, gpu, webgpu, webgl, processor, cpu, cores, threads, memory, ram, shared memory, isolation, tier, level, speed, slow, rendering speed, laptop
---

Open {{ui:Settings}} ({{key:Mod+,}}), stay on this app's own tab and scroll to {{ui:Rendering}}. {{ui:Your machine}} lists what this browser lets the app use for rendering. Nothing in it leaves your computer.

| Row | What it means |
|---|---|
| {{ui:Graphics}} | The graphics card the browser reports. "WebGPU" means it can do the rendering work; "WebGL 2 only" means there is no WebGPU: the live view and high-quality pictures use the graphics card through WebGL 2 (pictures with the older WebGL path tracer, without the extras that need WebGPU); a software stand-in means everything runs on the processor |
| {{ui:Processor}} | How many processor cores the browser reports |
| {{ui:Memory}} | About how much memory the computer has, when the browser says. Some browsers do not |
| {{ui:Shared memory}} | Whether the page may share memory between its workers. On, every core can work on one copy of a scene; off, each needs its own copy, so a large scene fits on fewer cores at once |
| {{ui:Fast processor code}} | Whether the browser runs the faster WebAssembly code. Without it a slower fallback is used |
| {{ui:Level}} | {{ui:Graphics card, high}}, {{ui:Graphics card, basic}} or {{ui:Processor only}}, with the reason under it |

## The level

The level is where rendering starts, so that a laptop with a built-in graphics chip or no graphics card at all stays responsive. A built-in or phone graphics chip, or 4 GB of memory or less, never gets {{ui:Graphics card, high}}.

:::note
Browsers differ. The same computer can show WebGPU in one browser and "WebGL 2 only" in another. On Linux most browsers have no WebGPU yet.
:::
