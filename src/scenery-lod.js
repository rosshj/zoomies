// Generation-time vertex clustering. One mesh/material/instance batch remains
// on screen; only its geometry changes, conservatively beyond the whole chunk.
import * as THREE from 'three';

export function simplifyScenery(source, cell) {
  const p=source.attributes.position, attrs=Object.entries(source.attributes).filter(([,a])=>!a.isInstancedBufferAttribute);
  const groups=new Map(),positions=new Map(),remap=new Uint32Array(p.count),positionIds=new Uint32Array(p.count),n=source.attributes.normal;
  for(let i=0;i<p.count;i++) {
    // Preserve hard face directions; don't average a roof into its underside.
    const normal=n?[Math.round(n.getX(i)*2),Math.round(n.getY(i)*2),Math.round(n.getZ(i)*2)].join(','):'';
    const positionKey=`${Math.round(p.getX(i)/cell)},${Math.round(p.getY(i)/cell)},${Math.round(p.getZ(i)/cell)}`;
    let point=positions.get(positionKey);
    if(!point){point={id:positions.size,x:0,y:0,z:0,count:0};positions.set(positionKey,point);}
    point.x+=p.getX(i);point.y+=p.getY(i);point.z+=p.getZ(i);point.count++;positionIds[i]=point.id;
    const key=positionKey+':'+normal;
    let entry=groups.get(key);
    if(!entry){entry={id:groups.size,point,count:0,values:attrs.map(([,a])=>new Array(a.itemSize).fill(0))};groups.set(key,entry);}
    remap[i]=entry.id;entry.count++;
    attrs.forEach(([,a],j)=>{for(let k=0;k<a.itemSize;k++)entry.values[j][k]+=a.getComponent(i,k);});
  }
  const indices=[],count=source.index?.count||p.count;
  for(let i=0;i<count;i+=3) {
    const ia=source.index?source.index.getX(i):i,ib=source.index?source.index.getX(i+1):i+1,ic=source.index?source.index.getX(i+2):i+2;
    if(positionIds[ia]!==positionIds[ib]&&positionIds[ib]!==positionIds[ic]&&positionIds[ia]!==positionIds[ic])indices.push(remap[ia],remap[ib],remap[ic]);
  }
  if(indices.length>=count*.9 || indices.length<12)return null;
  const result=new THREE.BufferGeometry();
  attrs.forEach(([name,a],j)=>{
    const data=new Float32Array(groups.size*a.itemSize);
    for(const e of groups.values())for(let k=0;k<a.itemSize;k++)data[e.id*a.itemSize+k]=name==='position'?e.point[['x','y','z'][k]]/e.point.count:e.values[j][k]/e.count;
    result.setAttribute(name,new THREE.Float32BufferAttribute(data,a.itemSize));
  });
  for(const [name,a] of Object.entries(source.attributes))if(a.isInstancedBufferAttribute)result.setAttribute(name,a);
  result.setIndex(indices);result.normalizeNormals();
  result.boundingBox=source.boundingBox?.clone()||null;result.boundingSphere=source.boundingSphere?.clone()||null;
  return result;
}

export class SceneryLOD {
  constructor(){this.entries=[];this.stats={batches:0,nearTriangles:0,farTriangles:0,farBatches:0};}
  add(mesh,cell,distance=280,prepared=null) {
    const near=mesh.geometry,far=prepared||simplifyScenery(near,cell);if(!far)return;
    if(mesh.isInstancedMesh){if(!mesh.boundingSphere)mesh.computeBoundingSphere();}
    else if(!near.boundingSphere)near.computeBoundingSphere();
    if(near.boundingSphere)far.boundingSphere=near.boundingSphere.clone();
    mesh.updateMatrixWorld(true);
    const sphere=(mesh.isInstancedMesh?mesh.boundingSphere:near.boundingSphere).clone().applyMatrix4(mesh.matrixWorld);
    mesh.shadowGeometry=near; // shadow silhouette never changes with visual LOD
    this.entries.push({mesh,near,far,sphere,distance,isFar:false});
    this.stats.batches++;const count=mesh.isInstancedMesh?mesh.count:1;
    this.stats.nearTriangles+=(near.index?.count||near.attributes.position.count)/3*count;
    this.stats.farTriangles+=(far.index?.count||far.attributes.position.count)/3*count;
  }
  update(cameras) {
    let farCount=0;
    for(const e of this.entries){
      let distance=Infinity;
      for(const c of cameras)distance=Math.min(distance,e.sphere.center.distanceTo(c.position)-e.sphere.radius);
      // Hysteresis avoids flickering if the camera sits on a threshold.
      e.isFar=distance>(e.distance+(e.isFar?-25:25));
      e.mesh.geometry=e.isFar?e.far:e.near;if(e.isFar)farCount++;
    }
    this.stats.farBatches=farCount;
  }
  dispose(){for(const e of this.entries){e.mesh.geometry=e.near;e.far.dispose();}this.entries.length=0;}
}
