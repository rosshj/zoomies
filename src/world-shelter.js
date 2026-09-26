// Broad neighbouring shelter, baked once after world placement. Analytic canopy
// ellipsoids and structure bounds approximate sky visibility, not sun shadows.
// Existing RGB buffers carry the result; no ray queries survive into gameplay.
import * as THREE from 'three';

function tree(items) {
  const box=new THREE.Box3();for(const x of items)box.union(x.box);
  if(items.length<=8)return {box,items};
  const size=box.getSize(new THREE.Vector3()),axis=size.x>size.z?'x':'z';
  items.sort((a,b)=>a.center[axis]-b.center[axis]);const middle=items.length>>1;
  return {box,left:tree(items.slice(0,middle)),right:tree(items.slice(middle))};
}
function ellipsoidDistance(ray, o) {
  const x=(ray.origin.x-o.center.x)/o.size.x,y=(ray.origin.y-o.center.y)/o.size.y,z=(ray.origin.z-o.center.z)/o.size.z;
  const dx=ray.direction.x/o.size.x,dy=ray.direction.y/o.size.y,dz=ray.direction.z/o.size.z;
  const a=dx*dx+dy*dy+dz*dz,b=x*dx+y*dy+z*dz,c=x*x+y*y+z*z-1,d=b*b-a*c;
  if(d<0)return Infinity;
  const near=(-b-Math.sqrt(d))/a,far=(-b+Math.sqrt(d))/a;
  return far<0?Infinity:Math.max(0,near);
}
export function bakeWorldShelter(scene) {
  if(scene.userData.worldShelter)return;
  const start=performance.now(),occluders=[],receivers=[],seen=new Set(),matrix=new THREE.Matrix4(),instance=new THREE.Matrix4();
  scene.updateMatrixWorld(true);
  const add=(box,owner,canopy=false)=>{const size=box.getSize(new THREE.Vector3()).multiplyScalar(.5);if(Math.min(size.x,size.y,size.z)<.05)return;occluders.push({box,owner,canopy,center:box.getCenter(new THREE.Vector3()),size});};
  for(const root of scene.children) {
    if(root.userData.canopyShape && root.isInstancedMesh){
      const g=root.geometry;g.computeBoundingBox();
      for(let i=0;i<root.count;i++){root.getMatrixAt(i,instance);matrix.multiplyMatrices(root.matrixWorld,instance);add(g.boundingBox.clone().applyMatrix4(matrix),root,true);}
    }
    if(root.userData.isBuilding || root.userData.staticProp){
      // The whole footprint is appropriate for broad overhead cover; local
      // roofs/doorways already have the detailed self-occlusion bake.
      add(new THREE.Box3().setFromObject(root),root);
      root.traverse(o=>{
        let moving=false;for(let a=o;a&&a!==root.parent;a=a.parent)if(a.userData.keepLive||a.userData.animated||a.userData.wander)moving=true;
        if(!moving&&o.isMesh&&!o.isInstancedMesh&&!o.material?.transparent && o.geometry.attributes.color)receivers.push({o,owner:root});
      });
    }
    if(root.userData.terrainTile && !seen.has(root.geometry.attributes.color)){
      receivers.push({o:root,owner:root});seen.add(root.geometry.attributes.color);
    }
  }
  if(!occluders.length)return;
  const bvh=tree(occluders),ray=new THREE.Ray(),hit=new THREE.Vector3(),normal=new THREE.Vector3(),tangent=new THREE.Vector3(),bitangent=new THREE.Vector3(),nm=new THREE.Matrix3();
  const radius=24;
  function nearest(node,owner,best) {
    if(node.box.distanceToPoint(ray.origin)>best || !ray.intersectsBox(node.box))return best;
    if(!node.items)return nearest(node.right,owner,nearest(node.left,owner,best));
    for(const o of node.items){if(o.owner===owner)continue;let d=Infinity;
      if(o.canopy)d=ellipsoidDistance(ray,o);
      else if(o.box.containsPoint(ray.origin))d=0;
      else if(ray.intersectBox(o.box,hit))d=hit.distanceTo(ray.origin);
      if(d<best)best=d;
    }return best;
  }
  let vertices=0,shaded=0;
  for(const {o,owner} of receivers){
    const g=o.geometry,p=g.attributes.position,n=g.attributes.normal,c=g.attributes.color;
    nm.getNormalMatrix(o.matrixWorld);
    for(let i=0;i<p.count;i++){
      normal.fromBufferAttribute(n,i).applyNormalMatrix(nm);
      // Only sky-facing directions contribute: neighbouring walls don't paint
      // a directional sun shadow permanently onto the sunny side of a facade.
      ray.origin.fromBufferAttribute(p,i).applyMatrix4(o.matrixWorld).addScaledVector(normal,.06);
      tangent.set(Math.abs(normal.y)<.9?0:1,Math.abs(normal.y)<.9?1:0,0).cross(normal).normalize();bitangent.crossVectors(normal,tangent);
      let sum=0,weight=0;
      for(let j=0;j<24;j++){
        const r=Math.sqrt((j+.5)/24),a=j*2.399963229728653;
        ray.direction.copy(normal).multiplyScalar(Math.sqrt(1-r*r)).addScaledVector(tangent,r*Math.cos(a)).addScaledVector(bitangent,r*Math.sin(a));
        if(ray.direction.y<=.05)continue;
        const w=ray.direction.y;sum+=w*Math.pow(1-nearest(bvh,owner,radius)/radius,2);weight+=w;
      }
      const cover=weight?sum/weight*.16:0;
      if(cover>.001){c.setXYZ(i,c.getX(i)*(1-cover),c.getY(i)*(1-cover*.95),c.getZ(i)*(1-cover*.86));shaded++;}
      vertices++;
    }c.needsUpdate=true;
  }
  scene.userData.worldShelter={occluders:occluders.length,vertices,shaded,ms:performance.now()-start};
}
