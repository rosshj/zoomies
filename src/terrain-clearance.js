// Build-time clearance only. Neither routine changes the road or adds geometry.

// A terrain triangle interpolates between its grid corners. Cap ALL corners
// of every cell touched by a road quad's XZ bounds below that quad's LOWEST
// height. This protects the triangle interiors too, including between samples
// and under stacked roads. Bounds are deliberately conservative at bends.
export function clearTerrainGrid(position, segments, size, roadPosition, rowWidth, clearance = .35) {
  const stride = segments + 1, step = size / segments, half = size / 2;
  const caps = new Float64Array(position.count).fill(Infinity);
  const rows = roadPosition.count / rowWidth;
  let touched = 0;
  for (let row = 0; row < rows - 1; row++) {
    const vertices = [row * rowWidth, row * rowWidth + rowWidth - 1, (row + 1) * rowWidth, (row + 2) * rowWidth - 1];
    let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity,low=Infinity;
    for (const i of vertices) {
      minX=Math.min(minX,roadPosition.getX(i));maxX=Math.max(maxX,roadPosition.getX(i));
      minZ=Math.min(minZ,roadPosition.getZ(i));maxZ=Math.max(maxZ,roadPosition.getZ(i));
      low=Math.min(low,roadPosition.getY(i));
    }
    // Include both sides of an exact grid boundary despite Float32 rounding.
    const x0=Math.max(0,Math.floor((minX+half-1e-4)/step));
    const x1=Math.min(segments-1,Math.floor((maxX+half+1e-4)/step));
    const z0=Math.max(0,Math.floor((minZ+half-1e-4)/step));
    const z1=Math.min(segments-1,Math.floor((maxZ+half+1e-4)/step));
    for(let z=z0;z<=z1+1;z++)for(let x=x0;x<=x1+1;x++) {
      const i=z*stride+x;caps[i]=Math.min(caps[i],low-clearance);
    }
  }
  for(let i=0;i<position.count;i++)if(position.getY(i)>caps[i]) {
    position.setY(i,caps[i]);touched++;
  }
  return touched;
}

// The rendered road quad lies inside the capsule of its centreline segment
// and half-width. A circle enclosing every mountain vertex therefore also
// encloses every face; separating circle/capsules protects the full skirt and
// secondary summits, regardless of their triangle sizes or rotation.
export function mountainClearance(x,z,radius,points,halfWidth) {
  let distance2=Infinity;
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length],dx=b.x-a.x,dz=b.z-a.z;
    const t=Math.max(0,Math.min(1,((x-a.x)*dx+(z-a.z)*dz)/(dx*dx+dz*dz || 1)));
    distance2=Math.min(distance2,(x-a.x-t*dx)**2+(z-a.z-t*dz)**2);
  }
  return Math.sqrt(distance2)-radius-halfWidth;
}

export function clearMountainPosition(x,z,radius,points,halfWidth,trackReach,margin=8) {
  const d=Math.hypot(x,z),ux=d>0?x/d:1,uz=d>0?z/d:0;
  const originalX=x,originalZ=z;
  for(let attempt=0;attempt<8;attempt++) {
    const gap=mountainClearance(x,z,radius,points,halfWidth);
    if(gap>=margin)return {x,z,moved:x!==originalX||z!==originalZ};
    const step=Math.max(40,margin-gap+1);x+=ux*step;z+=uz*step;
  }
  // Bounded fallback: outside the entire road's radial envelope, plus skirt.
  const r=Math.max(Math.hypot(x,z),trackReach+radius+halfWidth+margin+1);
  return {x:ux*r,z:uz*r,moved:true};
}
