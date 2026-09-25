// Small, bounded animation budget. No per-object physics and no added lights.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, uv, smoothstep } from 'three/tsl';
import { paintSolid } from './scenery-art.js';
import { windStrengthAt, uWindDir } from './wind.js';
import { habitatFits, dressingFor } from './biome-dressing.js';
import { makeRng, getSeed } from './rng.js';

function flex(mesh, weight, amplitude) {
  const p=mesh.geometry.attributes.position;
  mesh.geometry.setAttribute('aFlex',new THREE.Float32BufferAttribute(Array.from({length:p.count},(_,i)=>weight(p.getX(i),p.getY(i),p.getZ(i))),1));
  mesh.material=mesh.material.clone();mesh.material.userData.windFlex=amplitude;
  mesh.geometry.computeBoundingSphere();mesh.geometry.boundingSphere.radius+=amplitude*2;
  mesh.castShadow=false;mesh.layers.set(1);
}
export class LivingDetails {
  constructor(){this.items=[];this.counts={};this.flags=0;this.meshes=0;this.point=new THREE.Vector3();}
  decorate(scene,root,kind,biome) {
    if(this.meshes>=8 || (this.counts[kind]||0)>=2)return;
    if(kind==='stall'||kind==='parasol') {
      const canopy=root.children.find(o=>o.isMesh&&o.position.y>(kind==='stall'?2.4:3));
      if(!canopy)return;
      flex(canopy,(x,y,z)=>kind==='stall'?Math.max(0,1-(x/1.2)**2):Math.min(1,Math.hypot(x,z)/1.7),.16);
      scene.attach(canopy);this.items.push({obj:canopy,kind});this.meshes++;
    } else if(['adobe','cabin','chalet'].includes(kind) && this.meshes<=6) {
      for(const side of [-1,1]) {
        const pivot=new THREE.Group();pivot.position.set(side*1.7,2.35,2.17);
        const geo=paintSolid(new THREE.BoxGeometry(.55,.85,.09).translate(side*.275,0,0),dressingFor(biome.name).wood);
        const shutter=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1}));pivot.add(shutter);root.add(pivot);scene.attach(pivot);
        pivot.traverse(o=>o.layers.set(1));this.items.push({obj:pivot,kind:'shutter',side});this.meshes++;
      }
    } else if(kind==='store') {
      // The store records its local facade dimensions; world AABB is unsuitable
      // for the sign's attachment point on rotated buildings.
      const {w,d}=root.userData.facade;
      const pivot=new THREE.Group();pivot.position.set(w*.32,3.3,d/2+.3);
      const parts=[paintSolid(new THREE.BoxGeometry(.08,.7,.08).translate(0,-.35,0),0x595d59),paintSolid(new THREE.BoxGeometry(1.15,.65,.12).translate(0,-.8,0),0xd7b66a)];
      pivot.add(new THREE.Mesh(mergeGeometries(parts),new THREE.MeshStandardMaterial({vertexColors:true,roughness:1})));parts.forEach(g=>g.dispose());
      root.add(pivot);scene.attach(pivot);pivot.traverse(o=>o.layers.set(1));this.items.push({obj:pivot,kind:'sign'});this.meshes++;
    } else return;
    this.counts[kind]=(this.counts[kind]||0)+1;
  }
  flag(scene,x,y,z,yaw) {
    if(this.flags>=2)return;this.flags++;
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(.05,.07,1.6,5),new THREE.MeshStandardMaterial({color:0x77736a,roughness:1}));
    pole.position.set(x,y+.8,z);pole.layers.set(1);scene.add(pole);
    const flag=new THREE.Mesh(new THREE.PlaneGeometry(1.5,.75,5,2).translate(.75,0,0),new THREE.MeshStandardMaterial({color:0xdfae4f,roughness:1,side:THREE.DoubleSide}));
    flag.position.set(x,y+1.2,z);flag.rotation.y=yaw;flex(flag,x=>x/1.5,.32);scene.add(flag);
  }
  update(dt,near) {
    for(const item of this.items) {
      if(item.kind!=='sign'&&item.kind!=='shutter')continue;
      item.obj.getWorldPosition(this.point);if(!near(this.point.x,this.point.z,150))continue;
      const gust=windStrengthAt(this.point.x,this.point.z),axis=item.kind==='shutter'?'y':'z';
      const angle=item.kind==='shutter'?item.side*(.16+gust*.45):(gust-.5)*.20;
      // Preserve the parent's baked road-facing yaw when scene.attach reparents.
      if(item.base===undefined)item.base=item.obj.rotation[axis];
      const target=item.base+angle;item.obj.rotation[axis]+=(target-item.obj.rotation[axis])*Math.min(1,dt*3);
    }
  }
}

export function makeSailboat() {
  const root=new THREE.Group(),parts=[];
  // A continuous tapered hull with a closed deck and painted cockpit inset.
  const hull=new THREE.SphereGeometry(1,10,5,0,Math.PI*2,0,Math.PI/2).rotateX(Math.PI).scale(1.2,.85,2.8);
  parts.push(paintSolid(hull,0x996341));
  parts.push(paintSolid(new THREE.CircleGeometry(1,10).rotateX(-Math.PI/2).scale(1.2,1,2.8),0xd6b87b));
  parts.push(paintSolid(new THREE.CircleGeometry(1,8).rotateX(-Math.PI/2).scale(.65,1,1.2).translate(0,.015,0),0x765239));
  parts.push(paintSolid(new THREE.CylinderGeometry(.06,.08,3.8,6).translate(0,1.9,0),0x746147));
  root.add(new THREE.Mesh(mergeGeometries(parts.map(g=>g.index?g.toNonIndexed():g)),new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,side:THREE.DoubleSide})));
  const shape=new THREE.Shape();shape.moveTo(0,0);shape.lineTo(0,3.2);shape.lineTo(2.15,0);shape.closePath();
  const sail=new THREE.Mesh(new THREE.ShapeGeometry(shape,1),new THREE.MeshStandardMaterial({color:0xf1ddb0,side:THREE.DoubleSide,roughness:1}));
  sail.position.y=.4;flex(sail,(x,y)=>Math.max(0,x/2.15)*(1-y/3.2),.35);root.add(sail);
  root.traverse(o=>o.layers.set(1));return root;
}

export function buildBiomeEvents(scene,track,lakes,heightAt,nameAt,lakeDist) {
  const rng=makeRng(`${getSeed()}:biome-events`),boats=[],vents=[];
  // Only an entirely valid water/habitat orbit is accepted. No boat teleports
  // through a shoreline or crosses onto the racing surface.
  for(const lake of lakes) {
    if(boats.length>=2)break;
    const centres=lake.spine||[{x:lake.x,z:lake.z}];
    for(let attempt=0;attempt<16;attempt++) {
      const c=centres[Math.floor(rng()*centres.length)],radius=10+rng()*8;
      const accepts=n=>['beach','wetlands'].includes(n);
      if(!habitatFits(nameAt,c.x,c.z,accepts,radius+5))continue;
      let valid=true;
      for(let j=0;j<16;j++) {const a=j*Math.PI/8,x=c.x+Math.cos(a)*(radius+4),z=c.z+Math.sin(a)*(radius+4);if(lakeDist(lake,x,z)>lake.waterR-4 || track.distanceToCenter(x,z)<track.halfWidth+10)valid=false;}
      if(!valid)continue;
      const obj=makeSailboat();scene.add(obj);boats.push({obj,x:c.x,z:c.z,y:lake.level,radius,phase:rng()*Math.PI*2});break;
    }
  }
  for(let i=0;i<track.samples&&vents.length<2;i+=19) {
    const p=track._pts[i],t=track._tans[i],len=Math.hypot(t.x,t.z)||1,off=track.halfWidth+22;
    const x=p.x-t.z/len*off,z=p.z+t.x/len*off;
    if(nameAt(x,z)!=='volcanic'||!habitatFits(nameAt,x,z,n=>n==='volcanic',8)||track.distanceToCenter(x,z)<track.halfWidth+14||lakes.some(l=>lakeDist(l,x,z)<l.shoreR+5))continue;
    if(vents.some(v=>Math.hypot(v.x-x,v.z-z)<90))continue;
    vents.push({x,z,y:heightAt(x,z),phase:rng()*35});
  }
  let steam=null,steamPos,steamScale,steamAlpha;
  if(vents.length) {
    // Twelve soft circular billboards at most, in one draw. The radial mask is
    // procedural: no image download, volumetric pass, light or sphere mesh.
    const count=vents.length*6,geo=new THREE.PlaneGeometry(1,1);
    const buffer=n=>new THREE.InstancedBufferAttribute(new Float32Array(count*n),n).setUsage(THREE.DynamicDrawUsage);
    steamPos=buffer(3);steamScale=buffer(1);steamAlpha=buffer(1);
    geo.setAttribute('aSteamPos',steamPos);geo.setAttribute('aSteamScale',steamScale);geo.setAttribute('aSteamAlpha',steamAlpha);
    const mat=new THREE.SpriteNodeMaterial({color:0xe0e0d4,transparent:true,depthWrite:false});
    mat.positionNode=attribute('aSteamPos');mat.scaleNode=attribute('aSteamScale');
    mat.opacityNode=smoothstep(.05,.5,uv().sub(.5).length()).oneMinus().mul(attribute('aSteamAlpha'));
    steam=new THREE.InstancedMesh(geo,mat,count);
    steam.frustumCulled=false;steam.layers.set(1);scene.add(steam);
  }
  let acc=1;
  const result={boats,vents,steam,update(time,dt,near) {
    acc+=dt;if(acc<.08)return;acc=0; // <=12.5Hz, cosmetic ambient motion only
    for(const b of boats) {
      b.obj.visible=near(b.x,b.z,320);if(!b.obj.visible)continue;
      const a=time*.055+b.phase;b.obj.position.set(b.x+Math.cos(a)*b.radius,b.y+.45+Math.sin(time*.7+b.phase)*.07,b.z+Math.sin(a)*b.radius);
      b.obj.rotation.set(Math.sin(time*.55+b.phase)*.015,-a,windStrengthAt(b.x,b.z)*.035);
    }
    if(!steam)return;
    let visible=false;
    for(let v=0;v<vents.length;v++) {
      const vent=vents[v],phase=(time+vent.phase)%38,active=phase<7&&near(vent.x,vent.z,260);visible ||= active;
      for(let j=0;j<6;j++) {
        const t=(phase-j*.65)/4.0,on=active&&t>0&&t<1,s=on?Math.sin(t*Math.PI)*(1+t)*1.1:0;
        const drift=t*2*(.5+windStrengthAt(vent.x,vent.z)),dir=uWindDir.value;
        const index=v*6+j;
        steamPos.setXYZ(index,vent.x+dir.x*drift,vent.y+.3+Math.max(0,t)*6,vent.z+dir.y*drift+Math.sin(j*2)*.5);
        steamScale.setX(index,s*3);steamAlpha.setX(index,on?Math.sin(t*Math.PI)*.28:0);
      }
    }
    steam.visible=visible;if(visible){steamPos.needsUpdate=true;steamScale.needsUpdate=true;steamAlpha.needsUpdate=true;}
  }};
  result.update(0,1,()=>true);scene.userData.biomeEvents={boats:boats.map(({x,z,radius})=>({x,z,radius})),vents};return result;
}
