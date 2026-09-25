import * as T from 'three';
export function trackFixture(hills = true, crossing = false) {
  const samples = 240, halfWidth = 9, radius = 70, _pts = [], _tans = [];
  for (let i = 0; i < samples; i++) {
    const a = i / samples * Math.PI * 2;
    _pts.push(new T.Vector3(Math.sin(a) * radius, crossing ? 12 * Math.cos(a) : hills ? 8 * Math.sin(a * 3) : 0,
      crossing ? Math.sin(a * 2) * radius : Math.cos(a) * radius));
  }
  for (let i = 0; i < samples; i++) _tans.push(_pts[(i + 1) % samples].clone().sub(_pts[(i - 1 + samples) % samples]).normalize());
  const positions = [], index = [];
  for (let i = 0; i <= samples; i++) {
    const p = _pts[i % samples], side = new T.Vector3().crossVectors(_tans[i % samples], new T.Vector3(0, 1, 0)).normalize();
    for (let j = 0; j <= 10; j++) { const v = p.clone().addScaledVector(side, -halfWidth + j / 10 * halfWidth * 2); positions.push(v.x, v.y + .02, v.z); }
    if (i < samples) for (let j = 0; j < 10; j++) { const a = i * 11 + j, b = a + 11; index.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geometry.setIndex(index); geometry.computeVertexNormals();
  const length = _pts.reduce((v, p, i) => v + p.distanceTo(_pts[(i + 1) % samples]), 0);
  const groundInfo = (x,z) => {
    let best=Infinity,y=0;
    for(let i=0;i<samples;i++){
      const a=_pts[i],b=_pts[(i+1)%samples],dx=b.x-a.x,dz=b.z-a.z;
      const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz)));
      const d=(x-a.x-t*dx)**2+(z-a.z-t*dz)**2;
      if(d<best){best=d;y=a.y+(b.y-a.y)*t;}
    }
    return {dist:Math.sqrt(best),y};
  };
  return { samples, length, halfWidth, _pts, _tans, groundInfo, distanceToCenter:(x,z)=>groundInfo(x,z).dist, roadSurface: { geometry, rowWidth: 11 } };
}
