#version 100
precision mediump float;

// Rotating spinner: a ring with a comet tail, transparent background.
// Used as the fill of a small square node inside the loading button.
// Note: smoothstep is undefined when edge0 > edge1, so the outer edge is
// written as 1.0 - smoothstep(lo, hi, r).

/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Color
 * @color
 * @default #FFFFFF
 */
uniform vec3 u_color;

/**
 * @label Speed
 * @default 0.85
 * @range 0.1, 3.0
 */
uniform float u_speed;

/**
 * @label Thickness
 * @default 0.17
 * @range 0.05, 0.4
 */
uniform float u_thickness;

void main() {
    vec2 uv = (gl_FragCoord.xy / u_resolution.xy - 0.5) * 2.0;
    float r = length(uv);

    float outerEdge = 0.92;
    float innerEdge = outerEdge - u_thickness * 2.0;
    float aa = 0.07;

    float outer = 1.0 - smoothstep(outerEdge - aa, outerEdge + aa, r);
    float inner = smoothstep(innerEdge - aa, innerEdge + aa, r);
    float ring = outer * inner;

    // tail fades along the circumference and rotates over time
    float a = atan(uv.y, uv.x) / 6.2831853;
    float sweep = fract(a + u_time * u_speed);
    float tail = 0.12 + 0.88 * sweep * sweep;

    gl_FragColor = vec4(u_color, ring * tail);
}
