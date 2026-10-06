import * as THREE from 'three';
import { FIELD, ROD_LAYOUT, PLAYER_SPACING } from './shared/game.js';

// The renderer shares its dimensions with the authoritative game simulation.
// X runs from goal to goal, Z runs along a rod, and Y is height above the pitch.
const COLORS = { walnut: 0x453226, edge: 0x211d19, brass: 0xc5a778, cream: 0xebe6d2, orange: 0xf17a4d, mint: 0x61c7ac };
const ROD_HEIGHT = 0.94;

function roundedSlabGeometry(width, depth, height, radius = 0.12, bevel = 0.035) {
  const x = -width / 2 + bevel, z = -depth / 2 + bevel;
  const w = width - bevel * 2, d = depth - bevel * 2;
  const r = Math.min(radius, w / 2, d / 2);
  const shape = new THREE.Shape();
  shape.moveTo(x + r, z);
  shape.lineTo(x + w - r, z);
  shape.quadraticCurveTo(x + w, z, x + w, z + r);
  shape.lineTo(x + w, z + d - r);
  shape.quadraticCurveTo(x + w, z + d, x + w - r, z + d);
  shape.lineTo(x + r, z + d);
  shape.quadraticCurveTo(x, z + d, x, z + d - r);
  shape.lineTo(x, z + r);
  shape.quadraticCurveTo(x, z, x + r, z);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height - bevel * 2, steps: 1, bevelEnabled: true,
    bevelSegments: 2, bevelSize: bevel, bevelThickness: bevel, curveSegments: 5,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2 + bevel, 0);
  return geometry;
}

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function pitchTexture() {
  return canvasTexture(1536, 824, (ctx, w, h) => {
    ctx.fillStyle = '#195f49';
    ctx.fillRect(0, 0, w, h);
    for (let n = 0; n < 10; n += 2) {
      ctx.fillStyle = 'rgba(230,248,212,.037)';
      ctx.fillRect(n * w / 10, 0, w / 10, h);
    }
    // A baked cloth grain gives the table texture without additional geometry.
    let seed = 73;
    for (let n = 0; n < 24000; n++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const x = seed % w;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const y = seed % h;
      ctx.fillStyle = n % 2 ? 'rgba(240,244,206,.025)' : 'rgba(0,16,10,.08)';
      ctx.fillRect(x, y, 1.3, 1.3);
    }
    const px = x => (x / (FIELD.halfLength * 2) + 0.5) * w;
    const pz = z => (z / (FIELD.halfWidth * 2) + 0.5) * h;
    const unit = w / (FIELD.halfLength * 2);
    ctx.strokeStyle = 'rgba(234,231,207,.52)';
    ctx.lineWidth = unit * 0.025;
    ctx.beginPath();
    ctx.moveTo(px(0), pz(-FIELD.halfWidth));
    ctx.lineTo(px(0), pz(FIELD.halfWidth));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, unit * 0.86, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(234,231,207,.68)';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, unit * 0.055, 0, Math.PI * 2);
    ctx.fill();
    for (const side of [-1, 1]) {
      const edge = side * FIELD.halfLength;
      for (const [length, halfWidth] of [[1.12, 1.91], [0.40, FIELD.goalHalfWidth]]) {
        ctx.beginPath();
        ctx.moveTo(px(edge), pz(-halfWidth));
        ctx.lineTo(px(edge - side * length), pz(-halfWidth));
        ctx.lineTo(px(edge - side * length), pz(halfWidth));
        ctx.lineTo(px(edge), pz(halfWidth));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(px(edge - side * 1.7), h / 2, unit * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function footballTexture() {
  return canvasTexture(512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f7f2df';
    ctx.fillRect(0, 0, w, h);
    // Small panels remain readable even when the ball occupies a few pixels.
    for (let row = -1; row <= 3; row++) {
      for (let col = -1; col <= 5; col++) {
        const x = (col + (row % 2 ? 0.5 : 0)) * w / 5;
        const y = row * h / 3 + h / 6;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const angle = i * Math.PI * 2 / 5 - Math.PI / 2;
          const vx = x + Math.cos(angle) * 21;
          const vy = y + Math.sin(angle) * 20;
          if (i === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.fillStyle = '#24332e';
        ctx.fill();
        ctx.strokeStyle = '#c8c8b8';
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
  });
}

function lineGeometry(segments) {
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
}

export function createTableScene(container, { onQualityChange } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch {
    throw new Error('Bu tarayıcı 3D görüntüyü açamadı. Güncel Chrome, Safari veya Edge ile tekrar dene.');
  }
  renderer.setClearColor(0x101c18, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.13;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'table-canvas';
  renderer.domElement.setAttribute('aria-label', 'Üç boyutlu langırt masası');
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const fieldPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.04);
  const pointOnField = new THREE.Vector3();
  const target = new THREE.Vector3(0, -0.34, 0);
  let view = 'perspective';
  let quality = 'auto';
  let actualQuality = 'high';
  let disposed = false;
  let lastSelected = null;
  let lastTeam = null;

  const mat = (color, roughness = 0.6, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const wood = mat(COLORS.walnut, 0.54);
  const woodDark = mat(COLORS.edge, 0.53);
  const brass = mat(COLORS.brass, 0.3, 0.68);
  const darkMetal = mat(0x1d2925, 0.38, 0.55);
  const rubber = mat(0x18221e, 0.95);
  const cream = mat(COLORS.cream, 0.42, 0.08);
  const playerColors = [mat(COLORS.orange, 0.43), mat(COLORS.mint, 0.43)];
  const shorts = mat(0x20382f, 0.6);
  const heads = mat(0xe2bf90, 0.57);
  const hair = mat(0x302720, 0.72);
  const boots = mat(0x182923, 0.8);

  function mesh(geometry, material, x = 0, y = 0, z = 0, parent = scene) {
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  }
  function box(w, h, d, material, x, y, z, parent = scene) {
    return mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z, parent);
  }
  function cylinderZ(radius, length, material, x, y, z, parent = scene, segments = 16) {
    const object = mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material, x, y, z, parent);
    object.rotation.x = Math.PI / 2;
    return object;
  }

  scene.add(new THREE.HemisphereLight(0xf1f5e6, 0x24372d, 2.25));
  const keyLight = new THREE.DirectionalLight(0xffe7c5, 3.2);
  keyLight.position.set(-3, 11, 6);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  Object.assign(keyLight.shadow.camera, { left: -9, right: 9, top: 8, bottom: -8, near: 1, far: 30 });
  keyLight.shadow.bias = -0.00025;
  keyLight.shadow.normalBias = 0.035;
  scene.add(keyLight);
  const fill = new THREE.DirectionalLight(0xa6ded4, 1.3);
  fill.position.set(4, 5, -8);
  scene.add(fill);

  // Thick walnut cabinet, inset playing surface and a fine brass reveal.
  mesh(roundedSlabGeometry(12.45, 6.48, 0.77, 0.28), wood, 0, -0.47, 0);
  mesh(roundedSlabGeometry(12.49, 6.51, 0.075, 0.27, 0.014), brass, 0, -0.81, 0);
  mesh(roundedSlabGeometry(12.38, 6.40, 0.16, 0.24), woodDark, 0, -0.91, 0);
  const fieldMap = pitchTexture();
  fieldMap.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
  const field = mesh(new THREE.PlaneGeometry(FIELD.halfLength * 2, FIELD.halfWidth * 2), new THREE.MeshStandardMaterial({ map: fieldMap, roughness: 0.96 }), 0, 0.035, 0);
  field.rotation.x = -Math.PI / 2;
  field.castShadow = false;

  for (const z of [-1, 1]) {
    mesh(roundedSlabGeometry(11.7, 0.33, 0.38, 0.07), wood, 0, 0.16, z * 3.08);
    box(10.85, 0.12, 0.06, cream, 0, 0.145, z * (FIELD.halfWidth + 0.025));
    box(11.52, 0.021, 0.026, brass, 0, 0.362, z * 3.08);
  }
  for (const x of [-1, 1]) {
    const sideLength = FIELD.halfWidth - FIELD.goalHalfWidth;
    for (const z of [-1, 1]) {
      mesh(roundedSlabGeometry(0.41, sideLength + 0.3, 0.4, 0.055), wood, x * (FIELD.halfLength + 0.18), 0.17, z * (FIELD.goalHalfWidth + sideLength / 2 + 0.05));
      box(0.06, 0.12, sideLength, cream, x * (FIELD.halfLength + 0.025), 0.145, z * (FIELD.goalHalfWidth + sideLength / 2));
    }
  }

  // The diagonal bumpers are visible faces matching the corner collision edges.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const bevel = FIELD.cornerBevel ?? FIELD.cornerSize ?? 0.52;
    const corner = new THREE.Shape();
    corner.moveTo(sx * FIELD.halfLength, -sz * FIELD.halfWidth);
    corner.lineTo(sx * (FIELD.halfLength - bevel), -sz * FIELD.halfWidth);
    corner.lineTo(sx * FIELD.halfLength, -sz * (FIELD.halfWidth - bevel));
    corner.closePath();
    const geometry = new THREE.ExtrudeGeometry(corner, { depth: 0.24, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    mesh(geometry, brass, 0, 0.037, 0);
  }

  // Goals have real depth, open mouths, upright posts and a single net mesh.
  const netMaterial = new THREE.LineBasicMaterial({ color: 0xd8e2ce, transparent: true, opacity: 0.27 });
  for (const side of [-1, 1]) {
    const mouth = side * FIELD.halfLength;
    const back = side * (FIELD.halfLength + 0.69);
    const half = FIELD.goalHalfWidth;
    const floor = box(0.78, 0.035, half * 2, mat(0x16372c, 0.95), side * (FIELD.halfLength + 0.36), 0.01, 0);
    floor.castShadow = false;
    box(0.10, 0.90, half * 2 + 0.16, woodDark, back + side * 0.055, 0.42, 0);
    for (const z of [-half, half]) {
      mesh(new THREE.CylinderGeometry(0.053, 0.053, 0.9, 12), cream, mouth, 0.46, z);
      box(0.76, 0.08, 0.08, cream, mouth + side * 0.35, 0.885, z);
      box(0.08, 0.86, 0.08, woodDark, back, 0.445, z);
    }
    cylinderZ(0.053, half * 2 + 0.1, cream, mouth, 0.91, 0);
    const segments = [];
    const line = (ax, ay, az, bx, by, bz) => segments.push(ax, ay, az, bx, by, bz);
    for (let z = -half; z <= half + 0.001; z += 0.15) {
      line(back, 0.07, z, back, 0.88, z);
      line(mouth, 0.88, z, back, 0.88, z);
    }
    for (let y = 0.1; y < 0.9; y += 0.13) {
      line(back, y, -half, back, y, half);
      line(mouth, y, -half, back, y, -half);
      line(mouth, y, half, back, y, half);
    }
    for (let t = 0; t <= 1; t += 0.2) {
      const x = mouth + (back - mouth) * t;
      line(x, 0.06, -half, x, 0.88, -half);
      line(x, 0.06, half, x, 0.88, half);
      line(x, 0.88, -half, x, 0.88, half);
    }
    scene.add(new THREE.LineSegments(lineGeometry(segments), netMaterial));
  }

  // A compact undercarriage gives the playing surface a convincing physical weight.
  for (const x of [-4.75, 4.75]) for (const z of [-2.48, 2.48]) {
    const leg = box(0.26, 1.3, 0.32, darkMetal, x, -1.53, z);
    leg.rotation.x = z > 0 ? -0.045 : 0.045;
    mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.1, 12), brass, x, -2.21, z * 1.013);
  }
  for (const z of [-2.48, 2.48]) box(9.58, 0.13, 0.13, darkMetal, 0, -1.8, z);

  const nameTexture = canvasTexture(768, 96, (ctx, w, h) => {
    ctx.fillStyle = '#d7c49d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 42px Georgia, serif';
    ctx.fillText('L A N G I R T   C L U B', w / 2, h / 2);
  });
  const name = mesh(new THREE.PlaneGeometry(3.6, 0.45), new THREE.MeshBasicMaterial({ map: nameTexture, transparent: true, depthWrite: false }), 0, -0.41, 3.246);
  name.castShadow = false;

  // All figures share geometries and materials; only their rod transform changes.
  const torsoGeometry = roundedSlabGeometry(0.36, 0.40, 0.35, 0.045, 0.023);
  const headGeometry = new THREE.SphereGeometry(0.148, 12, 9);
  const hairGeometry = new THREE.SphereGeometry(0.153, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.44);
  const waistGeometry = new THREE.BoxGeometry(0.3, 0.14, 0.35);
  const legGeometry = new THREE.BoxGeometry(0.17, 0.29, 0.24);
  const footGeometry = roundedSlabGeometry(0.30, 0.42, 0.20, 0.025, 0.015);
  const stripeGeometry = new THREE.BoxGeometry(0.012, 0.045, 0.37);
  const rodObjects = ROD_LAYOUT.map((layout, index) => {
    const team = layout.team ?? (index < 3 ? 0 : 1);
    const handleSide = team === 0 ? 1 : -1;
    cylinderZ(0.048, 7.34, brass, layout.x, ROD_HEIGHT, 0, scene, 12);
    const players = new THREE.Group();
    players.position.set(layout.x, ROD_HEIGHT, 0);
    scene.add(players);
    for (let n = 0; n < layout.count; n++) {
      const figure = new THREE.Group();
      figure.position.z = (n - (layout.count - 1) / 2) * PLAYER_SPACING;
      players.add(figure);
      mesh(torsoGeometry, playerColors[team], 0, -0.11, 0, figure);
      mesh(headGeometry, heads, 0, 0.24, 0, figure);
      mesh(hairGeometry, hair, 0, 0.265, 0, figure);
      mesh(waistGeometry, shorts, 0, -0.345, 0, figure);
      mesh(legGeometry, playerColors[team], 0, -0.535, 0, figure);
      mesh(footGeometry, boots, 0, -0.69, 0, figure);
      mesh(stripeGeometry, cream, team === 0 ? 0.184 : -0.184, -0.08, 0, figure);
    }
    const handle = new THREE.Group();
    handle.position.set(layout.x, ROD_HEIGHT, handleSide * 3.98);
    scene.add(handle);
    cylinderZ(0.13, 0.78, rubber, 0, 0, 0, handle, 12);
    for (const z of [-0.34, 0.34]) cylinderZ(0.136, 0.055, brass, 0, 0, z, handle, 12);
    for (const z of [-3.06, 3.06]) {
      // Raised bronze bearing blocks support the actual shaft height.
      mesh(roundedSlabGeometry(0.31, 0.27, 0.56, 0.05, 0.02), woodDark, layout.x, 0.63, z);
      cylinderZ(0.133, 0.23, brass, layout.x, ROD_HEIGHT, z, scene, 12);
      cylinderZ(0.083, 0.27, rubber, layout.x, ROD_HEIGHT, z, scene, 12);
    }
    const indicatorMaterial = new THREE.MeshStandardMaterial({
      color: team === 0 ? COLORS.orange : COLORS.mint,
      emissive: team === 0 ? COLORS.orange : COLORS.mint,
      emissiveIntensity: 0.0, roughness: 0.5,
    });
    const indicator = mesh(new THREE.TorusGeometry(0.159, 0.027, 6, 18), indicatorMaterial, layout.x, ROD_HEIGHT, handleSide * 3.22);
    indicator.castShadow = false;
    const focus = mesh(new THREE.PlaneGeometry(0.075, FIELD.halfWidth * 2 - 0.12), new THREE.MeshBasicMaterial({ color: team === 0 ? COLORS.orange : COLORS.mint, transparent: true, opacity: 0, depthWrite: false }), layout.x, 0.043, 0);
    focus.rotation.x = -Math.PI / 2;
    focus.castShadow = false;
    return { players, handle, handleSide, indicatorMaterial, focus, team };
  });

  // One instanced draw per figure part keeps twelve detailed figures affordable
  // on tablets. Hidden source transforms retain the straightforward rod hierarchy.
  const playerBatchMap = new Map();
  for (const rod of rodObjects) rod.players.traverse(object => {
    if (!object.isMesh) return;
    const key = `${object.geometry.uuid}:${object.material.uuid}`;
    if (!playerBatchMap.has(key)) playerBatchMap.set(key, []);
    playerBatchMap.get(key).push(object);
    object.visible = false;
  });
  const playerBatches = [...playerBatchMap.values()].map(sources => {
    const instance = new THREE.InstancedMesh(sources[0].geometry, sources[0].material, sources.length);
    instance.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instance.castShadow = true;
    instance.receiveShadow = true;
    instance.frustumCulled = false;
    scene.add(instance);
    return { instance, sources };
  });

  // Cabinet, shafts and bearings do not move. Bake them into a few material
  // batches instead of issuing an individual draw call for every small part.
  const staticMaterials = new Set([wood, woodDark, brass, cream, darkMetal, rubber]);
  const staticBatches = new Map();
  scene.updateMatrixWorld(true);
  for (const object of [...scene.children]) {
    if (!object.isMesh || object.isInstancedMesh || !staticMaterials.has(object.material)) continue;
    if (!staticBatches.has(object.material)) staticBatches.set(object.material, []);
    staticBatches.get(object.material).push(object);
  }
  for (const [material, objects] of staticBatches) {
    const pieces = objects.map(object => {
      const piece = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      piece.applyMatrix4(object.matrixWorld);
      return piece;
    });
    const vertexCount = pieces.reduce((total, piece) => total + piece.attributes.position.count, 0);
    const geometry = new THREE.BufferGeometry();
    for (const [attribute, itemSize] of [['position', 3], ['normal', 3], ['uv', 2]]) {
      const data = new Float32Array(vertexCount * itemSize);
      let offset = 0;
      for (const piece of pieces) {
        data.set(piece.attributes[attribute].array, offset);
        offset += piece.attributes[attribute].array.length;
      }
      geometry.setAttribute(attribute, new THREE.BufferAttribute(data, itemSize));
    }
    mesh(geometry, material);
    pieces.forEach(piece => piece.dispose());
    for (const object of objects) {
      object.geometry.dispose();
      scene.remove(object);
    }
  }

  const ball = mesh(new THREE.SphereGeometry(FIELD.ballRadius, 24, 16), new THREE.MeshStandardMaterial({ map: footballTexture(), roughness: 0.49, metalness: 0.02 }), 0, FIELD.ballRadius + 0.044, 0);
  const shadowMap = canvasTexture(64, 64, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,.56)');
    gradient.addColorStop(0.48, 'rgba(0,0,0,.31)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  });
  const ballShadow = mesh(new THREE.PlaneGeometry(0.51, 0.51), new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, depthWrite: false }), 0, 0.041, 0);
  ballShadow.rotation.x = -Math.PI / 2;
  ballShadow.castShadow = false;
  const contactShadow = mesh(new THREE.PlaneGeometry(15.5, 10.4), new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, opacity: 0.5, depthWrite: false }), 0, -2.27, 0);
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.castShadow = false;

  const rollAxis = new THREE.Vector3();
  const rollQuaternion = new THREE.Quaternion();
  const lastBall = new THREE.Vector2();
  let hasBall = false;

  function resize() {
    if (disposed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Fit the actual table, including handles, at every tablet orientation.
    // Keep the goal-to-goal axis mostly horizontal on a landscape display.
    // A more diagonal camera made this long table look small in a wide stage.
    const backward = view === 'top' ? new THREE.Vector3(0, 1, 0.001).normalize() : new THREE.Vector3(1.45, 12.8, 10.2).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), backward).normalize();
    const up = new THREE.Vector3().crossVectors(backward, right).normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    let distance = 0;
    for (const x of [-6.28, 6.28]) for (const y of [-2.28, 1.44]) for (const z of [-4.68, 4.68]) {
      const corner = new THREE.Vector3(x, y, z).sub(target);
      const depth = corner.dot(backward);
      distance = Math.max(distance, Math.abs(corner.dot(right)) * 1.06 / tanH + depth, Math.abs(corner.dot(up)) * 1.06 / tanV + depth);
    }
    camera.position.copy(backward.multiplyScalar(distance)).add(target);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  function setQuality(requested = 'auto') {
    quality = ['auto', 'low', 'high'].includes(requested) ? requested : 'auto';
    const modestDevice = window.matchMedia?.('(pointer: coarse)').matches || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
    actualQuality = quality === 'auto' ? (modestDevice ? 'low' : 'high') : quality;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, actualQuality === 'low' ? 1.15 : 1.5));
    renderer.shadowMap.enabled = actualQuality === 'high';
    keyLight.castShadow = actualQuality === 'high';
    resize();
    onQualityChange?.(actualQuality);
  }

  function fieldPoint(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray.intersectPlane(fieldPlane, pointOnField);
  }

  function pickRod(clientX, clientY, team) {
    const point = fieldPoint(clientX, clientY);
    if (!point || Math.abs(point.x) > FIELD.halfLength + 0.65 || Math.abs(point.z) > FIELD.halfWidth + 2.25) return null;
    let best = null;
    let distance = Infinity;
    for (let index = 0; index < ROD_LAYOUT.length; index++) {
      if (rodObjects[index].team !== team) continue;
      const next = Math.abs(point.x - ROD_LAYOUT[index].x);
      if (next < distance) { distance = next; best = index; }
    }
    return best;
  }

  function pointerPosition(clientX, clientY, index) {
    const point = fieldPoint(clientX, clientY);
    const layout = ROD_LAYOUT[index];
    if (!point || !layout) return null;
    const travel = layout.travel ?? Math.max(0.1, FIELD.halfWidth - (layout.count - 1) * PLAYER_SPACING / 2 - 0.25);
    return THREE.MathUtils.clamp(point.z / travel, -1, 1);
  }

  function render(state, dt = 0, localTeam = null, selectedRod = null) {
    if (disposed) return;
    if (state) {
      for (let index = 0; index < rodObjects.length; index++) {
        const object = rodObjects[index];
        const layout = ROD_LAYOUT[index];
        const pos = Number(state.rods?.[index]?.pos ?? state.rods?.[index] ?? 0);
        const travel = layout.travel ?? Math.max(0.1, FIELD.halfWidth - (layout.count - 1) * PLAYER_SPACING / 2 - 0.25);
        object.players.position.z = THREE.MathUtils.clamp(pos, -1, 1) * travel;
        object.handle.position.z = object.handleSide * 3.98 + pos * 0.24;
        const kick = Number(state.kicks?.[index] ?? 0);
        object.players.rotation.z = -object.handleSide * Math.sin(THREE.MathUtils.clamp(kick, 0, 1) * Math.PI) * 1.12;
      }
      if (state.ball && Number.isFinite(state.ball.x) && Number.isFinite(state.ball.z)) {
        const dx = state.ball.x - lastBall.x;
        const dz = state.ball.z - lastBall.y;
        const distance = Math.hypot(dx, dz);
        if (hasBall && distance > 0.00001 && distance < 1.3) {
          rollAxis.set(dz, 0, -dx).normalize();
          rollQuaternion.setFromAxisAngle(rollAxis, distance / FIELD.ballRadius);
          ball.quaternion.premultiply(rollQuaternion);
        }
        ball.position.x = ballShadow.position.x = state.ball.x;
        ball.position.z = ballShadow.position.z = state.ball.z;
        lastBall.set(state.ball.x, state.ball.z);
        hasBall = true;
      }
    }
    if (selectedRod !== lastSelected || localTeam !== lastTeam) {
      for (let index = 0; index < rodObjects.length; index++) {
        const active = index === selectedRod && rodObjects[index].team === localTeam;
        rodObjects[index].indicatorMaterial.emissiveIntensity = active ? 0.95 : 0;
        rodObjects[index].focus.material.opacity = active ? 0.3 : 0;
      }
      lastSelected = selectedRod;
      lastTeam = localTeam;
    }
    scene.updateMatrixWorld(true);
    for (const { instance, sources } of playerBatches) {
      for (let index = 0; index < sources.length; index++) instance.setMatrixAt(index, sources[index].matrixWorld);
      instance.instanceMatrix.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }

  function setView(next) {
    view = next === 'top' ? 'top' : 'perspective';
    resize();
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(container);
  window.addEventListener('resize', resize);
  setQuality('auto');

  function dispose() {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    window.removeEventListener('resize', resize);
    const geometries = new Set(), materials = new Set(), textures = new Set();
    scene.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      const values = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of values) if (material) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { render, resize, setView, setQuality, pickRod, pointerPosition, dispose };
}
