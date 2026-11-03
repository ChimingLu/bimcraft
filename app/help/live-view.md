---
title: The live view
summary: A panel beside the model that shows it in the real-time look, with sun, shadows and bounce light, and follows every change you make; walk through it and set the time of day and the month.
section: tasks
order: 33
keywords: live view, real time, realtime, real-time render, walkthrough, walk, walk through, first person, presentation, client, second screen, second window, monitor, time of day, sun, season, month, shadows, ambient occlusion, reflections, bounce light, global illumination, webgpu, webgl
---

The live view shows the model in the real-time look: the sky and the sun from your site's place and date, the sun's shadows, the paints and materials you gave the elements, lamps, and light bounced off walls and floors. It follows what you do: turn the 3D view and it turns too, change the model and it shows the change a moment later. Nothing is uploaded.

It draws the same scene, paints, lamps and sun as [Render a picture](topic:render); for a finished picture use that.

## Open it

1. Open a model and choose {{ui:Live view}} in the toolbar. The panel opens over the app, bottom right.
2. Drag its title bar to move it, pull its corner to make it bigger.
3. {{ui:Live view in a new window}} (the button beside it) or {{ui:New window}} in the panel moves it to a window of its own, for a second screen. If your browser blocks pop-up windows, it opens as the panel.
4. {{ui:Close}} closes it.

## The controls

| Control | What it does |
|---|---|
| {{ui:Follow the view}} | On: the live view looks where the 3D view looks. Walking turns it off |
| {{ui:Walk}} | Walk through the model (below) |
| {{ui:Gravity}} | While walking: stand on floors and climb stairs. Off: fly |
| {{ui:Time}} | The hour of the day. The sun moves as you drag |
| {{ui:Month}} | The month, so you can see the sun in winter and summer |
| {{ui:Quality}} | {{ui:For this computer}}, or {{ui:Low}}, {{ui:Medium}} or {{ui:High}} |

The line at the bottom says what draws the view (WebGPU or WebGL 2), the quality, and the bounce light.

## Walk through the model

1. Turn the 3D view to where you want to stand and choose {{ui:Walk}}. You stand on the floor below the view's eye point, 1.6 m tall.
2. Click the live view, then use {{key:W}} {{key:A}} {{key:S}} {{key:D}} or the arrow keys. Hold {{key:Shift}} to run. Drag to look round.
3. Steps up to 40 cm are climbed (stairs); anything higher is a wall. Walls stop you and you slide along them.
4. With {{ui:Gravity}} off you fly: {{key:E}} goes up, {{key:Q}} down.
5. {{key:Esc}} stops walking.

## Bounce light

Light that bounces off a sunlit wall onto the floor, and the darker inside of a room, are worked out in the background on every processor core. While it works the bottom line says {{ui:Bounce light: 40 %}}; when it is ready the view takes it in. After a change it starts again.

:::note
This is an approximation for a live view, not a rendered picture: small details between the points get the bounce light of the points near them.
:::

:::note
Browsers differ. Where the browser has WebGPU the live view uses it; elsewhere it uses WebGL 2 and looks the same. With neither, the panel says so.
:::
