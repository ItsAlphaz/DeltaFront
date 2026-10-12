#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;
uniform vec2 uBoundsMin; // first tile of the corridor's bounding box
uniform vec2 uBoundsMax; // last tile of the box (inclusive)

out vec2 vWorld; // world-space position (tile coords, tile centres at +0.5)

void main() {
  vec2 worldPos = mix(uBoundsMin, uBoundsMax + 1.0, aPos);
  vWorld = worldPos;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
