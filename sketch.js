// LUMA — Camera Jellyfish Agent
// Tilt to drift, shake to stir, and use the front camera to follow light.

const CALM = "CALM", DRIFT = "TILT DRIFT", VORTEX = "VORTEX", LIGHT = "FOLLOWING LIGHT", SEARCHING = "SEARCHING LIGHT", SETTLING = "SETTLING";
const MODE_TILT = "TILT", MODE_SHAKE = "SHAKE", MODE_LIGHT = "LIGHT";
let state = CALM;
let interactionMode = MODE_TILT;
let jellyPos, jellyVel, homePos, waterVel, previousAccel, lightPos, lightTarget;
let tiltX = 0, tiltY = 0, waterTilt = 0, waterTiltVelocity = 0;
let sensorAccel = { x: 0, y: 0, z: 0 }, shakeEnergy = 0, lastShakeAt = -1000;
let neutralBeta = null, neutralGamma = null;
let motionSampleCount = 0, orientationSampleCount = 0;
let vortexStrength = 0, vortexDirection = 1, spin = 0, spinSpeed = 0, pulse = 0;
let started = false, nightMode = false, sensorSeen = false;
let cam = null, cameraReady = false;
let lightLevel = 0, lightActivity = 0, lightConfidence = 0, cameraSampleCount = 0, lastPressAt = -1000;
let cameraFilterMix = 0;
let cameraPromptStarted = false;
let bubbles = [], currents = [];
let nativeOrientation = { beta: 0, gamma: 0, seen: false };
let nativeMotion = { x: 0, y: 0, z: 0, seen: false, time: 0 };

// Exploration guidance only. These values observe the existing interactions;
// they do not change the water or jellyfish physics.
const EXPLORE_FLOAT = 0, EXPLORE_SWIRL = 1, EXPLORE_LIGHT = 2, EXPLORE_COMPLETE = 3;
let explorationStep = EXPLORE_FLOAT;
let floatProgress = 0, swirlProgress = 0, lightProgress = 0;
let explorationPromptAge = 0, explorationPromptAlpha = 0;
let explorationWasStarted = false;
let floatInteractionStarted = false, swirlInteractionStarted = false, lightInteractionStarted = false;

function setup() {
  const viewport = getViewportCanvasSize();
  createCanvas(viewport.w, viewport.h);
  pixelDensity(min(2, displayDensity()));
  jellyPos = createVector(width * 0.5, height * 0.45);
  jellyVel = createVector(0, 0);
  homePos = jellyPos.copy();
  waterVel = createVector(0, 0);
  previousAccel = createVector(0, 0, 0);
  lightPos = createVector(width * 0.5, height * 0.35);
  lightTarget = lightPos.copy();
  textFont("Arial");
  for (let i = 0; i < 30; i++) bubbles.push({ x: random(width), y: random(height), r: random(2, 7), speed: random(0.25, 0.8), alpha: random(35, 110) });
  for (let i = 0; i < 28; i++) currents.push({ angle: random(TWO_PI), radius: random(55, min(width, height) * 0.44), x: random(width), y: random(height), len: random(16, 45) });
  installPhoneCameraCompatibility();
  // p5's acceleration globals can remain at zero on iOS because Safari often
  // exposes accelerationIncludingGravity instead. Keep native sensor samples
  // as a fallback after p5-phone has obtained permission.
  window.addEventListener("deviceorientation", captureNativeOrientation, true);
  window.addEventListener("devicemotion", captureNativeMotion, true);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resizeToVisibleViewport);
  lockGestures({ mode: "fullscreen", trapHistory: true });
  setShakeThreshold(12);
  cam = createPhoneCamera("user", true, "contain");
  cam.onReady(() => { cameraReady = true; });

  // iOS requires each permission request to start from a user gesture. The
  // documented p5-phone tap helpers are therefore presented in two safe steps.
  window.addEventListener("permissionsReady", continuePermissionFlow);
  enableSensorTap("Enable Sensors & Camera");
}

function continuePermissionFlow() {
  if (!window.cameraEnabled && !cameraPromptStarted) {
    cameraPromptStarted = true;
    enableCameraTap("Enable Front Camera");
  }
}

function installPhoneCameraCompatibility() {
  // p5 2.3 requires the options object before createCapture's callback, while
  // p5-phone 1.13 still calls the older two-argument form internally.
  const majorVersion = typeof p5 !== "undefined" ? Number(p5.VERSION.split(".")[0]) : 1;
  if (majorVersion < 2 || !window.createCapture || window.__lumaCapturePatched) return;
  const p5CreateCapture = window.createCapture;
  window.createCapture = function(source, options, callback) {
    if (typeof options === "function") return p5CreateCapture(source, {}, options);
    return p5CreateCapture(source, options || {}, callback);
  };
  window.__lumaCapturePatched = true;
}

function captureNativeOrientation(event) {
  if (!window.sensorsEnabled) return;
  if (Number.isFinite(event.beta)) nativeOrientation.beta = event.beta;
  if (Number.isFinite(event.gamma)) nativeOrientation.gamma = event.gamma;
  nativeOrientation.seen = Number.isFinite(event.beta) || Number.isFinite(event.gamma);
}

function captureNativeMotion(event) {
  if (!window.sensorsEnabled) return;
  const linear = event.acceleration;
  const hasLinearSample = linear && [linear.x, linear.y, linear.z].some(Number.isFinite);
  const source = hasLinearSample ? linear : event.accelerationIncludingGravity;
  if (!source) return;
  nativeMotion.x = Number.isFinite(source.x) ? source.x : 0;
  nativeMotion.y = Number.isFinite(source.y) ? source.y : 0;
  nativeMotion.z = Number.isFinite(source.z) ? source.z : 0;
  nativeMotion.seen = true;
  nativeMotion.time = performance.now();
}

function getViewportCanvasSize() {
  const viewport = window.visualViewport;
  return {
    w: max(320, floor(viewport && viewport.width ? viewport.width : windowWidth)),
    h: max(420, floor(viewport && viewport.height ? viewport.height : windowHeight))
  };
}

function resizeToVisibleViewport() {
  if (typeof resizeCanvas !== "function" || !jellyPos) return;
  const oldW = width, oldH = height;
  const viewport = getViewportCanvasSize();
  if (abs(viewport.w - width) < 2 && abs(viewport.h - height) < 2) return;
  resizeCanvas(viewport.w, viewport.h);
  jellyPos.set(jellyPos.x / max(oldW, 1) * width, jellyPos.y / max(oldH, 1) * height);
  homePos.set(width * 0.5, height * 0.45);
  lightPos.set(width * 0.5, height * 0.35);
}

function draw() {
  const dt = min(deltaTime / 1000, 0.035);
  readInputs(dt);
  cameraReady = Boolean(cam && cam.ready && window.cameraEnabled);
  started = Boolean(window.sensorsEnabled || cameraReady);
  if (cameraReady && frameCount % 3 === 0) analyseCameraLight();
  const filterTarget = interactionMode === MODE_LIGHT && cameraReady ? 1 : 0;
  cameraFilterMix = lerp(cameraFilterMix, filterTarget, 1 - pow(0.045, dt));
  updateState();
  updatePhysics(dt);
  updateExplorationPrompts(dt);
  updateBubbles(dt);
  drawBackground();
  drawWaterAndDecor();
  drawCurrents();
  drawBubbles();
  drawJellyfish();
  drawGlass();
  drawUI();
  if (!started) drawPermissionHint();
  drawExplorationPrompt();
}

function readInputs(dt) {
  let targetTiltX = 0;
  let targetTiltY = 0;

  // Never read motion globals until the p5-phone permission flag is true.
  if (window.sensorsEnabled) {
    const beta = nativeOrientation.seen
      ? nativeOrientation.beta
      : (Number.isFinite(rotationX) ? rotationX : 0);
    const gamma = nativeOrientation.seen
      ? nativeOrientation.gamma
      : (Number.isFinite(rotationY) ? rotationY : 0);
    if (neutralBeta === null) neutralBeta = beta;
    if (neutralGamma === null) neutralGamma = gamma;
    const screenAngle = Number(window.screen?.orientation?.angle ?? window.orientation ?? 0);
    if (abs(screenAngle) === 90) {
      targetTiltX = constrain(gamma - neutralGamma, -45, 45);
      targetTiltY = constrain((screenAngle > 0 ? -1 : 1) * (beta - neutralBeta), -45, 45);
    } else {
      targetTiltX = constrain(beta - neutralBeta, -45, 45);
      targetTiltY = constrain(gamma - neutralGamma, -45, 45);
    }
    sensorSeen = true;

    orientationSampleCount++;
    const nativeFresh = nativeMotion.seen && performance.now() - nativeMotion.time < 250;
    sensorAccel.x = nativeFresh ? nativeMotion.x : (Number.isFinite(accelerationX) ? accelerationX : 0);
    sensorAccel.y = nativeFresh ? nativeMotion.y : (Number.isFinite(accelerationY) ? accelerationY : 0);
    sensorAccel.z = nativeFresh ? nativeMotion.z : (Number.isFinite(accelerationZ) ? accelerationZ : 0);
    motionSampleCount++;

    const now = createVector(sensorAccel.x, sensorAccel.y, sensorAccel.z);
    const jerk = p5.Vector.dist(now, previousAccel);
    previousAccel.set(now);
    const incomingShake = constrain((jerk - 0.38) / 4.2, 0, 1.8);
    shakeEnergy = max(shakeEnergy * pow(0.90, dt * 60), incomingShake);

    if (interactionMode === MODE_SHAKE && incomingShake > 0.10 && millis() - lastShakeAt > 115) {
      triggerVortex(map(incomingShake, 0.10, 1.8, 0.22, 1.05, true));
      lastShakeAt = millis();
    }
  } else {
    shakeEnergy *= pow(0.88, dt * 60);
  }

  const inputEase = 1 - pow(0.018, dt);
  tiltX = lerp(tiltX, targetTiltX, inputEase);
  tiltY = lerp(tiltY, targetTiltY, inputEase);
}

function updateState() {
  const tiltAmount = sqrt(tiltX * tiltX + tiltY * tiltY);
  if (interactionMode === MODE_SHAKE) {
    state = vortexStrength > 0.18 ? VORTEX : jellyVel.mag() > 0.32 ? SETTLING : CALM;
  } else if (interactionMode === MODE_LIGHT) {
    if (!cameraReady) state = SEARCHING;
    else if (lightActivity > 0.10) state = LIGHT;
    else state = CALM;
  } else {
    if (tiltAmount > 3) state = DRIFT;
    else if (jellyVel.mag() > 0.32) state = SETTLING;
    else state = CALM;
  }
}

function updatePhysics(dt) {
  const f = dt * 60;
  const targetWaterTilt = interactionMode === MODE_TILT ? tiltY : 0;
  waterTiltVelocity += ((targetWaterTilt - waterTilt) * 0.022 - waterTiltVelocity * 0.12) * f;
  waterTiltVelocity = constrain(waterTiltVelocity, -3.2, 3.2);
  waterTilt += waterTiltVelocity * f;

  const flowMax = min(width, height) * 0.0135;
  const targetFlow = interactionMode === MODE_TILT
    ? createVector(map(waterTilt, -45, 45, -flowMax, flowMax), map(tiltX, -45, 45, -flowMax * 0.22, flowMax * 0.22))
    : createVector(0, 0);
  const waterAcceleration = p5.Vector.sub(targetFlow, waterVel).mult(0.045 * f);
  waterVel.add(waterAcceleration);
  waterVel.mult(pow(interactionMode === MODE_TILT ? 0.992 : 0.965, f));

  // The jellyfish follows the moving water with drag; sensor values never set
  // its position directly.
  jellyVel.add(p5.Vector.sub(waterVel, jellyVel).mult(0.032 * f));

  if (state === LIGHT) {
    if (lightConfidence > 0.08) {
      lightPos.lerp(lightTarget, 0.12);
      const toward = p5.Vector.sub(lightPos, jellyPos);
      const distanceToLight = max(toward.mag(), 50);
      toward.normalize().mult((0.012 + lightActivity * 0.090) * lightConfidence * f * constrain(distanceToLight / 220, 0.35, 1.3));
      jellyVel.add(toward);
    } else {
      // Brightness still increases activity, but no direction is invented.
      jellyVel.y -= lightActivity * 0.018 * f;
    }
  } else if (state === CALM || state === SETTLING) {
    jellyVel.add(p5.Vector.sub(homePos, jellyPos).mult(0.0014 * f));
  }

  if (interactionMode === MODE_SHAKE && vortexStrength > 0.02) {
    const centre = createVector(width * 0.5, height * 0.47);
    const offset = p5.Vector.sub(jellyPos, centre);
    if (offset.mag() < 18) offset.set(18, 0);
    const tangent = createVector(-offset.y, offset.x).normalize().mult(vortexDirection * vortexStrength * 0.34 * f);
    const inward = offset.copy().normalize().mult(-vortexStrength * 0.075 * f);
    jellyVel.add(tangent).add(inward);
  }
  pulse += dt * (state === VORTEX ? 5.2 : state === LIGHT ? lerp(2.35, 4.1, lightActivity) : 2.1);
  jellyVel.y += sin(pulse) * 0.012 * f;
  jellyVel.mult(pow(state === VORTEX ? 0.992 : 0.977, f));
  jellyVel.limit(min(width, height) * 0.035);
  jellyPos.add(p5.Vector.mult(jellyVel, f));

  const marginX = min(width * 0.19, 115), marginTop = min(height * 0.19, 125), marginBottom = min(height * 0.25, 165);
  if (jellyPos.x < marginX) jellyVel.x += (marginX - jellyPos.x) * 0.012 * f;
  if (jellyPos.x > width - marginX) jellyVel.x -= (jellyPos.x - width + marginX) * 0.012 * f;
  if (jellyPos.y < marginTop) jellyVel.y += (marginTop - jellyPos.y) * 0.012 * f;
  if (jellyPos.y > height - marginBottom) jellyVel.y -= (jellyPos.y - height + marginBottom) * 0.012 * f;
  if (state === VORTEX) {
    // Keep the body tumbling with the moving water for the full vortex decay,
    // rather than applying only a brief rotation impulse at shake onset.
    const vortexSpin = vortexDirection * (0.025 + vortexStrength * 0.055);
    spinSpeed = lerp(spinSpeed, vortexSpin, 1 - pow(0.22, dt));
  } else {
    spinSpeed += (constrain(jellyVel.x * 0.018, -0.2, 0.2) - spin) * 0.015 * f;
  }
  spin += spinSpeed * f;
  spinSpeed *= pow(0.96, f);
  // A slow exponential decay lets the stirred water keep circling naturally.
  vortexStrength *= pow(0.988, f);
  lightConfidence *= cameraReady ? 0.997 : 0.94;
}

function triggerVortex(amount = 1.1) {
  if (interactionMode !== MODE_SHAKE || !window.sensorsEnabled) return;
  if (vortexStrength < 0.12) vortexDirection = sensorAccel.x < 0 ? -1 : 1;
  vortexStrength = constrain(vortexStrength + amount, 0, 2.3);
  spinSpeed += vortexDirection * amount * 0.06;
}

function analyseCameraLight() {
  if (!cam || !cam.ready || !cam.video) return;
  const video = cam.video;
  video.loadPixels();
  if (!video.pixels || video.pixels.length < 4 || video.width < 2 || video.height < 2) return;

  const cols = 12, rows = 8;
  const cellValues = [];
  let total = 0;
  const stepX = max(1, floor(video.width / cols)), stepY = max(1, floor(video.height / rows));
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      let sum = 0, count = 0;
      const startX = gx * stepX, startY = gy * stepY;
      for (let y = startY; y < min(video.height, startY + stepY); y += 4) {
        for (let x = startX; x < min(video.width, startX + stepX); x += 4) {
          const i = 4 * (x + y * video.width);
          sum += video.pixels[i] * 0.2126 + video.pixels[i + 1] * 0.7152 + video.pixels[i + 2] * 0.0722;
          count++;
        }
      }
      const value = count ? sum / count : 0;
      cellValues.push({ gx, gy, value });
      total += value;
    }
  }
  const average = total / max(cellValues.length, 1);
  const threshold = 16;
  let weightTotal = 0, weightedX = 0, weightedY = 0, strongestExcess = 0;
  for (const cell of cellValues) {
    const excessBrightness = max(0, cell.value - average - threshold);
    const weight = pow(excessBrightness, 1.35);
    weightTotal += weight;
    weightedX += (cell.gx + 0.5) * weight;
    weightedY += (cell.gy + 0.5) * weight;
    strongestExcess = max(strongestExcess, excessBrightness);
  }

  // Overall light level is the true average brightness of the camera image.
  lightLevel = lerp(lightLevel, average / 255, 0.09);
  lightActivity = lerp(lightActivity, smoothCurve(0.14, 0.68, lightLevel), 0.09);
  const directionalConfidence = weightTotal > 0
    ? constrain((strongestExcess - 4) / 72, 0, 1)
    : 0;
  lightConfidence = lerp(lightConfidence, directionalConfidence, 0.11);
  cameraSampleCount++;

  if (weightTotal > 0 && directionalConfidence > 0.04) {
    const sourceX = weightedX / weightTotal / cols;
    const sourceY = weightedY / weightTotal / rows;
    // The front camera behaves like a selfie preview, so X is mirrored.
    const mappedX = width * (1 - sourceX);
    const mappedY = map(sourceY, 0, 1, height * 0.14, height * 0.72);
    lightTarget.x = lerp(lightTarget.x, mappedX, 0.13);
    lightTarget.y = lerp(lightTarget.y, mappedY, 0.13);
  }
}

function smoothCurve(edge0, edge1, value) {
  const t = constrain((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function updateBubbles(dt) {
  const f = dt * 60;
  for (const b of bubbles) {
    b.y -= b.speed * f;
    b.x += waterVel.x * 0.18 * f;
    if (vortexStrength > 0.04) {
      const dx = b.x - width * 0.5, dy = b.y - height * 0.47;
      b.x += -dy * vortexStrength * 0.0017 * vortexDirection * f;
      b.y += dx * vortexStrength * 0.0017 * vortexDirection * f;
    }
    if (b.y < -12) { b.y = height + random(10, 70); b.x = random(width); }
    if (b.x < -20) b.x = width + 20;
    if (b.x > width + 20) b.x = -20;
  }
}

function drawCameraBackdrop() {
  if (cameraFilterMix < 0.002 || !cameraReady || !cam || !cam.video) return;
  const video = cam.video;
  const vw = max(video.width || 0, 1), vh = max(video.height || 0, 1);
  const coverScale = max(width / vw, height / vh);
  const dw = vw * coverScale, dh = vh * coverScale;

  push();
  // Mirror the front camera so the filter behaves like a familiar selfie view.
  translate(width, 0);
  scale(-1, 1);
  imageMode(CORNER);
  tint(255);
  image(video, (width - dw) * 0.5, (height - dh) * 0.5, dw, dh);
  pop();
}

function drawBackground() {
  // In LIGHT mode the real camera sits beneath a translucent aquarium layer.
  // The same cam.video object continues to feed analyseCameraLight().
  background(nightMode ? color(6, 17, 39) : color(174, 225, 235));
  drawCameraBackdrop();
  const top = nightMode ? color(9, 22, 54) : color(199, 245, 249);
  const bottom = nightMode ? color(12, 47, 80) : color(49, 112, 153);
  // Keep enough colour to read as water, while letting the real scene remain
  // recognisable like an AR aquarium filter.
  const aquariumAlpha = lerp(255, nightMode ? 112 : 92, cameraFilterMix);
  for (let y = 0; y < height; y += 4) {
    const c = lerpColor(top, bottom, y / height);
    noStroke();
    fill(red(c), green(c), blue(c), aquariumAlpha);
    rect(0, y, width, 5);
  }
  noStroke();
  fill(45, 190, 216, 20 * cameraFilterMix);
  rect(0, 0, width, height);
  noStroke();
  for (let i = 0; i < 5; i++) {
    const rayAlpha = lerp(nightMode ? 5 : 12, nightMode ? 3 : 7, cameraFilterMix);
    fill(255, 255, 255, rayAlpha);
    const x = width * (0.04 + i * 0.24) + sin(frameCount * 0.006 + i) * 20;
    quad(x, 0, x + width * 0.08, 0, x + width * 0.20, height, x - width * 0.02, height);
  }
}

function drawWaterAndDecor() {
  const surfaceY = height * 0.105;
  const slope = constrain(waterTilt / 45, -1, 1) * height * 0.048;
  noFill(); stroke(255, 255, 255, nightMode ? 80 : 150); strokeWeight(2.5); beginShape();
  for (let x = -20; x <= width + 20; x += 18) vertex(x, surfaceY + map(x, 0, width, -slope, slope) + sin(x * 0.027 + frameCount * 0.025) * (2 + vortexStrength));
  endShape();
  const floorY = height * 0.84;
  noStroke(); fill(nightMode ? color(34, 55, 76, 220) : color(222, 207, 167, 220)); beginShape(); vertex(0, floorY);
  for (let x = 0; x <= width; x += 25) vertex(x, floorY + sin(x * 0.025) * 6);
  vertex(width, height); vertex(0, height); endShape(CLOSE);
  drawPlant(width * 0.10, floorY + 18, min(width, height) * 0.22, color(54, 142, 121, 205), 0.1);
  drawPlant(width * 0.18, floorY + 18, min(width, height) * 0.15, color(105, 170, 129, 185), 1.2);
  drawPlant(width * 0.88, floorY + 18, min(width, height) * 0.24, color(48, 130, 117, 205), 2.0);
  drawPlant(width * 0.80, floorY + 18, min(width, height) * 0.16, color(119, 177, 139, 180), 2.7);
  noStroke(); fill(nightMode ? color(62, 77, 92) : color(113, 143, 143));
  ellipse(width * 0.10, floorY + 22, width * 0.09, height * 0.032); ellipse(width * 0.88, floorY + 20, width * 0.10, height * 0.035);
  const cx = width * 0.72;
  stroke(nightMode ? color(144, 91, 128) : color(231, 139, 146)); strokeWeight(max(2, min(width, height) * 0.008));
  for (let i = -2; i <= 2; i++) line(cx, floorY + 20, cx + i * 12, floorY - 22 - abs(i) * 8);
}

function drawPlant(x, baseY, h, c, phase) {
  noFill(); stroke(c); strokeCap(ROUND); strokeWeight(max(4, h * 0.045));
  for (let stem = -1; stem <= 1; stem++) {
    beginShape();
    for (let j = 0; j <= 11; j++) {
      const t = j / 11;
      vertex(x + stem * 9 + sin(t * PI * 1.7 + frameCount * 0.018 + phase + stem) * h * 0.07 * t, baseY - h * t * (0.80 + (stem + 1) * 0.08));
    }
    endShape();
  }
}

function drawCurrents() {
  noFill(); strokeWeight(1.2);
  for (const c of currents) {
    if (vortexStrength > 0.08) {
      c.angle += vortexDirection * (0.004 + vortexStrength * 0.012);
      stroke(255, 255, 255, 20 + vortexStrength * 30);
      arc(width * 0.5, height * 0.47, c.radius * 2, c.radius * 1.45, c.angle - 0.3, c.angle + 0.12);
    } else {
      c.x += waterVel.x * 0.2 + 0.05; c.y += waterVel.y * 0.1;
      if (c.x > width + 50) c.x = -50; if (c.x < -50) c.x = width + 50; if (c.y > height) c.y = 0; if (c.y < 0) c.y = height;
      stroke(255, 255, 255, nightMode ? 12 : 23); line(c.x, c.y, c.x - c.len - waterVel.x * 3, c.y - waterVel.y * 2);
    }
  }
}

function drawBubbles() {
  noFill();
  for (const b of bubbles) { stroke(255, 255, 255, nightMode ? b.alpha * 0.55 : b.alpha); strokeWeight(1.1); circle(b.x, b.y, b.r * 2); }
}

function drawJellyfish() {
  push(); translate(jellyPos.x, jellyPos.y); rotate(spin);
  const s = constrain(min(width, height) * 0.23, 105, 180), beat = sin(pulse) * 0.035;
  scale(1 + beat, 1 - beat * 0.8); drawTentacles(s);
  drawingContext.shadowBlur = nightMode ? 42 : 28;
  drawingContext.shadowColor = nightMode ? "rgba(117,224,255,0.85)" : "rgba(244,173,226,0.55)";
  noStroke(); fill(nightMode ? color(121, 217, 242, 190) : color(242, 174, 223, 192)); beginShape();
  for (let a = PI; a <= TWO_PI; a += PI / 28) vertex(cos(a) * s * 0.54, sin(a) * s * 0.62 + s * 0.11);
  const rim = [[.46,.13],[.37,.18],[.28,.12],[.18,.19],[.07,.13],[-.04,.19],[-.15,.12],[-.27,.19],[-.38,.12],[-.47,.15]];
  for (const p of rim) vertex(s * p[0], s * p[1]); endShape(CLOSE); drawingContext.shadowBlur = 0;
  fill(255, 235, 250, 65); ellipse(0, -s * 0.13, s * 0.82, s * 0.68);
  noFill(); stroke(255, 250, 255, 105); strokeWeight(max(1.2, s * 0.01));
  for (let i = -3; i <= 3; i++) line(i * s * 0.032, -s * 0.43, i * s * 0.095, s * 0.08);
  noStroke();
  for (let i = -4; i <= 4; i++) { fill(nightMode ? color(181, 243, 255, 170) : color(255, 214, 241, 160)); ellipse(i * s * 0.105, s * (0.145 + (abs(i) % 2) * 0.018), s * 0.115, s * 0.07); }
  fill(255, 255, 255, 105); ellipse(-s * 0.11, -s * 0.34, s * 0.38, s * 0.12); drawFace(s); pop();
}

function drawTentacles(s) {
  noFill(); strokeCap(ROUND);
  for (let i = 0; i < 9; i++) {
    const x = map(i, 0, 8, -s * 0.42, s * 0.42), strandLength = s * (0.55 + (i % 4) * 0.08), trail = constrain(-jellyVel.x * 5, -s * 0.30, s * 0.30);
    stroke(i % 2 ? color(255, 225, 247, 175) : nightMode ? color(121, 222, 255, 180) : color(222, 134, 207, 170));
    strokeWeight(i % 3 === 0 ? 4.5 : 2.5); beginShape();
    for (let j = 0; j <= 15; j++) { const t = j / 15; vertex(x + sin(t * TWO_PI * 1.3 + pulse + i) * s * (0.03 + t * 0.025) + trail * t, s * 0.13 + strandLength * t); }
    endShape();
  }
}

function drawFace(s) {
  const surprised = state === VORTEX && vortexStrength > 0.55;
  noStroke(); fill(48, 45, 69, 230);
  ellipse(-s * 0.13, -s * 0.12, s * 0.038, surprised ? s * 0.065 : s * 0.05); ellipse(s * 0.13, -s * 0.12, s * 0.038, surprised ? s * 0.065 : s * 0.05);
  fill(255, 255, 255, 225); circle(-s * 0.138, -s * 0.135, s * 0.012); circle(s * 0.122, -s * 0.135, s * 0.012);
  fill(238, 117, 171, 65); ellipse(-s * 0.24, -s * 0.02, s * 0.12, s * 0.055); ellipse(s * 0.24, -s * 0.02, s * 0.12, s * 0.055);
  noFill(); stroke(48, 45, 69, 230); strokeWeight(max(2, s * 0.018)); strokeCap(ROUND);
  if (surprised) circle(0, s * 0.01, s * 0.075); else { arc(-s * 0.035, 0, s * 0.07, s * 0.07, 0, PI); arc(s * 0.035, 0, s * 0.07, s * 0.07, 0, PI); }
}

function drawGlass() {
  const frame = constrain(min(width, height) * 0.038, 16, 36);
  noFill(); stroke(7, 37, 57, 235); strokeWeight(frame); rect(frame * 0.52, frame * 0.52, width - frame * 1.04, height - frame * 1.04, frame * 0.8);
  stroke(112, 180, 192, 210); strokeWeight(max(3, frame * 0.18)); rect(frame * 0.56, frame * 0.56, width - frame * 1.12, height - frame * 1.12, frame * 0.65);
  stroke(230, 253, 255, 135); strokeWeight(max(1.4, frame * 0.07)); rect(frame * 0.73, frame * 0.73, width - frame * 1.46, height - frame * 1.46, frame * 0.5);
  noStroke(); fill(255, 255, 255, 22); quad(frame * 1.3, frame, frame * 2.2, frame, width * 0.26, height * 0.78, width * 0.20, height * 0.78);
}

function drawUI() {
  const compact = width < 500;
  noStroke(); fill(12, 34, 57, 155); rect(18, 18, compact ? 135 : 155, 48, 17);
  fill(255, 255, 255, 230); textSize(10); textStyle(BOLD); text("WATER STATE", 34, 37); textSize(compact ? 12 : 14); text(state, 34, 56); textStyle(NORMAL);
  drawButton(width - (compact ? 112 : 132), 18, compact ? 94 : 114, 44, nightMode ? "DAY MODE" : "NIGHT MODE", nightMode);

  const modeButtons = getModeButtonRects();
  drawButton(modeButtons[0].x, modeButtons[0].y, modeButtons[0].w, modeButtons[0].h, "FLOAT", interactionMode === MODE_TILT);
  drawButton(modeButtons[1].x, modeButtons[1].y, modeButtons[1].w, modeButtons[1].h, "SWIRL", interactionMode === MODE_SHAKE);
  drawButton(modeButtons[2].x, modeButtons[2].y, modeButtons[2].w, modeButtons[2].h, "FOLLOW LIGHT", interactionMode === MODE_LIGHT);

  const hardwareReady = orientationSampleCount > 2 && motionSampleCount > 2 && cameraSampleCount > 0;
  const statusY = height - 112;
  drawButton(18, statusY, compact ? 112 : 132, 38, hardwareReady ? "INPUTS: LIVE" : "WAITING", hardwareReady);
  fill(12, 34, 57, 145);
  rect(compact ? 138 : 158, statusY, width - (compact ? 156 : 176), 38, 15);
  fill(255, 255, 255, 225); textAlign(CENTER, CENTER); textSize(compact ? 9 : 11);
  let hint = orientationSampleCount > 2
    ? "Tilt " + nf(tiltY, 1, 0) + "° — water follows with delay"
    : "Waiting for phone orientation — use Safari / Chrome";
  if (interactionMode === MODE_SHAKE) {
    hint = motionSampleCount > 2
      ? "Shake energy " + nf(shakeEnergy, 1, 2) + " — shake the phone"
      : "Waiting for phone motion — allow sensor access";
  }
  if (interactionMode === MODE_LIGHT) {
    if (!cameraReady) hint = "Camera permission is needed for light sensing";
    else if (cameraSampleCount === 0) hint = "Starting hidden front-camera light sensor";
    else if (lightActivity < 0.10) hint = "Low camera light — resting";
    else if (lightActivity < 0.58) hint = "Light " + nf(lightLevel * 100, 1, 0) + "% — following bright region";
    else hint = "Strong light " + nf(lightLevel * 100, 1, 0) + "% — active phototaxis";
  }
  text(hint, (compact ? 138 : 158) + (width - (compact ? 156 : 176)) / 2, statusY + 19);
  textAlign(LEFT, BASELINE);
  drawSensorDebug();
}

function updateExplorationPrompts(dt) {
  // The opening toast appears at launch, then restarts once the permission
  // flow finishes so it cannot be missed behind a browser permission sheet.
  if (started && !explorationWasStarted && explorationStep === EXPLORE_FLOAT) {
    explorationPromptAge = 0;
    explorationPromptAlpha = 0;
  }
  explorationWasStarted = started;

  if (explorationStep === EXPLORE_COMPLETE) {
    explorationPromptAlpha = lerp(explorationPromptAlpha, 0, 1 - pow(0.01, dt));
    return;
  }

  explorationPromptAge += dt;
  let keepPromptVisible = explorationPromptAge < 5;

  if (explorationStep === EXPLORE_FLOAT) {
    const tiltAmount = sqrt(tiltX * tiltX + tiltY * tiltY);
    const activelyFloating = started && window.sensorsEnabled &&
      interactionMode === MODE_TILT && tiltAmount > 5;
    if (activelyFloating) {
      floatInteractionStarted = true;
      // Count real active tilt time. A pause or neutral phone adds nothing.
      floatProgress += dt;
    }
    keepPromptVisible = !floatInteractionStarted || explorationPromptAge < 5;
    if (floatProgress >= 7.5 && explorationPromptAge >= 5) {
      advanceExploration(EXPLORE_SWIRL);
      return;
    }
  } else if (explorationStep === EXPLORE_SWIRL) {
    const activelySwirling = started && window.sensorsEnabled &&
      interactionMode === MODE_SHAKE && (shakeEnergy > 0.12 || vortexStrength > 0.28);
    if (activelySwirling) {
      swirlInteractionStarted = true;
      // Count only frames in which the real shake or resulting vortex is active.
      swirlProgress += dt;
    }
    keepPromptVisible = !swirlInteractionStarted || explorationPromptAge < 5;
    if (swirlProgress >= 3.0) {
      advanceExploration(EXPLORE_LIGHT);
      return;
    }
  } else if (explorationStep === EXPLORE_LIGHT) {
    const activelyFollowingLight = cameraReady && interactionMode === MODE_LIGHT &&
      state === LIGHT && lightActivity > 0.10 && lightConfidence > 0.08;
    if (activelyFollowingLight) {
      lightInteractionStarted = true;
      // Count only camera frames that are producing directional phototaxis.
      lightProgress += dt;
    }
    keepPromptVisible = !lightInteractionStarted || explorationPromptAge < 5;
    if (lightProgress >= 4.0) {
      advanceExploration(EXPLORE_COMPLETE);
      return;
    }
  }

  const visibleTarget = keepPromptVisible ? 245 : 0;
  explorationPromptAlpha = lerp(explorationPromptAlpha, visibleTarget, 1 - pow(0.008, dt));
}

function advanceExploration(nextStep) {
  explorationStep = nextStep;
  explorationPromptAge = 0;
  explorationPromptAlpha = 0;
}

function drawExplorationPrompt() {
  if (explorationStep === EXPLORE_COMPLETE || explorationPromptAlpha < 1) return;
  const prompts = [
    "Try floating Luma around by\ntilting your phone!",
    "Nice! Now try making\nLuma swirl!",
    "Great! Now see what happens\nwhen Luma finds light!"
  ];
  const message = prompts[explorationStep];
  const compact = width < 500;
  const y = constrain(height * 0.28, 125, height * 0.38);
  const toastWidth = constrain(width * 0.72, 230, 430);
  const toastHeight = 58;

  push();
  textAlign(CENTER, CENTER);
  textStyle(BOLD);
  textSize(compact ? 13 : 15);
  textLeading(compact ? 17 : 20);
  noStroke();
  fill(8, 30, 52, explorationPromptAlpha * 0.92);
  rect(width / 2 - toastWidth / 2, y - toastHeight / 2, toastWidth, toastHeight, toastHeight / 2);
  stroke(151, 231, 239, explorationPromptAlpha * 0.7);
  strokeWeight(1.5);
  noFill();
  rect(width / 2 - toastWidth / 2, y - toastHeight / 2, toastWidth, toastHeight, toastHeight / 2);
  noStroke();
  fill(255, 255, 255, explorationPromptAlpha);
  text(message, width / 2, y);
  pop();
}

function getModeButtonRects() {
  const pad = 18;
  const gap = 6;
  const y = height - 63;
  const w = (width - pad * 2 - gap * 2) / 3;
  return [
    { x: pad, y, w, h: 41, mode: MODE_TILT },
    { x: pad + w + gap, y, w, h: 41, mode: MODE_SHAKE },
    { x: pad + (w + gap) * 2, y, w, h: 41, mode: MODE_LIGHT }
  ];
}

function drawSensorDebug() {
  const x = 18, y = 76, w = width < 500 ? 158 : 184, h = 103;
  noStroke(); fill(7, 24, 43, 125); rect(x, y, w, h, 12);
  fill(255, 255, 255, 215); textAlign(LEFT, TOP); textStyle(NORMAL); textSize(width < 500 ? 8.5 : 10);
  const lines = [
    "Sensors: " + (window.sensorsEnabled ? "ON" : "OFF"),
    "Camera: " + (cameraReady ? "ON" : "OFF"),
    "Tilt: " + nf(tiltY, 1, 1) + "°",
    "Shake: " + nf(shakeEnergy, 1, 2),
    "Camera brightness: " + nf(lightLevel * 100, 1, 0) + "%",
    "Light X: " + nf(lightPos.x, 1, 0),
    "Light Y: " + nf(lightPos.y, 1, 0),
    "Light confidence: " + nf(lightConfidence, 1, 2)
  ];
  for (let i = 0; i < lines.length; i++) text(lines[i], x + 11, y + 8 + i * 11.5);
  textAlign(LEFT, BASELINE);
}

function drawButton(x, y, w, h, label, active) {
  noStroke(); fill(active ? color(94, 197, 208, 205) : color(12, 34, 57, 155)); rect(x, y, w, h, 16);
  fill(255, 255, 255, 235); textAlign(CENTER, CENTER); textStyle(BOLD); textSize(width < 500 ? 10 : 11); text(label, x + w / 2, y + h / 2); textStyle(NORMAL); textAlign(LEFT, BASELINE);
}

function drawPermissionHint() {
  noStroke(); fill(5, 17, 35, 115); rect(0, 0, width, height);
  fill(255, 255, 255, 220); textAlign(CENTER, CENTER); textStyle(BOLD);
  textSize(min(18, width * 0.044)); text("Tap Enable Sensors & Camera", width / 2, height * 0.73);
  textStyle(NORMAL); textAlign(LEFT, BASELINE);
}

function handlePress() {
  if (millis() - lastPressAt < 220) return false;
  lastPressAt = millis();
  const point = getCanvasPressPoint();
  if (!point) return false;
  const compact = width < 500;
  const nightRect = { x: width - (compact ? 112 : 132), y: 18, w: compact ? 94 : 114, h: 44 };
  if (pointInRect(point, nightRect)) {
    nightMode = !nightMode;
    return false;
  }
  for (const button of getModeButtonRects()) {
    if (pointInRect(point, button)) {
      setInteractionMode(button.mode);
      return false;
    }
  }
  return false;
}

function getCanvasPressPoint() {
  // p5 touch coordinates are already expressed in logical canvas pixels, so
  // they stay correct when Retina pixelDensity is 2 or 3.
  if (Array.isArray(touches) && touches.length > 0) {
    const t = touches[0];
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
      return { x: t.x, y: t.y };
    }
  }
  if (Number.isFinite(mouseX) && Number.isFinite(mouseY)) {
    return { x: mouseX, y: mouseY };
  }
  return null;
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

function setInteractionMode(nextMode) {
  interactionMode = nextMode;
  vortexStrength = 0;
  spinSpeed *= 0.25;
  waterVel.mult(0.35);
  if (nextMode === MODE_LIGHT) {
    lightPos.set(width * 0.5, height * 0.28);
  }
}

// Mobile Safari does not always synthesize a mouse press for a canvas touch.
// Handle the real p5 touch event and return false so the browser cannot turn
// the gesture into scrolling, zooming, or selection. The existing debounce in
// handlePress() suppresses the later synthetic mouse event on other browsers.
function touchStarted() { return handlePress(); }
function mousePressed() { return handlePress(); }
function deviceShaken() {
  if (window.sensorsEnabled && interactionMode === MODE_SHAKE) {
    triggerVortex(constrain(0.45 + shakeEnergy * 0.85, 0.45, 1.35));
  }
}

function windowResized() {
  const oldW = width, oldH = height;
  const viewport = getViewportCanvasSize();
  resizeCanvas(viewport.w, viewport.h);
  jellyPos.set(jellyPos.x / max(oldW, 1) * width, jellyPos.y / max(oldH, 1) * height);
  homePos.set(width * 0.5, height * 0.45);
  lightPos.set(width * 0.5, height * 0.35);
}
