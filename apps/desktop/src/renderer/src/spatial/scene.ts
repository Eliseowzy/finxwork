import {
  ArrowHelper,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { decodeMesh, type Finding, type FindingSource, type MeshInput, type PartInfo, type SlicePlane } from "./model";

// The three.js side of the spatial view (spatial-design §4.2): the parts, an orbiting camera,
// a clipping plane, the corner axes, findings with rings that keep their size on screen, and
// the current slice. Loaded only when a model opens (SpatialView imports it), so three.js stays
// out of the app's first load. Renders only when something changed.

export type ViewName = "front" | "side" | "top" | "reset";
export type Axis = 0 | 1 | 2;

type Part = { id: number; name: string; mesh: Mesh; material: MeshStandardMaterial; visible: boolean; opacity: number; size: [number, number, number] };

export type ViewerEvents = {
  parts: (parts: PartInfo[]) => void;
  select: (part: PartInfo | null) => void;
  hover: (name: string | null) => void;
};

const canvasColor = 0x16181d;
const palette = [0xc9cdd6, 0x6aa7ff, 0xf29c6b, 0x7fd1a8, 0xd59cf0, 0xf2d06b, 0x7fc8d6, 0xe8838f];
const sourceColor: Record<FindingSource, string> = { reference: "#5fb3ff", ai: "#ffb547", user: "#ff6b81" };
/** A ring's height on screen, as a share of the view's height. */
const ringSize = 0.07;

const extension = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export class Viewer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(40, 1, 0.1, 1000);
  private controls: OrbitControls;
  private model = new Group();
  private extras = new Group();
  private findingsGroup = new Group();
  private sliceGroup = new Group();
  private parts: Part[] = [];
  private bounds = new Box3();
  /** File units to millimetres: glTF is in metres. */
  private unit = 1;
  private clip = new Plane(new Vector3(-1, 0, 0), 0);
  private clipOn = false;
  private hovered: Part | null = null;
  private selected: Part | null = null;
  private raycaster = new Raycaster();
  private gizmo = new Scene();
  private gizmoCamera = new OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
  private textures = new Map<string, Texture>();
  private dirty = true;
  private frame = 0;
  private resize: ResizeObserver;
  private down: { x: number; y: number } | null = null;
  private pointer: Vector2 | null = null;

  private host: HTMLElement;
  private events: ViewerEvents;

  constructor(host: HTMLElement, events: ViewerEvents) {
    this.host = host;
    this.events = events;
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(canvasColor);
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;
    host.appendChild(this.renderer.domElement);

    this.scene.add(new HemisphereLight(0xffffff, 0x30343c, 1.4));
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(0.5, 0.8, 1);
    this.camera.add(key);
    this.scene.add(this.camera, this.model, this.extras);
    this.extras.add(this.findingsGroup, this.sliceGroup);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.invalidate());
    this.buildGizmo();

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerleave", this.onLeave);
    this.resize = new ResizeObserver(() => this.fitCanvas());
    this.resize.observe(host);
    this.fitCanvas();
    this.loop();
  }

  // ── loading ──

  /** A model file's bytes, by its name's extension. */
  async loadFile(name: string, bytes: ArrayBuffer) {
    const ext = extension(name);
    const base = name.replace(/\.[^.]+$/, "");
    this.unit = ext === "glb" || ext === "gltf" ? 1000 : 1;
    if (ext === "stl") {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const g = new STLLoader().parse(bytes);
      // Many STL writers leave the facet normals zero: the faces' own are worked out instead.
      g.deleteAttribute("normal");
      this.addGeometry(base, g);
    } else if (ext === "ply") {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      this.addGeometry(base, new PLYLoader().parse(bytes));
    } else if (ext === "obj") {
      const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
      this.addObject(new OBJLoader().parse(new TextDecoder().decode(bytes)), base);
    } else if (ext === "glb" || ext === "gltf") {
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const gltf = await new GLTFLoader().parseAsync(bytes, "");
      this.addObject(gltf.scene, base);
    } else throw new Error(`not a model: ${name}`);
    this.settle();
  }

  /** Meshes in the kernel's format (model.ts), each a part. */
  setMeshes(meshes: MeshInput[]) {
    for (const m of meshes) {
      const { positions, indices } = decodeMesh(m.data);
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(positions, 3));
      g.setIndex(new BufferAttribute(indices, 1));
      const part = this.addGeometry(m.name, g, m.color);
      if (m.opacity !== undefined) part.opacity = Math.max(0, Math.min(1, m.opacity));
    }
    this.settle();
  }

  private addGeometry(name: string, g: BufferGeometry, color?: string | number) {
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const mesh = new Mesh(g);
    mesh.name = name;
    this.model.add(mesh);
    return this.adopt(mesh, name, color);
  }

  private addObject(root: Object3D, fallback: string) {
    this.model.add(root);
    root.updateMatrixWorld(true);
    const meshes: Mesh[] = [];
    root.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
    for (const m of meshes) {
      if (!m.geometry.getAttribute("normal")) m.geometry.computeVertexNormals();
      const own = Array.isArray(m.material) ? m.material[0] : m.material;
      const c = (own as { color?: Color } | undefined)?.color;
      // A glTF node's own name, else its parent's (a mesh under a named node), else a number.
      const name = m.name || m.parent?.name || (own as { name?: string } | undefined)?.name || `${fallback} ${this.parts.length + 1}`;
      this.adopt(m, name, c ? c.getHex() : undefined, (own as { map?: Texture | null } | undefined)?.map ?? null);
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) if (x !== own) x.dispose();
      own?.dispose();
    }
  }

  private adopt(mesh: Mesh, name: string, color?: string | number, map: Texture | null = null): Part {
    const id = this.parts.length;
    const material = new MeshStandardMaterial({
      color: color ?? palette[id % palette.length],
      map,
      vertexColors: !!mesh.geometry.getAttribute("color"),
      metalness: 0.05,
      roughness: 0.65,
      side: DoubleSide,
    });
    mesh.material = material;
    const part: Part = { id, name, mesh, material, visible: true, opacity: 1, size: [0, 0, 0] };
    this.parts.push(part);
    return part;
  }

  /** After a load: sizes, the camera on the whole, the list to the page. */
  private settle() {
    this.model.updateMatrixWorld(true);
    this.bounds.setFromObject(this.model);
    for (const p of this.parts) {
      const s = new Box3().setFromObject(p.mesh).getSize(new Vector3()).multiplyScalar(this.unit);
      p.size = [s.x, s.y, s.z];
    }
    this.applyClip();
    this.restyle();
    this.view("reset");
    this.events.parts(this.info());
  }

  // ── parts ──

  private info(): PartInfo[] {
    return this.parts.map(this.partInfo);
  }

  private partInfo = (p: Part): PartInfo => ({ id: p.id, name: p.name, visible: p.visible, opacity: p.opacity, size: p.size });

  setVisible(id: number, visible: boolean) {
    const p = this.parts[id];
    if (!p) return;
    p.visible = visible;
    if (!visible && this.selected === p) this.select(null);
    this.restyle();
    this.events.parts(this.info());
  }

  setOpacity(id: number, opacity: number) {
    const p = this.parts[id];
    if (!p) return;
    p.opacity = Math.max(0, Math.min(1, opacity));
    this.restyle();
    this.events.parts(this.info());
  }

  select(id: number | null) {
    this.selected = id === null ? null : (this.parts[id] ?? null);
    this.restyle();
    this.events.select(this.selected ? this.partInfo(this.selected) : null);
  }

  /** Colours and transparency: the hovered part lit, the others faint while one is selected. */
  private restyle() {
    for (const p of this.parts) {
      const faint = this.selected && this.selected !== p;
      const o = p.opacity * (faint ? 0.15 : 1);
      p.mesh.visible = p.visible && p.opacity > 0;
      p.material.opacity = o;
      p.material.transparent = o < 1;
      p.material.depthWrite = o >= 1;
      p.material.emissive.setHex(p === this.selected ? 0x1d3a66 : p === this.hovered ? 0x2a2f38 : 0x000000);
      p.mesh.renderOrder = o < 1 ? 1 : 0;
    }
    this.invalidate();
  }

  // ── camera ──

  view(name: ViewName) {
    const c = this.bounds.isEmpty() ? new Vector3() : this.bounds.getCenter(new Vector3());
    const r = this.bounds.isEmpty() ? 1 : Math.max(this.bounds.getSize(new Vector3()).length() / 2, 1e-6);
    const d = r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.15;
    const dir = name === "front" ? new Vector3(0, 0, 1) : name === "side" ? new Vector3(1, 0, 0) : name === "top" ? new Vector3(0, 1, 0.0001) : new Vector3(0.9, 0.6, 1.2);
    this.camera.near = d / 100;
    this.camera.far = d * 100;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(c).addScaledVector(dir.normalize(), d);
    this.controls.target.copy(c);
    this.controls.update();
    this.invalidate();
  }

  // ── clipping ──

  /** Cuts away what is past `t` (0–1) of the model's extent along `axis`; null: no cut. */
  setClip(axis: Axis, t: number | null) {
    this.clipOn = t !== null && !this.bounds.isEmpty();
    if (this.clipOn) {
      const lo = this.bounds.min.getComponent(axis);
      const hi = this.bounds.max.getComponent(axis);
      const n = new Vector3();
      n.setComponent(axis, -1);
      this.clip.set(n, lo + (hi - lo) * t!);
    }
    this.applyClip();
    this.invalidate();
  }

  private applyClip() {
    for (const p of this.parts) p.material.clippingPlanes = this.clipOn ? [this.clip] : [];
  }

  // ── findings and the slice ──

  setFindings(findings: readonly Finding[]) {
    this.clearGroup(this.findingsGroup);
    for (const f of findings) {
      const at = new Vector3(...f.position).divideScalar(this.unit);
      const color = sourceColor[f.source];
      if (f.radius > 0) {
        const ball = new Mesh(new SphereGeometry(f.radius / this.unit, 24, 16), new MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
        ball.position.copy(at);
        ball.renderOrder = 2;
        this.findingsGroup.add(ball);
      }
      const ring = new Sprite(new SpriteMaterial({ map: this.marker(f.source), sizeAttenuation: false, depthTest: false, transparent: true }));
      ring.position.copy(at);
      ring.scale.set(ringSize, ringSize, 1);
      ring.renderOrder = 3;
      // A pin stands on its point.
      if (f.source === "user") ring.center.set(0.5, 0);
      this.findingsGroup.add(ring);
    }
    this.invalidate();
  }

  setSlice(slice: SlicePlane | null) {
    this.clearGroup(this.sliceGroup);
    if (slice) {
      const [w, h] = slice.size;
      const u = this.unit;
      const map = slice.texture === undefined ? null : typeof slice.texture === "string" ? new TextureLoader().load(slice.texture, () => this.invalidate()) : new CanvasTexture(slice.texture as HTMLCanvasElement);
      if (map) map.colorSpace = SRGBColorSpace;
      const plane = new Mesh(new PlaneGeometry(w / u, h / u), new MeshBasicMaterial({ map, color: map ? 0xffffff : 0x6aa7ff, transparent: true, opacity: map ? 0.92 : 0.18, side: DoubleSide, depthWrite: false }));
      const edge = new LineSegments(new EdgesGeometry(plane.geometry), new LineBasicMaterial({ color: 0x6aa7ff }));
      const holder = new Group();
      holder.add(plane, edge);
      holder.position.set(...slice.origin).divideScalar(u);
      holder.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...slice.normal).normalize()));
      holder.renderOrder = 1;
      this.sliceGroup.add(holder);
    }
    this.invalidate();
  }

  /** A ring (solid or dashed) or a pin, drawn once per kind. */
  private marker(source: FindingSource): Texture {
    const had = this.textures.get(source);
    if (had) return had;
    const s = 128;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d")!;
    g.strokeStyle = g.fillStyle = sourceColor[source];
    g.lineWidth = 9;
    g.shadowColor = "rgba(0,0,0,.6)";
    g.shadowBlur = 6;
    if (source === "user") {
      g.beginPath();
      g.arc(s / 2, s * 0.3, s * 0.2, Math.PI, 0);
      g.lineTo(s / 2, s);
      g.closePath();
      g.fill();
      g.fillStyle = "#16181d";
      g.beginPath();
      g.arc(s / 2, s * 0.3, s * 0.08, 0, Math.PI * 2);
      g.fill();
    } else {
      if (source === "ai") g.setLineDash([14, 10]);
      g.beginPath();
      g.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
      g.stroke();
    }
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    this.textures.set(source, t);
    return t;
  }

  private clearGroup(g: Group) {
    for (const o of [...g.children]) {
      o.traverse((x) => {
        const m = x as Mesh;
        m.geometry?.dispose();
        const mat = m.material as Material | Material[] | undefined;
        for (const y of Array.isArray(mat) ? mat : mat ? [mat] : []) {
          const map = (y as MeshBasicMaterial).map;
          // Marker textures are shared and kept; a slice's picture goes with it.
          if (map && ![...this.textures.values()].includes(map)) map.dispose();
          y.dispose();
        }
      });
      g.remove(o);
    }
  }

  // ── the corner axes ──

  private buildGizmo() {
    const colors = [0xf26d6d, 0x6fd97a, 0x6aa7ff];
    const dirs = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    dirs.forEach((d, i) => {
      this.gizmo.add(new ArrowHelper(d, new Vector3(), 1, colors[i], 0.3, 0.16));
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      g.fillStyle = `#${colors[i].toString(16).padStart(6, "0")}`;
      g.font = "bold 44px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("XYZ"[i], 32, 34);
      const label = new Sprite(new SpriteMaterial({ map: new CanvasTexture(c), depthTest: false }));
      label.position.copy(d).multiplyScalar(1.35);
      label.scale.setScalar(0.5);
      this.gizmo.add(label);
    });
  }

  // ── pointer ──

  private toNdc(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  /** The visible, uncut part under a point. */
  private pick(ndc: Vector2): Part | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.parts.filter((p) => p.mesh.visible).map((p) => p.mesh);
    for (const hit of this.raycaster.intersectObjects(meshes, false)) {
      if (this.clipOn && this.clip.distanceToPoint(hit.point) < 0) continue;
      return this.parts.find((p) => p.mesh === hit.object) ?? null;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const p = this.pick(this.toNdc(e));
    this.select(p ? p.id : null);
  };

  private onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    this.pointer = this.toNdc(e);
    this.invalidate();
  };

  private onLeave = () => {
    this.pointer = null;
    if (this.hovered) {
      this.hovered = null;
      this.restyle();
      this.events.hover(null);
    }
  };

  // ── drawing ──

  invalidate() {
    this.dirty = true;
  }

  private fitCanvas() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    if (this.pointer) {
      const p = this.pick(this.pointer);
      this.pointer = null;
      if (p !== this.hovered) {
        this.hovered = p;
        this.restyle();
        this.events.hover(p?.name ?? null);
        this.renderer.domElement.style.cursor = p ? "pointer" : "";
      }
    }
    if (!this.dirty) return;
    this.dirty = false;
    const r = this.renderer;
    const w = r.domElement.clientWidth;
    const h = r.domElement.clientHeight;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.clear();
    r.render(this.scene, this.camera);
    // The axes in the lower-left corner, turned as the camera is.
    const s = Math.min(96, Math.floor(Math.min(w, h) / 3));
    this.gizmoCamera.position.set(0, 0, 4).applyQuaternion(this.camera.quaternion);
    this.gizmoCamera.quaternion.copy(this.camera.quaternion);
    r.setViewport(8, 8, s, s);
    r.setScissor(8, 8, s, s);
    r.setScissorTest(true);
    r.clearDepth();
    r.render(this.gizmo, this.gizmoCamera);
    r.setScissorTest(false);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerleave", this.onLeave);
    this.clearGroup(this.findingsGroup);
    this.clearGroup(this.sliceGroup);
    for (const p of this.parts) {
      p.mesh.geometry.dispose();
      p.material.map?.dispose();
      p.material.dispose();
    }
    this.gizmo.traverse((o) => {
      const m = o as Sprite;
      m.material?.map?.dispose();
      (m.material as Material | undefined)?.dispose();
      (m as unknown as Mesh).geometry?.dispose();
    });
    for (const t of this.textures.values()) t.dispose();
    this.renderer.dispose();
    el.remove();
  }
}
