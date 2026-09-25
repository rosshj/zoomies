// Generation-only, local occlusion. Results multiply the existing painted RGB
// attributes; no lighting pass, shader sample, runtime tick or extra topology.
import * as THREE from 'three';

const cache = new Map();
let cachedValues = 0;
const MAX_VALUES = 65536, MAX_ENTRIES = 48, MAX_TRIANGLES = 6000;
export const bakeStats = { builds: 0, hits: 0, vertices: 0, ms: 0 };

function keyFor(entries, radius, ground) {
  let a = 2166136261, b = 5381;
  const mix = v => { a = Math.imul(a ^ v, 16777619); b = Math.imul(b, 33) ^ v; };
  for (const { geometry, matrix } of entries) {
    for (const attr of [geometry.attributes.position, geometry.attributes.normal, geometry.index]) {
      mix(attr?.count || 0);
      if (attr) for (const v of attr.array) mix(Math.round(v * 10000));
    }
    for (const v of matrix.elements) mix(Math.round(v * 10000));
  }
  return `${a >>> 0}:${b >>> 0}:${radius}:${ground}`;
}

function makeTree(tris) {
  const box = new THREE.Box3();
  for (const t of tris) box.expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
  if (tris.length <= 8) return { box, tris };
  const size = box.getSize(new THREE.Vector3());
  const axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
  tris.sort((a,b) => a.center[axis] - b.center[axis]);
  const middle = tris.length >> 1;
  return { box, left: makeTree(tris.slice(0,middle)), right: makeTree(tris.slice(middle)) };
}

function occlusion(entries, radius, ground) {
  const key = keyFor(entries, radius, ground);
  if (cache.has(key)) { const value=cache.get(key);cache.delete(key);cache.set(key,value);bakeStats.hits++;return value; }
  const tris=[], samples=[], normalMatrix=new THREE.Matrix3();
  for (const { geometry:g, matrix } of entries) {
    const p=g.attributes.position,n=g.attributes.normal,points=[];
    normalMatrix.getNormalMatrix(matrix);
    for(let i=0;i<p.count;i++) {
      const point=new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(matrix);
      points.push(point);
      samples.push({point,normal:new THREE.Vector3().fromBufferAttribute(n,i).applyNormalMatrix(normalMatrix)});
    }
    const count=g.index?.count || p.count;
    for(let i=0;i<count;i+=3) {
      const a=points[g.index?g.index.getX(i):i],b=points[g.index?g.index.getX(i+1):i+1],c=points[g.index?g.index.getX(i+2):i+2];
      tris.push({a,b,c,center:a.clone().add(b).add(c).multiplyScalar(1/3)});
    }
  }
  const tree=makeTree(tris),ray=new THREE.Ray(),hit=new THREE.Vector3(),tangent=new THREE.Vector3(),bitangent=new THREE.Vector3();
  const epsilon=.015, values=new Float32Array(samples.length),duplicates=new Map();
  function nearest(node, best) {
    if(node.box.distanceToPoint(ray.origin)>best || !ray.intersectsBox(node.box))return best;
    if(node.tris) {
      for(const t of node.tris)if(ray.intersectTriangle(t.a,t.b,t.c,false,hit)) {
        const d=hit.distanceTo(ray.origin);if(d>epsilon && d<best)best=d;
      }
      return best;
    }
    return nearest(node.right,nearest(node.left,best));
  }
  for(let i=0;i<samples.length;i++) {
    const {point:p,normal:n}=samples[i];
    const id=[p.x,p.y,p.z,n.x,n.y,n.z].map(v=>Math.round(v*10000)).join(',');
    if(duplicates.has(id)){values[i]=duplicates.get(id);continue;}
    tangent.set(Math.abs(n.y)<.9?0:1,Math.abs(n.y)<.9?1:0,0).cross(n).normalize();
    bitangent.crossVectors(n,tangent);
    ray.origin.copy(p).addScaledVector(n,epsilon*2);
    let sum=0;
    // Fixed cosine-weighted hemisphere: more accurate generation, same RGB output.
    for(let j=0;j<25;j++) {
      ray.direction.copy(n);
      if(j) {const r=Math.sqrt((j-.5)/24),a=j*2.399963229728653;ray.direction.multiplyScalar(Math.sqrt(1-r*r)).addScaledVector(tangent,Math.cos(a)*r).addScaledVector(bitangent,Math.sin(a)*r);}
      let d=radius;
      if(ground!==null && ray.direction.y<-.001) {
        const floor=(ground-ray.origin.y)/ray.direction.y;if(floor>=0)d=Math.min(d,floor);
      }
      d=nearest(tree,d);
      sum+=Math.pow(1-d/radius,2);
    }
    values[i]=sum/25;duplicates.set(id,values[i]);
  }
  // A bounded FIFO/LRU cache of scalar shading, never full scene geometry.
  if(values.length<=MAX_VALUES) {
    while(cache.size && (cachedValues+values.length>MAX_VALUES || cache.size>=MAX_ENTRIES)) {
      const first=cache.keys().next().value;cachedValues-=cache.get(first).length;cache.delete(first);
    }
    cache.set(key,values);cachedValues+=values.length;
  }
  bakeStats.builds++;return values;
}

// Only call on a completed, rigid asset, before world placement/static batching.
// Flexible/emissive pieces and their children are excluded as both receivers and
// occluders. Cached factors ignore pigment, so biome palettes share the bake.
export function bakeScenery(root, { radius=2.4, strength=.32, ground=0 }={}) {
  if(root.userData.bakedLighting)return root;
  const started=performance.now(),entries=[];
  root.updateMatrixWorld(true);
  const inverse=root.matrixWorld.clone().invert();
  function collect(o, excluded=false) {
    const m=o.material,ud=m?.userData;
    excluded ||= !o.visible || o.userData.keepLive || o.userData.animated || !!ud?.windFlex || !!ud?.sway;
    if(!excluded && o.isMesh && !o.isInstancedMesh && !Array.isArray(m) && m?.isMeshStandardMaterial && !m.transparent && (!m.emissive?.getHex() || o.userData.bodyWall!==undefined)) {
      const g=o.geometry;
      if(g.attributes.normal)entries.push({object:o,geometry:g,matrix:new THREE.Matrix4().multiplyMatrices(inverse,o.matrixWorld)});
    }
    for(const child of o.children)collect(child,excluded);
  }
  collect(root);
  const triangles=entries.reduce((n,e)=>n+(e.geometry.index?.count || e.geometry.attributes.position.count)/3,0);
  if(!triangles || triangles>MAX_TRIANGLES)return root;
  const values=occlusion(entries,radius,ground);let offset=0,changed=0;
  for(const {object:o,geometry:original} of entries) {
    const g=original.clone(),p=g.attributes.position;
    let c=g.attributes.color;
    if(!c){c=new THREE.Float32BufferAttribute(new Float32Array(p.count*3).fill(1),3);g.setAttribute('color',c);}
    for(let i=0;i<p.count;i++) {
      const amount=values[offset++]*strength;if(amount>.001)changed++;
      // Restrained cool recess tint, preserving the source palette and cel bands.
      c.setXYZ(i,c.getX(i)*(1-amount),c.getY(i)*(1-amount*.95),c.getZ(i)*(1-amount*.86));
    }
    g.userData.bakedLighting=true;o.geometry=g;
    if(!o.material.vertexColors){o.material=o.material.clone();o.material.vertexColors=true;}
  }
  root.userData.bakedLighting={vertices:values.length,shaded:changed};
  bakeStats.vertices+=values.length;bakeStats.ms+=performance.now()-started;
  return root;
}

const probeMaterial=new THREE.MeshStandardMaterial({vertexColors:true});
export function bakeGeometry(geometry, options) {
  return bakeScenery(new THREE.Mesh(geometry,probeMaterial),options).geometry;
}

// Dense cities contain hundreds of unique dimensions. Their known roof/floor
// ledges give a better bounded bake than rebuilding a triangle BVH per facade.
export function bakeBuildingShelter(root, ledges, ground=0) {
  const start=performance.now();let vertices=0,shaded=0;
  root.traverse(o=>{
    if(!o.isMesh || !o.material?.isMeshStandardMaterial || o.material.transparent)return;
    const g=o.geometry.clone(),p=g.attributes.position,n=g.attributes.normal;
    let c=g.attributes.color;
    if(!c){c=new THREE.Float32BufferAttribute(new Float32Array(p.count*3).fill(1),3);g.setAttribute('color',c);}
    for(let i=0;i<p.count;i++) {
      const x=p.getX(i),y=p.getY(i),z=p.getZ(i),vertical=1-Math.max(0,n.getY(i));
      let cover=Math.max(0,1-Math.max(0,y-ground)/.8)*.10*vertical;
      for(const l of ledges) {
        const below=l.y-y;if(below<-.02 || below>l.reach)continue;
        const outside=Math.hypot(Math.max(0,Math.abs(x-l.x)-l.rx),Math.max(0,Math.abs(z-l.z)-l.rz));
        const amount=Math.max(0,1-outside/.5)*Math.max(0,1-below/l.reach)*.22*vertical;
        cover=Math.max(cover,amount);
      }
      c.setXYZ(i,c.getX(i)*(1-cover),c.getY(i)*(1-cover*.95),c.getZ(i)*(1-cover*.86));
      if(cover>.001)shaded++;
    }
    vertices+=p.count;g.userData.bakedLighting=true;o.geometry=g;
    if(!o.material.vertexColors){o.material=o.material.clone();o.material.vertexColors=true;}
  });
  root.userData.bakedLighting={vertices,shaded,analytic:true};bakeStats.vertices+=vertices;bakeStats.ms+=performance.now()-start;
  return root;
}

// Broad, slope-conforming contact under placed structures. The terrain's tiles
// already share one colour buffer. Visit only footprint-adjacent grid vertices;
// combine overlaps with max (not repeated darkening), never touch the road mesh.
export function bakeGroundContacts(scene, footprints) {
  const tile=scene.children.find(o=>o.userData.terrainTile);
  if(!tile || !footprints.length)return;
  const p=tile.geometry.attributes.position,c=tile.geometry.attributes.color;
  const side=Math.round(Math.sqrt(p.count)),step=p.getX(1)-p.getX(0),minX=p.getX(0),minZ=p.getZ(0);
  const mask=new Float32Array(p.count);
  for(const f of footprints) {
    const blur=2.2,reach=Math.hypot(f.rx,f.rz)+blur,cos=Math.cos(f.yaw),sin=Math.sin(f.yaw);
    const x0=Math.max(0,Math.floor((f.x-reach-minX)/step)),x1=Math.min(side-1,Math.ceil((f.x+reach-minX)/step));
    const z0=Math.max(0,Math.floor((f.z-reach-minZ)/step)),z1=Math.min(side-1,Math.ceil((f.z+reach-minZ)/step));
    for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++) {
      const i=z*side+x,dx=p.getX(i)-f.x,dz=p.getZ(i)-f.z;
      const lx=cos*dx-sin*dz,lz=sin*dx+cos*dz;
      const outside=Math.hypot(Math.max(0,Math.abs(lx)-f.rx),Math.max(0,Math.abs(lz)-f.rz));
      const fade=Math.max(0,1-outside/blur),height=Math.max(0,1-Math.abs(p.getY(i)-f.y)/4);
      mask[i]=Math.max(mask[i],fade*fade*height*.14);
    }
  }
  let shaded=0;
  for(let i=0;i<p.count;i++)if(mask[i]>0){const a=mask[i];c.setXYZ(i,c.getX(i)*(1-a),c.getY(i)*(1-a*.95),c.getZ(i)*(1-a*.86));shaded++;}
  c.needsUpdate=true;scene.userData.groundContactBake={footprints:footprints.length,shaded};
}
