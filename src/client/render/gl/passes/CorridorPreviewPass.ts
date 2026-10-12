/**
 * CorridorPreviewPass — shows the damage corridor of a Strafing Run while the
 * player is aiming it: the exact tiles along the flight line that will be hit,
 * shaded in alternating segments (one per burst). White when the strike can be
 * launched, red when it cannot.
 *
 * One quad over the corridor's bounding box; the fragment shader repeats the
 * simulation's per-tile corridor test (engine-lib airstrike geometry).
 * Active only when the ghost preview carries a corridor.
 */

import type { CorridorPreview, GhostPreviewData } from "../../types";
import { createProgram } from "../utils/GlUtils";

import fragSrc from "../shaders/corridor/corridor.frag.glsl?raw";
import vertSrc from "../shaders/corridor/corridor.vert.glsl?raw";

const COLOR_OK: [number, number, number] = [1, 1, 1];
const COLOR_BLOCKED: [number, number, number] = [1, 0.2, 0.2];

export class CorridorPreviewPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;

  private uCamera: WebGLUniformLocation;
  private uBoundsMin: WebGLUniformLocation;
  private uBoundsMax: WebGLUniformLocation;
  private uOrigin: WebGLUniformLocation;
  private uDir: WebGLUniformLocation;
  private uAlong: WebGLUniformLocation;
  private uHalfWidth: WebGLUniformLocation;
  private uSegments: WebGLUniformLocation;
  private uColor: WebGLUniformLocation;

  private corridor: CorridorPreview | null = null;
  private blocked = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertSrc, fragSrc, "CorridorPreviewPass");
    const u = (name: string) => gl.getUniformLocation(this.program, name)!;
    this.uCamera = u("uCamera");
    this.uBoundsMin = u("uBoundsMin");
    this.uBoundsMax = u("uBoundsMax");
    this.uOrigin = u("uOrigin");
    this.uDir = u("uDir");
    this.uAlong = u("uAlong");
    this.uHalfWidth = u("uHalfWidth");
    this.uSegments = u("uSegments");
    this.uColor = u("uColor");

    // Unit quad [0,1]
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.corridor = data?.corridor ?? null;
    this.blocked = data?.rangeWarning ?? false;
  }

  draw(cameraMatrix: Float32Array): void {
    const c = this.corridor;
    if (c === null) return;

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform2f(this.uBoundsMin, c.x0, c.y0);
    gl.uniform2f(this.uBoundsMax, c.x1, c.y1);
    gl.uniform2f(this.uOrigin, c.sx, c.sy);
    gl.uniform2f(this.uDir, c.ux, c.uy);
    gl.uniform2f(this.uAlong, c.sStart, c.sEnd);
    gl.uniform1f(this.uHalfWidth, c.halfWidth);
    gl.uniform1f(this.uSegments, c.segments);
    const color = this.blocked ? COLOR_BLOCKED : COLOR_OK;
    gl.uniform3f(this.uColor, color[0], color[1], color[2]);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
