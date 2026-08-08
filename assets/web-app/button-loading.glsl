#version 100
precision mediump float;

// Animated fill for the primary button in its loading state: brand orange with
// a soft diagonal light band sweeping across it.

/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Base Color
 * @color
 * @default #F7941D
 */
uniform vec3 u_base;

/**
 * @label Sweep Speed
 * @default 0.38
 * @range 0.05, 1.5
 */
uniform float u_speed;

/**
 * @label Sweep Intensity
 * @default 0.18
 * @range 0.0, 0.6
 */
uniform float u_intensity;

void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution.xy;

    // band travels from just off the left edge to just off the right edge
    float center = fract(u_time * u_speed) * 1.7 - 0.35;
    float d = (uv.x + uv.y * 0.18 - center) * 5.5;
    float band = exp(-d * d);

    vec3 col = u_base + vec3(1.0) * band * u_intensity;
    gl_FragColor = vec4(col, 1.0);
}
