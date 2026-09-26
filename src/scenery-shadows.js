// Visual LOD must not change a scenery caster's shadow silhouette. Keep the
// ordinary sun map and filtering, swapping only geometry during its render.
import * as THREE from 'three';

export class SceneryShadow extends THREE.ShadowNode {
  renderShadow(frame) {
    const {renderer}=frame,draw=renderer.getRenderObjectFunction();
    renderer.setRenderObjectFunction((o,s,c,g,m,group,lights,clip,pass)=>{
      const geometry=o.geometry,full=o.shadowGeometry;
      if(!full || full===geometry){draw(o,s,c,g,m,group,lights,clip,pass);return;}
      try{o.geometry=full;draw(o,s,c,full,m,group,lights,clip,pass);}
      finally{o.geometry=geometry;}
    });
    try{return super.renderShadow(frame);}
    finally{renderer.setRenderObjectFunction(draw);}
  }
}

// r185 can retain vertex bindings when the SAME render object alternates buffer
// sizes (especially after a nested shadow render). Give the two geometries stable
// render-object keys through the public passId API. One scene mesh/draw remains;
// pipeline/attribute state is prepared once for each variant during warm-up.
export function installSceneryRendering(renderer, sun) {
  sun.shadow.shadowNode = new SceneryShadow(sun);
  const draw = renderer.getRenderObjectFunction() || renderer.renderObject.bind(renderer);
  const ids = new Map();
  renderer.setRenderObjectFunction((o,s,c,g,m,group,lights,clip,pass)=>{
    if (o.shadowGeometry) {
      let pair = ids.get(pass);
      if (!pair) { pair = [`${pass ?? 'default'}:scenery-near`, `${pass ?? 'default'}:scenery-far`]; ids.set(pass,pair); }
      pass = pair[g === o.shadowGeometry ? 0 : 1];
    }
    draw(o,s,c,g,m,group,lights,clip,pass);
  });
}
