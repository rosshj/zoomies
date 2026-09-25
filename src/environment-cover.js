// Instanced ground cover and falling material share four-triangle folded cards.
// Generation performs habitat/surface checks and samples the entire lap before
// applying a budget. Runtime only updates eight wake uniforms and chunk counts.
import * as THREE from 'three';
import { uniform, attribute, positionLocal, positionGeometry, uv, vec2, vec3, float, texture, smoothstep } from 'three/tsl';
import { ENVIRONMENT_PROFILES, ENVIRONMENT_LIMITS, environmentAtlas, debrisLight } from './environment-particles.js';
import { uWindClock, windGustDrift } from './wind.js';

export function reservoirAdd(list, value, seen, cap, random) {
  if(list.length<cap)list.push(value);
  else {const at=Math.floor(random()*seen);if(at<cap)list[at]=value;}
}
export function wakeStrength(kart) {
  if(!kart || kart.airborne || Math.abs(kart.speed||0)<3)return 0;
  return Math.min(1,(Math.abs(kart.speed)-3)/45)*(kart.drifting?1:.75);
}
export function buildEnvironmentCover(scene, track, heightAt, biomeAt, random, blocked, inLake) {
  const ground=[],falling=[],meshes=[];let seenGround=0,seenFall=0;
  for(let i=0;i<track.samples;i++){
    const p=track._pts[i],tan=track._tans[i];
    if(blocked(p.x,p.z))continue;
    for(let j=0;j<4;j++){
      const lat=(random()<.5?-1:1)*(random()<.18?random()*track.halfWidth:(.5+random()*.9)*track.halfWidth);
      const x=p.x-tan.z*lat,z=p.z+tan.x*lat;
      if(inLake(x,z)||blocked(x,z))continue;
      const y=Math.abs(lat)<track.halfWidth?p.y+.065:heightAt(x,z)+.06;
      const name=biomeAt(x,z,y).name,spec=ENVIRONMENT_PROFILES[name];if(!spec)continue;
      const make=()=>({x,y,z,biome:name,t:i/track.samples,tile:spec.tile,size:spec.size*(.8+random()*.5),lift:spec.lift,
        phase:random()*6.283,angle:random()*6.283,color:spec.colors[Math.floor(random()*spec.colors.length)]});
      if(random()<spec.density)reservoirAdd(ground,make(),++seenGround,ENVIRONMENT_LIMITS.ground,random);
      if(random()<spec.fall*.16)reservoirAdd(falling,make(),++seenFall,ENVIRONMENT_LIMITS.falling,random);
    }
  }
  const wakes=Array.from({length:8},()=>uniform(new THREE.Vector4(1e6,1e6,1e6,0)));
  const last=new WeakMap(),sorted=[];let qualityScale=1;
  for(const [name,records] of [['ground',ground],['falling',falling]]){
    if(!records.length)continue;
    // A shuffled prefix remains evenly distributed when Low/distance LOD lowers
    // instance count. Random choices happen only during generation.
    for(let i=records.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[records[i],records[j]]=[records[j],records[i]];}
    const mat=new THREE.MeshBasicNodeMaterial({side:THREE.DoubleSide,alphaTest:.32,fog:true});
    const base=attribute('aBase','vec3'),motion=attribute('aMotion','vec3'),tile=attribute('aTile','float');
    const atlasUV=vec2(uv().x.add(tile.mod(4)).div(4),uv().y.add(float(1).sub(tile.div(4).floor())).div(2));
    const tex=texture(environmentAtlas(),atlasUV);
    const phase=motion.x,t=uWindClock.add(phase);
    let lift=float(0);
    for(const w of wakes){
      const dx=base.x.sub(w.x),dz=base.z.sub(w.z);
      // Squared-distance influence avoids eight square roots per vertex; a
      // height gate stops elevated roads and jumps disturbing the lower strand.
      const close=float(1).sub(dx.mul(dx).add(dz.mul(dz)).div(20)).max(0);
      const level=smoothstep(.5,2.0,base.y.sub(w.y).abs()).oneMinus();
      lift=lift.add(close.mul(close).mul(w.w).mul(level));
    }
    lift=lift.min(1).mul(motion.y);
    const fall=name==='falling';
    const clock=uWindClock.mul(tile.equal(0).select(.09,.14)).add(phase.div(6.283)).fract();
    const fade=fall?smoothstep(0,.08,clock).mul(smoothstep(.85,1,clock).oneMinus()):float(1);
    const spin=fall?t.mul(.45).add(phase):lift.mul(t.mul(2).sin()).mul(.65);
    const flap=fall?t.mul(2.1).sin().mul(.8):lift.mul(t.mul(4.5).sin()).mul(.7);
    const offset=positionLocal.sub(base).mul(fade);
    const ox=offset.x.mul(spin.cos()).sub(offset.z.mul(spin.sin()));
    const oz=offset.x.mul(spin.sin()).add(offset.z.mul(spin.cos()));
    const local=vec3(ox,offset.y.add(oz.mul(flap.sin())).add(positionGeometry.x.abs().mul(lift).mul(.12)),oz.mul(flap.cos()));
    const wind=windGustDrift(base.x,base.z,fall?.8:.15,motion.x.div(6.283));
    const flight=vec3(t.mul(2.3).sin().mul(lift).mul(.45),lift.mul(.85),t.mul(1.7).cos().mul(lift).mul(.5));
    const height=fall?clock.oneMinus().mul(6).add(.15):float(0);
    mat.positionNode=base.add(local).add(wind).add(flight).add(vec3(0,height,0));
    // Broad daylight tint follows the same lights as the grass, without a new
    // light/shadow pass. A small fold shade makes the turning cards legible.
    mat.colorNode=tex.rgb.mul(debrisLight).mul(flap.cos().abs().mul(.18).add(.82));
    mat.opacityNode=tex.a;
    const buckets=new Map();
    for(const r of records){const key=Math.floor(r.x/150)+'_'+Math.floor(r.z/150);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(r);}
    for(const list of buckets.values()){
      const geo=new THREE.PlaneGeometry(1,1,2,1).rotateX(-Math.PI/2);
      const mesh=new THREE.InstancedMesh(geo,mat,list.length),dummy=new THREE.Object3D(),color=new THREE.Color();
      const roots=new Float32Array(list.length*3),motions=new Float32Array(list.length*3),tiles=new Float32Array(list.length);
      list.forEach((r,i)=>{
        dummy.position.set(r.x,r.y,r.z);dummy.rotation.set(0,r.angle,0);dummy.scale.setScalar(r.size*1.4);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);mesh.setColorAt(i,color.set(r.color));
        roots.set([r.x,r.y,r.z],i*3);motions.set([r.phase,r.lift,0],i*3);tiles[i]=r.tile;
      });
      geo.setAttribute('aBase',new THREE.InstancedBufferAttribute(roots,3));geo.setAttribute('aMotion',new THREE.InstancedBufferAttribute(motions,3));geo.setAttribute('aTile',new THREE.InstancedBufferAttribute(tiles,1));
      mesh.name='environment:'+name;mesh.userData.environment=name;mesh.userData.capacity=list.length;
      mesh.computeBoundingSphere();mesh.boundingSphere.radius+=fall?9:3;
      mesh.castShadow=false;mesh.layers.set(1);scene.add(mesh);meshes.push(mesh);
    }
  }
  const cameraList=[];
  const distance=p=>{let d=Infinity;for(const c of cameraList)if(c)d=Math.min(d,p.distanceToSquared(c));return d;};
  const byView=(a,b)=>(a.isPlayer?0:1)-(b.isPlayer?0:1)||distance(a.position)-distance(b.position);
  return {meshes,records:{ground,falling},wakes,
    setQuality(tier,saver=false){qualityScale=tier==='low'?.35:saver?.6:1;},
    update(karts,camPos,dt=.016,views=null){
      cameraList.length=0;
      if(views?.length)for(const c of views)cameraList.push(c.position||c);else cameraList.push(camPos);
      sorted.length=0;for(const k of karts||[])if(wakeStrength(k)>0)sorted.push(k);
      sorted.sort(byView);
      for(let i=0;i<4;i++){
        const k=sorted[i],w=wakes[i].value,puff=wakes[i+4].value;puff.w*=Math.exp(-dt/.35);
        if(!k){w.w=0;continue;}
        const strength=wakeStrength(k),x=k.position.x-Math.sin(k.heading||0)*2,z=k.position.z-Math.cos(k.heading||0)*2,y=k.groundY??k.position.y;
        w.set(x,y,z,strength);
        let prev=last.get(k);if(!prev){prev=new THREE.Vector3(1e6,0,1e6);last.set(k,prev);}
        if(prev.distanceToSquared(k.position)>2.25){puff.set(x,y,z,strength*.7);prev.copy(k.position);}
      }
      for(const m of meshes){const d=Math.sqrt(distance(m.boundingSphere.center))-m.boundingSphere.radius;
        m.visible=d<260;m.count=Math.ceil(m.userData.capacity*qualityScale*(d>110?.4:1));}
    },
  };
}
