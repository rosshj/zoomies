// Fixed-size burst pools. Cosmetic fragments never become pickups or obstacles.
import * as THREE from 'three';
const TYPES = {
  apple: { pool:'round', color:0xc74932, scale:[.23,.23,.23], restitution:.5 },
  mango: { pool:'round', color:0xe7b646, scale:[.19,.29,.22], restitution:.4 },
  snow: { pool:'round', color:0xe7f0ef, scale:[.23,.18,.22], restitution:.15 },
  clay: { pool:'shard', color:0xc88a61, scale:[.26,.12,.20], restitution:.2 },
  dust: { pool:'round', color:0x8a8580, scale:[.10,.10,.10], restitution:.12 },
  leaf: { pool:'leaf', color:0xbc813b, scale:[.22,.1,.36], restitution:.12 },
};
export class PropDebris {
  constructor(group, physics) {
    this.physics=physics;this.pools={};this.warmFrames=3;this.dummy=new THREE.Object3D();
    for(const name of ['round','shard','leaf']){
      const geo=name==='round'?new THREE.IcosahedronGeometry(1,0):name==='shard'?new THREE.TetrahedronGeometry(1):new THREE.OctahedronGeometry(1);
      const mesh=new THREE.InstancedMesh(geo,new THREE.MeshStandardMaterial({roughness:1}),12);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;
      // Degenerate, off-road instances draw once under the loading splash so
      // the first impact reuses an already-compiled instance-color pipeline.
      const hidden=new THREE.Matrix4().makeScale(.0001,.0001,.0001).setPosition(0,-10000,0);
      for(let i=0;i<12;i++){mesh.setMatrixAt(i,hidden);mesh.setColorAt(i,new THREE.Color(0xffffff));}
      const slots=Array.from({length:12},()=>({mesh:new THREE.Object3D(),pos:new THREE.Vector3(),vel:new THREE.Vector3(),angVel:new THREE.Vector3(),quat:new THREE.Quaternion(),kind:'fragment',life:0,scale:new THREE.Vector3()}));
      this.pools[name]={mesh,slots,next:0};group.add(mesh);
    }
    this.list=Object.values(this.pools);
  }
  burst(type, source, rand=Math.random) {
    const spec=TYPES[type],pool=this.pools[spec.pool];
    for(let i=0;i<6;i++){
      const p=pool.slots[pool.next];pool.next=(pool.next+1)%pool.slots.length;
      p.pos.copy(source.pos);p.pos.y+=.25;
      p.scale.fromArray(spec.scale).multiplyScalar(.8+rand()*.4);
      p.profile={shape:'sphere',sphereRadius:Math.max(p.scale.x,p.scale.y,p.scale.z),restitution:spec.restitution,gravity:type==='leaf'?9:24,friction:6,angularDrag:6};
      if(!p.worldHull)this.physics.prepare(p,[new THREE.Vector3(0,-p.profile.sphereRadius,0)],source.roadIndex);
      else {p.radius=p.profile.sphereRadius;p.invInertia=1/Math.max(.2,p.radius*p.radius*.4);p.roadIndex=source.roadIndex;p.quiet=0;}
      // prepare seats a new collider; launch from the actual struck object.
      p.pos.copy(source.pos);p.pos.y+=.25;
      const a=i*Math.PI/3+rand()*.4;
      p.vel.set(Math.sin(a)*(3+rand()*3)+source.vel.x*.08,3+rand()*4,Math.cos(a)*(3+rand()*3)+source.vel.z*.08);
      p.angVel.set(rand()*8,rand()*8,rand()*8);p.asleep=p.settle=false;p.life=2.4+rand()*.6;
      p.mesh.position.copy(p.pos);pool.mesh.setColorAt(pool.slots.indexOf(p),new THREE.Color(spec.color).multiplyScalar(.8+rand()*.2));
    }
    if(pool.mesh.instanceColor)pool.mesh.instanceColor.needsUpdate=true;
  }
  update(dt) {
    if(this.warmFrames>0)this.warmFrames--;
    for(const pool of this.list){
      let active=0,dirty=pool.mesh.visible;
      pool.slots.forEach((p,i)=>{
        if(p.life>0){dirty=true;p.life=Math.max(0,p.life-dt);this.physics.step(p,dt);active+=p.life>0?1:0;}
        if(!dirty)return;
        this.dummy.position.copy(p.pos);this.dummy.quaternion.copy(p.quat);
        this.dummy.scale.copy(p.scale).multiplyScalar(p.life>0?Math.min(1,p.life/.5):0);
        this.dummy.updateMatrix();pool.mesh.setMatrixAt(i,this.dummy.matrix);
      });
      pool.mesh.visible=active>0||this.warmFrames>0;if(dirty)pool.mesh.instanceMatrix.needsUpdate=true;
    }
  }
  get activeCount(){let n=0;for(const p of this.list)for(const s of p.slots)if(s.life>0)n++;return n;}
}
