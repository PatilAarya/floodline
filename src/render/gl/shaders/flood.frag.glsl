#version 300 es
// Terrain and water in one full-screen pass.
//   terrain: hillshade from the bed texture, elevation tint, contour lines
//   water:   depth ramp background -> secondary -> accent -> primary (OKLab),
//            depth-based opacity, flow streaks from the discharge field,
//            shoreline foam, soft caustics, rain streaks in screen space.
// All colours arrive as OKLab uniforms derived from the five CSS tokens.
precision highp float;

uniform sampler2D uBed;
uniform sampler2D uDepthA;
uniform sampler2D uDepthB;
uniform sampler2D uFlow;

uniform vec2 uView;      // viewport, CSS px
uniform float uRatio;    // device px per CSS px for this canvas
uniform vec2 uCenter;    // world centre of the view, metres
uniform float uScale;    // CSS px per metre
uniform float uSize;     // world side, metres
uniform float uTexel;    // 1 / grid size
uniform vec2 uRange;     // min / max bed height
uniform float uMix;      // 0..1 between depth frames A and B
uniform float uTime;     // seconds
uniform float uRain;     // 0..1 rain intensity for streaks
uniform float uMotion;   // 0 with reduced motion
uniform float uShowTerrain;
uniform float uShowWater;
uniform float uShowContours;

uniform vec3 uText;
uniform vec3 uBg;
uniform vec3 uPri;
uniform vec3 uSec;
uniform vec3 uAcc;

out vec4 outColor;

vec3 oklabToSrgb(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  vec3 lin = vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  lin = clamp(lin, 0.0, 1.0);
  vec3 lo = lin * 12.92;
  vec3 hi = 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), lin));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uView.y * uRatio - gl_FragCoord.y) / uRatio;
  vec2 world = (css - uView * 0.5) / uScale + uCenter;
  vec2 uv = world / uSize;
  vec3 col = uBg;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    outColor = vec4(oklabToSrgb(col), 1.0);
    return;
  }

  // ── Terrain ──
  float h = texture(uBed, uv).r;
  if (uShowTerrain > 0.5) {
    float e = clamp((h - uRange.x) / max(1.0, uRange.y - uRange.x), 0.0, 1.0);
    float hl = texture(uBed, uv - vec2(uTexel, 0.0)).r;
    float hr = texture(uBed, uv + vec2(uTexel, 0.0)).r;
    float hu = texture(uBed, uv - vec2(0.0, uTexel)).r;
    float hd = texture(uBed, uv + vec2(0.0, uTexel)).r;
    float cell = uSize * uTexel;
    // Strong vertical exaggeration: Mumbai is flat, relief must still read.
    float exag = 6.0;
    vec3 nrm = normalize(vec3(-(hr - hl) / (2.0 * cell) * exag, -(hd - hu) / (2.0 * cell) * exag, 1.0));
    vec3 light = normalize(vec3(-0.55, -0.55, 0.62)); // from the north-west
    float shade = clamp(dot(nrm, light), 0.0, 1.0);
    vec3 base = mix(uBg, uSec, 0.08 + 0.5 * pow(e, 0.6));
    float flat0 = 0.72;
    col = shade < flat0 ? mix(base, uText, (flat0 - shade) * 0.45) : mix(base, uBg, (shade - flat0) * 1.5);
  }
  if (uShowContours > 0.5) {
    float c = h / 2.0;
    float w = fwidth(c);
    float line = 1.0 - smoothstep(0.0, w * 1.1, abs(fract(c - 0.5) - 0.5));
    float major = 1.0 - smoothstep(0.0, w * 1.4, abs(fract(h / 10.0 - 0.5) - 0.5) * 5.0);
    col = mix(col, uText, line * 0.07 + major * 0.1);
  }

  // ── Water ──
  if (uShowWater > 0.5) {
    float d = mix(texture(uDepthA, uv).r, texture(uDepthB, uv).r, uMix);
    if (d > 0.008) {
      float t1 = smoothstep(0.0, 0.35, d);
      float t2 = smoothstep(0.25, 1.4, d);
      float t3 = smoothstep(1.1, 4.0, d);
      vec3 shallow = mix(uBg, uSec, 0.55);
      vec3 deep = mix(uPri, uText, 0.28);
      vec3 wc = mix(shallow, uSec, t1);
      wc = mix(wc, mix(uAcc, uPri, 0.35), t2);
      wc = mix(wc, deep, t3);

      // Flow streaks: bands that move along the local flow direction.
      vec2 q = texture(uFlow, uv).rg;
      vec2 vel = q / max(d, 0.08);
      float speed = length(vel);
      if (speed > 0.02) {
        vec2 dir = vel / speed;
        float along = dot(world, dir);
        float across = dot(world, vec2(-dir.y, dir.x));
        float phase = along / 22.0 - uTime * clamp(speed, 0.0, 2.5) * 0.9 * uMotion;
        float band = pow(0.5 + 0.5 * sin(phase * 6.2831), 10.0);
        float breakup = smoothstep(0.35, 0.9, hash(floor(vec2(across / 9.0, along / 60.0))));
        float k = band * breakup * smoothstep(0.03, 0.5, speed) * t1;
        wc = mix(wc, uBg, k * 0.42);
      }

      // Soft caustic shimmer in deeper water.
      float ca = sin(world.x * 0.045 + uTime * 0.7 * uMotion) * sin(world.y * 0.051 - uTime * 0.9 * uMotion)
               + sin((world.x + world.y) * 0.031 + uTime * 0.5 * uMotion);
      wc = mix(wc, uBg, smoothstep(1.2, 1.9, ca) * 0.12 * t2);

      // Shoreline foam: a light rim where water is very shallow.
      float foam = smoothstep(0.008, 0.03, d) * (1.0 - smoothstep(0.03, 0.12, d));
      wc = mix(wc, uBg, foam * 0.55);

      float alpha = smoothstep(0.008, 0.1, d) * (0.78 + 0.2 * t2);
      col = mix(col, wc, alpha);
    }
  }

  // ── Rain streaks (screen space, decorative) ──
  if (uRain > 0.01 && uMotion > 0.5) {
    vec2 r = vec2(css.x + css.y * 0.22, css.y);
    vec2 cellId = floor(r / vec2(7.0, 70.0));
    float hr = hash(cellId);
    float y = fract(r.y / 70.0 - uTime * (2.2 + hr) + hr * 7.0);
    float x = abs(fract(r.x / 7.0) - 0.5) * 2.0;
    float streak = step(hr, uRain * 0.45) * smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.08, 0.3, y)) * (1.0 - smoothstep(0.08, 0.3, x));
    col = mix(col, uText, streak * 0.14);
  }

  outColor = vec4(oklabToSrgb(col), 1.0);
}
