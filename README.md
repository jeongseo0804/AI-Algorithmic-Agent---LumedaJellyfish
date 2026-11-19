# Luma Jellyfish Agent

Luma is a p5.js jellyfish living in a phone-sized aquarium. The experience uses real phone sensors so the water moves first and the jellyfish follows with soft inertia.

## Interactions

- **FLOAT** — tilt the phone to slope the water surface and carry Luma through the tank.
- **SWIRL** — shake the phone to create a decaying vortex that pulls, spins, and tumbles Luma.
- **FOLLOW LIGHT** — the hidden front-camera feed detects the brightest region; Luma swims toward it while the tank becomes a subtle camera filter.
- **Night mode** — switches the tank's lighting without changing the interaction physics.

The exploration guide advances only through active sensor use: 7.5 seconds of tilting, 3 seconds of shake/vortex activity, and 4 seconds of camera-driven light following. Pauses do not count.

## Run the project

Open [`index.html`](./index.html) through an HTTPS web server. Camera and motion access will not work reliably from a local `file://` URL.

On iOS:

1. Open the page in Safari.
2. Tap **Enable Sensors & Camera**.
3. Allow motion access, then allow the front camera.
4. Choose **FLOAT**, **SWIRL**, or **FOLLOW LIGHT** in the tank.

The project loads p5.js and p5-phone from jsDelivr. The camera image is never uploaded by this code; it is read in the browser for brightness and light-direction analysis.

## Files

- `sketch.js` — state machine, sensor processing, physics, visuals, and exploration prompts
- `index.html` — mobile viewport and library setup
- `style.css` — full-screen mobile tank layout

The working p5.js editor version is available at [Luma da Jellyfish copy](https://editor.p5js.org/Jeongseo/sketches/PT0DLxNr_).
