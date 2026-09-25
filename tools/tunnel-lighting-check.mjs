// Actual procedural tunnels, rendered through the game's cel material conversion.
// Compare another checkout with ART_ROOT + BASELINE=1; counts are not FPS claims.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root = process.env.ART_ROOT || path.resolve(new URL('..', import.meta.url).pathname);
const out = process.env.OUT || '/tmp/zoomies-tunnel-lighting';
await fs.mkdir(out, { recursive: true });
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  try {
    if (req.url === '/') {
      const html = await fs.readFile(path.join(root, 'viewer.html'), 'utf8');
      const imports = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
      res.setHeader('content-type', 'text/html');
      res.end(`<body style="margin:0"><script type="importmap">${imports}</script></body>`); return;
    }
    res.setHeader('content-type', 'text/javascript');
    res.end(await fs.readFile(path.join(root, req.url)));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
try {
  for (const backend of (process.env.BACKENDS || 'webgl,webgpu').split(',')) {
    for (const biome of ['alpine', 'tundra', 'desert', 'mesa', 'volcanic']) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 } }), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const result = await page.evaluate(async ({ biome, backend, baseline }) => {
        const T = await import('three'), { Track } = await import('/src/track.js');
        const { buildFeatureStructures } = await import('/src/features.js');
        const { toonify } = await import('/src/toon.js'), { makeRng } = await import('/src/rng.js');
        const track = new Track({ mode: 'custom', seed: 'TUNNELS', size: .5, curviness: .35, twist: .25,
          hilliness: .3, hills: .4, biomes: [biome], features: ['tunnel'] });
        const run = track.features.runs.find(r => r.kind === 'tunnel');
        if (!run) throw Error(`No tunnel in ${biome}`);
        track.features = { ...track.features, runs: [run], waterfall: null };
        const scene = new T.Scene(); scene.background = new T.Color(0x91b2c6);
        const beforeColors = track.roadSurface.geometry.attributes.color.array.slice();
        buildFeatureStructures(scene, track, () => 0, makeRng('TUNNELS'));
        const structures = scene.children.slice();
        const counts = objects => objects.reduce((s, o) => {
          if (o.isMesh || o.isLine) {
            s.draws++;
            if (o.isMesh) s.triangles += (o.geometry.index?.count || o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
          }
          return s;
        }, { draws: 0, triangles: 0 });
        const lights = structures.filter(o => o.userData.tunnelLighting);
        const t0 = run.i0 + Math.round((run.i1 - run.i0) * .16), t1 = run.i1 - Math.round((run.i1 - run.i0) * .16);
        const N = track.samples, at = i => track._pts[(i % N + N) % N];
        let changed = 0, outside = 0;
        const colors = track.roadSurface.geometry.attributes.color;
        for (let row = 0; row <= N; row++) {
          const relative = ((row - t0) % N + N) % N;
          for (let j = 0; j < track.roadSurface.rowWidth * 3; j++) {
            const v = row * track.roadSurface.rowWidth * 3 + j;
            if (colors.array[v] !== beforeColors[v]) { changed++; if (relative > t1 - t0) outside++; }
          }
        }
        if (!baseline) {
          if (lights.length !== 3 || counts(lights).triangles > lights[0]?.userData.tunnelLighting.fixtures * 86) throw Error('Tunnel fixture batch budget');
          if (!changed || outside) throw Error('Road spill missing or escaped tunnel');
          if (structures.some(o => o.isLine || o.isLight)) throw Error('Wire or runtime light remains');
          const pos = new T.Vector3();
          for (const mesh of lights) {
            for (const attr of Object.values(mesh.geometry.attributes)) if (!attr.array.every(Number.isFinite)) throw Error('Nonfinite fixture attribute');
            const vertices = mesh.geometry.attributes.position;
            for (let v = 0; v < vertices.count; v++) {
              pos.fromBufferAttribute(vertices, v);
              if (pos.y - track.project(pos).groundY < 9) throw Error('Fixture intrudes into driving/camera space');
            }
          }
        }
        // Exercise a tunnel crossing the lap seam on the same sloped, curved
        // procedural road. Its duplicate end row must receive identical spill.
        if (!baseline && biome === 'alpine') {
          const { buildTunnelLighting } = await import('/src/tunnel-lighting.js');
          const geometry = track.roadSurface.geometry.clone();
          const original = geometry.attributes.color.array.slice();
          const wrapTrack = { ...track, roadSurface: { ...track.roadSurface, geometry } };
          const wrapScene = new T.Scene(), profile = [];
          for (let k = 0; k <= 9; k++) profile.push([Math.cos(Math.PI * k / 9) * (track.halfWidth + 2.6), Math.sin(Math.PI * k / 9) * 15]);
          const tube = structures[0].geometry.clone();
          buildTunnelLighting(wrapScene, wrapTrack, run, -12, 12, profile, tube);
          const c = geometry.attributes.color.array, rowSize = track.roadSurface.rowWidth * 3;
          for (let j = 0; j < rowSize; j++) if (c[j] !== c[N * rowSize + j]) throw Error('Light spill seam');
          let changed = 0;
          for (let j = 0; j < c.length; j++) if (c[j] !== original[j]) {
            changed++;
            const row = Math.floor(j / rowSize);
            if (row > 12 && row < N - 12) throw Error('Wrapped spill escaped tunnel');
          }
          if (!changed) throw Error('Wrapped tunnel unlit');
          geometry.dispose(); tube.dispose();
          for (const mesh of wrapScene.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
        }
        scene.add(track.group);
        scene.add(new T.HemisphereLight(0xdbeeff, 0x746451, 1.4));
        const sun = new T.DirectionalLight(0xfff3dc, 2.4); sun.castShadow = true;
        const mid = at(Math.round((t0 + t1) / 2));
        sun.position.copy(mid).add(new T.Vector3(40, 80, 20)); sun.target.position.copy(mid);
        sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = sun.shadow.camera.bottom = -110;
        sun.shadow.camera.right = sun.shadow.camera.top = 110; sun.shadow.camera.far = 250; sun.shadow.bias = -.001;
        scene.add(sun, sun.target); toonify(scene);
        const renderer = new T.WebGPURenderer({ forceWebGL: backend === 'webgl', antialias: true });
        await renderer.init();
        if ((renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl') !== backend) throw Error('Backend fell back');
        renderer.setSize(1100, 700); renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = T.PCFShadowMap; renderer.toneMapping = T.ACESFilmicToneMapping;
        document.body.appendChild(renderer.domElement);
        const camera = new T.PerspectiveCamera(65, 1100 / 700, .1, 1500);
        const ci = t0 + Math.max(2, Math.round(6 / (track.length / N)));
        camera.position.copy(at(ci)).add(new T.Vector3(0, 5, 0));
        camera.lookAt(at(ci + Math.round(36 / (track.length / N))).clone().add(new T.Vector3(0, 8, 0)));
        for (let i = 0; i < 8; i++) { await new Promise(requestAnimationFrame); renderer.render(scene, camera); }
        return { biome, backend, style: lights[0]?.userData.tunnelLighting, span: [t0, t1],
          structures: counts(structures), lighting: baseline ? null : counts(lights), changedRoadChannels: changed, outside,
          rendered: { ...renderer.info.render }, memory: { ...renderer.info.memory } };
      }, { biome, backend, baseline: !!process.env.BASELINE });
      await page.screenshot({ path: path.join(out, `${biome}-${backend}.png`) });
      result.errors = errors;
      results.push(result); console.log(JSON.stringify(result));
      if (errors.length) throw Error('Rendering errors');
      await page.close();
    }
  }
  await fs.writeFile(path.join(out, 'metrics.json'), JSON.stringify(results, null, 2));
} finally {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
  server.closeAllConnections(); server.close();
}
process.exit(0);
