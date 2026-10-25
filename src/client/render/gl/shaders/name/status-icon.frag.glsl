#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2D uStatusAtlas;
uniform sampler2DArray uCrownAtlas; // crown-cosmetic images (skins slot 0)
uniform vec2 uStatusTexel;     // 1/atlasW, 1/atlasH
uniform float uStatusOutlinePx; // outline radius in atlas texels (0 = off)

in vec2 vUV;
in vec2 vLocalUV;
flat in int vCrownLayer;
flat in int vDiscard;
flat in float vAllianceFraction;
flat in vec2 vFadedUV0;
flat in vec2 vFadedUV1;
flat in float vFlashAlpha;
flat in float vOutline;          // 1.0 = draw a dark outline behind this icon
flat in float vDecay;            // 1.0 = tint this icon red (decaying skull)
in float vHoverAlpha;

out vec4 fragColor;

// 8 unit directions for the outline dilation sample ring.
const vec2 kRing[8] = vec2[8](
  vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(0.707, 0.707), vec2(-0.707, 0.707),
  vec2(0.707, -0.707), vec2(-0.707, -0.707)
);

// The crown cosmetic at a position in its quad, transparent outside the
// artwork (the quad is larger than the image to leave room for the shadow).
vec4 crownTexel(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uCrownAtlas, vec3(uv, float(vCrownLayer)));
}

void main() {
  if (vDiscard != 0) discard;

  // A crown cosmetic replaces the default first-place crown icon. Only slot 0
  // ever carries a layer, and its quad has no outline margin, so vLocalUV is
  // plain [0,1] over the icon.
  vec4 texel;
  float shadow = 0.0;
  if (vCrownLayer >= 0) {
    texel = crownTexel(vLocalUV);
    // A subtle soft shadow under the crown so it stays readable on any
    // territory colour: the artwork's alpha, blurred and nudged downwards.
    vec2 from = vLocalUV - vec2(0.0, 0.02);
    float blur = crownTexel(from).a;
    for (int i = 0; i < 8; i++) {
      blur += crownTexel(from + kRing[i] * 0.035).a;
    }
    shadow = blur / 9.0 * 0.42;
  } else {
    texel = texture(uStatusAtlas, vUV);
  }

  // Alliance drain: composite faded icon behind colored icon, clipped by fraction.
  // Matches the game's CSS clip-path: inset(topCut% -2px 0 -2px) behavior.
  if (vAllianceFraction > 0.0) {
    // Game formula: topCut = 20 + (1-fraction) * 80 * 0.78  (% → 0..1)
    float topCut = 0.20 + (1.0 - vAllianceFraction) * 0.624;

    // Sample faded icon at corresponding local position
    vec2 fadedUV = mix(vFadedUV0, vFadedUV1, vLocalUV);
    vec4 fadedTexel = texture(uStatusAtlas, fadedUV);

    // Above the cut line → show faded; below → show colored
    texel = vLocalUV.y < topCut ? fadedTexel : texel;
  }

  // Decaying skull: tint red, keeping some luminance so its shading still reads.
  if (vDecay > 0.5) {
    float lum = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
    texel.rgb = vec3(0.90, 0.10, 0.10) * (0.55 + 0.45 * lum);
  }

  // Traitor flash + hover fade: modulate alpha
  float fade = vFlashAlpha * vHoverAlpha;
  texel.a *= fade;

  // Lay the crown over its shadow.
  if (vCrownLayer >= 0) {
    float shadowA = shadow * fade * (1.0 - texel.a);
    float outA = texel.a + shadowA;
    if (outA < 0.01) discard;
    fragColor = vec4(texel.rgb * texel.a / outA, outA);
    return;
  }

  // Dark outline: dilate the icon's alpha so it stays legible over terrain of a
  // similar color (the green alliance icon vs. irradiated land). Sampling the
  // padded atlas cell never reaches a neighbouring icon.
  if (vOutline > 0.5 && uStatusOutlinePx > 0.0) {
    float ring = 0.0;
    vec2 sampleStep = uStatusTexel * uStatusOutlinePx;
    for (int i = 0; i < 8; i++) {
      ring = max(ring, texture(uStatusAtlas, vUV + kRing[i] * sampleStep).a);
    }
    ring *= fade;
    float outlineA = ring * (1.0 - texel.a);
    texel = vec4(mix(vec3(0.0), texel.rgb, texel.a), max(texel.a, outlineA));
  }

  if (texel.a < 0.01) discard;
  fragColor = texel;
}
