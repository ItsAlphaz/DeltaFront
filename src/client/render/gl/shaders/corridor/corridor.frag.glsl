#version 300 es
precision highp float;

in vec2 vWorld;

uniform vec2 uOrigin;     // the airport's tile (the corridor's origin)
uniform vec2 uDir;        // unit flight direction
uniform vec2 uAlong;      // along-track window: x = start, y = end (tiles from the origin)
uniform float uHalfWidth; // corridor half-width (tiles)
uniform float uSegments;  // damage bursts the corridor is split into
uniform vec3 uColor;

out vec4 fragColor;

// Mirrors the simulation (engine-lib airstrike geometry): a tile is in the
// corridor when its along-track distance lies in the window and its distance
// from the centreline is at most the half-width. Tested per whole tile, so the
// preview shows the exact tiles that will be hit.
void main() {
  vec2 p = floor(vWorld) - uOrigin;
  float s = p.x * uDir.x + p.y * uDir.y;
  float perp = abs(p.x * uDir.y - p.y * uDir.x);
  if (s < uAlong.x || s > uAlong.y || perp > uHalfWidth) discard;

  float len = max(uAlong.y - uAlong.x, 1e-4);
  float seg = min(floor((s - uAlong.x) / len * uSegments), uSegments - 1.0);
  // Alternate the burst segments so the four bursts can be told apart.
  float alpha = mod(seg, 2.0) < 0.5 ? 0.12 : 0.22;

  // A brighter edge along the corridor's sides.
  float edge = step(uHalfWidth - 0.01, perp);
  alpha += edge * 0.18;

  fragColor = vec4(uColor, alpha);
}
