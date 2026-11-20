import * as THREE from './vendor/three.module.min.js';
import { CHECKPOINTS, PROPS, BOUNDS, ROAD_WIDTH } from './sim.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const tempObject = new THREE.Object3D();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitPlane = new THREE.PlaneGeometry(1, 1);
const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const palettes = new Map();

function random(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function paint(color, glow = false) {
  const key = color + (glow ? 'lit' : '');
  if (!palettes.has(key)) {
    palettes.set(key, glow
      ? new THREE.MeshBasicMaterial({color, side:THREE.DoubleSide})
      : new THREE.MeshLambertMaterial({color, flatShading:true, side:THREE.DoubleSide}));
  }
  return palettes.get(key);
}

function textureCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function label(word, bg, ink, options={}) {
  const w = options.w || 512, h = options.h || 96;
  const map = textureCanvas(w,h,(ctx) => {
    if (bg) { ctx.fillStyle=bg; ctx.fillRect(0,0,w,h); }
    if (options.frame) {
      ctx.strokeStyle=ink; ctx.lineWidth=4; ctx.strokeRect(8,8,w-16,h-16);
      for (const x of [11,w-11]) for (const y of [10,h-10]) {
        ctx.fillStyle='#1c2022';ctx.fillRect(x-2,y-2,4,4);
      }
    }
    ctx.font='900 ' + Math.round(h*(options.size || .63)) + 'px Arial, sans-serif';
    ctx.fillStyle=ink; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.save(); ctx.translate(w/2,h*.54);
    if (options.italic) ctx.transform(1,0,-.17,1,0,0);
    ctx.fillText(word,0,0,w*.9); ctx.restore();
    if(bg) {
      const rng=random(52);
      for(let i=0;i<w*h*.035;i++){
        ctx.fillStyle=i%5===0?'rgba(255,236,205,.18)':'rgba(15,15,20,.16)';
        ctx.fillRect(rng()*w,rng()*h,1+rng()*2,1);
      }
    }
  });
  return new THREE.MeshBasicMaterial({map, transparent:!bg, alphaTest:bg?0:.2, side:THREE.DoubleSide});
}

// A batch joins static shapes sharing paint into one draw call. The course is
// assembled from small pieces, but the GPU receives only one mesh per material.
class Batch {
  constructor() { this.buckets = new Map(); }
  add(g,m,x,y,z,sx=1,sy=1,sz=1,rx=0,ry=0,rz=0) {
    tempObject.position.set(x,y,z); tempObject.scale.set(sx,sy,sz);
    tempObject.rotation.set(rx,ry,rz,'YXZ'); tempObject.updateMatrix();
    this.transformed(g,m,tempObject.matrix);
  }
  transformed(g,m,matrix) {
    let b=this.buckets.get(m);
    if (!b) {b={p:[],n:[],uv:[]};this.buckets.set(m,b);}
    const pos=g.attributes.position, normal=g.attributes.normal, uv=g.attributes.uv;
    const nm=new THREE.Matrix3().getNormalMatrix(matrix), a=new THREE.Vector3();
    const count=g.index?g.index.count:pos.count;
    for(let i=0;i<count;i++){
      const j=g.index?g.index.getX(i):i;
      a.fromBufferAttribute(pos,j).applyMatrix4(matrix); b.p.push(a.x,a.y,a.z);
      a.fromBufferAttribute(normal,j).applyNormalMatrix(nm); b.n.push(a.x,a.y,a.z);
      b.uv.push(uv?uv.getX(j):0, uv?uv.getY(j):0);
    }
  }
  box(x,y,z,w,h,d,c,ry=0,rx=0,rz=0) {this.add(unitBox,c,x,y,z,w,h,d,rx,ry,rz);}
  cyl(x,y,z,r,h,c,ry=0,rx=0,rz=0) {this.add(unitCylinder,c,x,y,z,r,h,r,rx,ry,rz);}
  plane(x,y,z,w,h,c,ry=0,rx=0) {this.add(unitPlane,c,x,y,z,w,h,1,rx,ry);}
  beam(from,to,width,depth,mat) {
    const a=new THREE.Vector3(...from), b=new THREE.Vector3(...to), delta=b.clone().sub(a);
    tempObject.position.copy(a).lerp(b,.5);
    tempObject.quaternion.setFromUnitVectors(UP,delta.clone().normalize());
    tempObject.scale.set(width,delta.length(),depth);tempObject.updateMatrix();
    this.transformed(unitBox,mat,tempObject.matrix);
  }
  finish(target) {
    for (const [m,b] of this.buckets) {
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(b.p,3));
      g.setAttribute('normal',new THREE.Float32BufferAttribute(b.n,3));
      g.setAttribute('uv',new THREE.Float32BufferAttribute(b.uv,2));
      target.add(new THREE.Mesh(g,m));
    }
    this.buckets.clear();
  }
}

function sky(scene) {
  const skyMat=new THREE.ShaderMaterial({
    side:THREE.BackSide, depthWrite:false, fog:false,
    vertexShader:`varying vec3 dir;void main(){dir=position;vec4 p=projectionMatrix*modelViewMatrix*vec4(position,1.);gl_Position=p.xyww;}`,
    fragmentShader:`varying vec3 dir;
      float hash(vec2 p){return fract(sin(dot(p,vec2(17.327,78.233)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
      void main(){vec3 d=normalize(dir);float h=max(0.,d.y);
        vec3 col=mix(vec3(.97,.596,.30),vec3(.83,.326,.231),smoothstep(.015,.28,h));
        col=mix(col,vec3(.235,.241,.319),smoothstep(.16,.8,h));
        float a=atan(d.z,d.x);vec2 uv=vec2(a*2.4,h*20.);
        float mist=noise(uv)*.6+noise(uv*2.05+3.)*.3+noise(uv*4.)*.1;
        col=mix(col,vec3(.396,.255,.302),smoothstep(.43,.76,mist)*.49*smoothstep(.01,.18,h));
        vec3 sun=normalize(vec3(-.45,.225,1.));float ds=length(d-sun);
        col+=vec3(.16,.08,.015)*exp(-ds*7.);
        col=mix(col,vec3(1.,.82,.52),1.-smoothstep(.068,.071,ds));
        gl_FragColor=vec4(col,1.);}`
  });
  const mesh=new THREE.Mesh(new THREE.SphereGeometry(480,48,20),skyMat);
  mesh.renderOrder=-10;mesh.frustumCulled=false;scene.add(mesh);return mesh;
}

function noiseSurface(road) {
  const map=textureCanvas(256,256,(ctx,w,h)=>{
    const img=ctx.createImageData(w,h), rng=random(road?72312:81993);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const n=(rng()-.5)*(road?22:29)+4*Math.sin(x*.07+Math.sin(y*.17))+3*Math.cos((x+y)*.16);
      const base=road?[78,80,80]:[111,100,87];
      img.data[i]=base[0]+n;img.data[i+1]=base[1]+n;img.data[i+2]=base[2]+n;img.data[i+3]=255;
    }
    ctx.putImageData(img,0,0);
    if(road) for(let i=0;i<9;i++){
      let x=rng()*w,y=rng()*h;
      ctx.strokeStyle='rgba(38,35,34,'+(.12+rng()*.15)+')';ctx.lineWidth=.6+rng()*.7;
      ctx.beginPath();ctx.moveTo(x,y);
      for(let k=0;k<4;k++){x+=rng()*9-3;y+=rng()*9;ctx.lineTo(x,y);}
      ctx.stroke();
    }
  });
  map.wrapS=map.wrapT=THREE.RepeatWrapping;
  return new THREE.MeshLambertMaterial({map,side:THREE.DoubleSide});
}

function ribbon(points, left, right, y, material, repeat=5) {
  const verts=[],uv=[],indices=[]; let along=0;
  const n=points.length;
  for(let i=0;i<=n;i++){
    const p=points[i%n],prev=points[(i+n-1)%n],next=points[(i+1)%n];
    const before=new THREE.Vector2(p.x-prev.x,p.z-prev.z).normalize();
    const after=new THREE.Vector2(next.x-p.x,next.z-p.z).normalize();
    const m=before.clone().add(after).normalize(), length=1/Math.max(.55,m.dot(after));
    if(i) along+=Math.hypot(p.x-prev.x,p.z-prev.z);
    for(const [s,u] of [[left,0],[right,Math.abs(right-left)/repeat]]){
      verts.push(p.x+m.y*s*length,y,p.z-m.x*s*length);
      uv.push(u,along/repeat);
    }
    if(i<n) {let j=i*2;indices.push(j,j+2,j+1,j+1,j+2,j+3);}
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(verts,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeVertexNormals();
  return new THREE.Mesh(g,material);
}

function buildRoad(scene,b) {
  const dirt=noiseSurface(false);dirt.map.repeat.set(85,85);
  b.plane(0,-.045,0,510,510,dirt,0,-Math.PI/2);
  const edge=ROAD_WIDTH*.5;
  scene.add(ribbon(CHECKPOINTS,-edge-.95,edge+.95,-.004,paint('#746350')));
  scene.add(ribbon(CHECKPOINTS,-edge,edge,0,noiseSurface(true)));
  for(const s of [-1,1]) scene.add(ribbon(CHECKPOINTS,s*(edge-.62),s*(edge-.43),.025,paint('#b4a17f')));
  // Rubber laid down on the bends stays irregular and low-contrast on the asphalt.
  const rubber=paint('#424340');
  for(const [i,offset,seed] of [[0,1.3,.4],[2,-1.4,.7],[3,1.1,1.4],[5,2.2,.7],[7,-2.2,2.7],[8,.6,1.9]]){
    const a=CHECKPOINTS[i],c=CHECKPOINTS[(i+1)%CHECKPOINTS.length],angle=Math.atan2(c.x-a.x,c.z-a.z);
    const si=Math.sin(angle),co=Math.cos(angle);
    for(const wheel of [-1,1]){
      const pt=(t)=>{const side=offset+wheel*1.08+Math.sin(t*.11+seed)*1.65;return [a.x+si*t+co*side,a.z+co*t-si*side];};
      for(let t=2;t<22;t+=1.5){
        const [x,z]=pt(t),[nx,nz]=pt(t+1.5);
        b.box((x+nx)/2,.029,(z+nz)/2,.18,.009,Math.hypot(nx-x,nz-z)+.06,rubber,Math.atan2(nx-x,nz-z));
      }
    }
  }
  const dash=paint('#a99a7b'), line=paint('#9a8750');
  const repairs=paint('#50504d'),rng=random(231);
  for(let i=0;i<CHECKPOINTS.length;i++){
    const a=CHECKPOINTS[i], c=CHECKPOINTS[(i+1)%CHECKPOINTS.length],dx=c.x-a.x,dz=c.z-a.z;
    const d=Math.hypot(dx,dz), dir=Math.atan2(dx,dz);
    for(let t=4;t<d-1;t+=9) {
      const x=a.x+dx*t/d,z=a.z+dz*t/d;
      for(const off of [-5.5,5.5]) b.box(x+off*dz/d,.035,z-off*dx/d,.12,.015,2.7,dash,dir);
      b.box(x,.035,z,.18,.015,3.4,line,dir);
      if(rng()>.55){
        const off=(rng()-.5)*18;
        b.box(x+off*dz/d,.018,z-off*dx/d,1+rng()*2,.01,2+rng()*5,repairs,dir);
      }
    }
  }
}

const iron=paint('#3a3432'), steel=paint('#5d5952'), rust=paint('#854f38');
const concrete=paint('#898079'), grime=paint('#4a423e'), dark=paint('#292929');
const amber=paint('#e6aa38'), offwhite=paint('#dad0aa'), red=paint('#914734');
const windowGlass=paint('#3f5355'), windowLit=paint('#b58b5d');
const hazardTex = () => {
  const map=textureCanvas(256,32,(ctx)=>{
    ctx.fillStyle='#ca9b3f';ctx.fillRect(0,0,256,32);ctx.fillStyle='#38332d';
    for(let i=-32;i<288;i+=32){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i+15,0);ctx.lineTo(i-4,32);ctx.lineTo(i-19,32);ctx.fill();}
  });
  return new THREE.MeshLambertMaterial({map,side:THREE.DoubleSide});
};
const hazard=hazardTex();

function mountains(b) {
  const rng=random(366);
  for(let ring=0;ring<2;ring++){
    const pos=[],count=112,r=ring===0?280:212;
    const heights=Array.from({length:count},(_,i)=>8+3*Math.sin(i*.5)+7*Math.cos(i*.22)+rng()*7+(1-ring)*9);
    for(let i=0;i<count;i++){
      const a=i/count*TAU,c=(i+1)/count*TAU,h1=heights[i],h2=heights[(i+1)%count];
      const x1=Math.cos(a)*r,z1=Math.sin(a)*r,x2=Math.cos(c)*r,z2=Math.sin(c)*r;
      pos.push(x1,-1,z1,x1,h1,z1,x2,-1,z2,x2,-1,z2,x1,h1,z1,x2,h2,z2);
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.computeVertexNormals();
    b.add(g,paint(ring===0?'#9e766f':'#786661',true),0,0,0);
  }
}

function chimney(b,x,z,r,h,smoke,striped=true) {
  b.cyl(x,h/2,z,r,h,paint('#76655b'));
  for(let k=1;k<8;k++) {
    if(striped && k%2===0 && k>=4) b.cyl(x,k*h/8,z,r*1.025,h/8,red);
    b.cyl(x,k*h/8+.08,z,r*1.04,.13,iron);
  }
  b.cyl(x,h-.2,z,r*1.08,.41,iron);
  b.cyl(x,h+.025,z,r*.8,.04,dark);
  smoke.push({x,z,y:h,scale:Math.max(1,r*.85)});
}

function tank(b,x,z,r,h,mark=true) {
  b.cyl(x,h/2,z,r,h,paint('#b4aaa0'));
  for(const y of [.3,h*.28,h*.55,h*.8,h-.12]) b.cyl(x,y,z,r*1.017,.16,steel);
  b.cyl(x,h+.18,z,r*.92,.38,concrete);
  b.cyl(x,h+.51,z,r*.18,.51,iron);
  if(mark) {
    for(let y=.6; y<h+.3;y+=.69) b.box(x+r+.14,y,z,.18,.08,.75,iron);
    for(const k of [-.38,.38]) b.box(x+r+.14,h*.5,z+k,.1,h+.4,.09,iron);
  }
}

const steelworks=label('DISTRICT STEEL', '#3a3a37','#dcc79c',{h:100,frame:true});
const district=label('WRECK DISTRICT', '#282b28','#d3ba8e',{frame:true});
const dock=label('DOCK  /  04', '#7c462f','#e8d6b0',{frame:true});
const foundry=label('FOUNDRY  07', '#3f4c49','#d6d1ae',{frame:true});
const factoryTag=label('07',null,'#b8aa8c',{w:100,h:120,size:.92});
const shipMarks = [
  label('NRW   FREIGHT',null,'#dcd3ae',{w:256,h:72}),
  label('K   LINES',null,'#e8d4ab',{w:256,h:72}),
  label('PORT   09',null,'#e8d4ab',{w:256,h:72}),
];

function warehouse(b,x,z,w,d,h,variant=0) {
  const wall=[paint('#826f5d'),paint('#795943'),paint('#6a726b')][variant%3];
  const roof=paint('#434949');
  b.box(x,h*.5,z,w,h,d,wall);
  b.box(x,h+.12,z,w+.65,.38,d+.65,roof);
  b.box(x,.48,z,w+.2,.96,d+.2,grime);
  const step=3.7;
  for(let xx=-w/2+1.5;xx<w/2-.6;xx+=step){
    for(const s of [-1,1]) {
      b.box(x+xx,h*.68,z+s*(d*.5+.05),Math.min(step-1,w/4),1.55,.11,(Math.round(xx+variant*11)%9===0)?windowLit:windowGlass);
      b.box(x+xx+.95,h*.68,z+s*(d*.5+.12),.09,1.54,.06,steel);
      b.box(x+xx,h*.68,z+s*(d*.5+.13),2.6,.085,.09,steel);
      b.box(x+xx,h*.46,z+s*(d*.5+.07),.14,h*.88,.18,steel);
    }
  }
  for(let zz=-d/2+1.5;zz<d/2-.9;zz+=3.15) {
    for(const s of [-1,1]){
      b.box(x+s*(w/2+.045),h*.72,z+zz,.11,1.18,2.35,(Math.round(zz*3+variant)%7===0)?windowLit:windowGlass);
      b.box(x+s*(w/2+.10),h*.72,z+zz,.08,1.21,.1,iron);
      b.box(x+s*(w/2+.065),h*.48,z+zz-1.45,.12,h*.92,.13,steel);
    }
  }
  // Profiled roll-up doors and a sun-faded nameplate on the track-facing wall.
  for(let i=0;i<2;i++){
    const zz=z+d*(i*.38-.2), dh=Math.min(4.1,h*.55), dw=Math.min(5,d*.26);
    b.box(x-w/2-.09,dh*.5,zz,.18,dh,dw,iron);
    for(let j=.3;j<dh;j+=.39)b.box(x-w/2-.19,j,zz,.08,.07,dw,steel);
    b.box(x-w/2-.34,dh+.25,zz,.7,.14,dw+.65,roof);
  }
  b.plane(x-w/2-.19,h*.82,z,Math.min(13,d*.66),Math.min(2.1,h*.24),[steelworks,foundry,dock][variant%3],-Math.PI/2);
  b.plane(x+w*.28,h*.31,z-d/2-.08,2.3,2.5,factoryTag,Math.PI);
  if(h>7){
    // Vents and exposed service pipes break up long corrugated facades.
    for(const sign of [-1,1]){
      const xx=x+sign*(w/2+.3);
      b.box(xx,h*.42,z,.29,.30,d*.9,steel);
      for(let q=0;q<3;q++){
        const zz=z+(q-1)*d*.29;
        b.cyl(xx,2.23,zz,.15,4.5,steel);
        b.box(xx,h*.42,zz,.42,.43,.35,rust);
      }
    }
    for(let k=-1;k<=1;k++){
      const xx=x+k*w*.25;
      b.box(xx,h+.71,z,w*.19,1.28,d*.55,grime);
      b.box(xx,h+1.43,z,w*.21,.18,d*.57,roof);
      b.box(xx,h+1.03,z-d*.278,w*.16,.55,.09,windowLit);
    }
  }
}

// A small corrugated-metal texture gives scale to container sides at a
// distance where modeling the ribs alone would disappear into subpixels.
function corrugated(color) {
  const map=textureCanvas(256,96,(ctx,w,h)=>{
    ctx.fillStyle=color;ctx.fillRect(0,0,w,h);
    for(let x=0;x<w;x+=10){
      ctx.fillStyle='rgba(5,15,18,.29)';ctx.fillRect(x,0,2,h);
      ctx.fillStyle='rgba(255,235,207,.17)';ctx.fillRect(x+2,0,2,h);
    }
    const rng=random(72);
    for(let k=0;k<130;k++){
      const y=rng()*h;
      ctx.fillStyle=k%2?'rgba(91,46,25,.24)':'rgba(225,207,165,.11)';
      ctx.fillRect(rng()*w,y,1+rng()*2,1+rng()*14);
    }
    ctx.fillStyle='rgba(31,26,25,.24)';ctx.fillRect(0,0,w,3);ctx.fillRect(0,h-3,w,3);
  });
  const material=new THREE.MeshLambertMaterial({map,side:THREE.DoubleSide});
  material.userData.castsShadow=true;
  return material;
}
function container(b,x,z,w,d,h,heading,col,idx) {
  const c=Math.cos(heading),s=Math.sin(heading);
  const pt=(xx,zz)=>[x+xx*c+zz*s,z-xx*s+zz*c];
  const box=(xx,y,zz,ww,hh,dd,m)=>{
    const [px,pz]=pt(xx,zz);b.box(px,y,pz,ww,hh,dd,m,heading);
  };
  box(0,h*.5,0,w,h,d,col);
  const side=d>w;
  const length=side?d:w;
  for(let k=-length/2+.3;k<length/2-.14;k+=.67){
    for(const sign of [-1,1]) {
      if(side) box(sign*(w*.5+.035),h*.5,k,.08,h*.9,.075,col);
      else box(k,h*.5,sign*(d*.5+.035),.075,h*.9,.08,col);
    }
  }
  for(const sign of [-1,1]){
    for (const yy of [.12,h-.12]) {
      if(side) box(sign*(w*.5+.045),yy,0,.1,.13,d+.08,iron);
      else box(0,yy,sign*(d*.5+.045),w+.08,.13,.1,iron);
    }
  }
  for(const k of [-1,1]){
    const [px,pz]=pt(side?k*(w/2+.095):0,side?0:k*(d/2+.095));
    b.plane(px,h*.6,pz,length*.67,h*.42,shipMarks[idx%3],heading+(side?k*Math.PI/2:k===1?0:Math.PI));
    for(const j of [-1,1]){
      box(side?j*w*.29:k*(w/2+.06),h*.5,side?k*(d/2+.06):j*d*.29,side?.07:.1,h*.9,side?.10:.07,steel);
    }
  }
}

function crane(b,x,z,h,angle) {
  const s=Math.sin(angle),c=Math.cos(angle);
  const pt=(xx,y,zz)=>[x+xx*c+zz*s,y,z-xx*s+zz*c];
  const beam=(a,bb,w,d,m)=>b.beam(pt(...a),pt(...bb),w,d,m);
  const beamCol=paint('#a4673f');
  for(const k of [-1,1]) for(const j of [-1,1]) beam([k*5,0,j*4],[k*2.1,h,j*2.1],.53,.53,beamCol);
  for(let i=1;i<5;i++) {
    const yy=i*h/5, yn=(i+1)*h/5, v=5-(yy/h)*2.9, v2=5-(yn/h)*2.9;
    for(const k of [-1,1]){
      beam([-v,yy,k*v*.81],[v2,yn,k*v2*.81],.25,.22,rust);
      beam([-v,yy,k*v*.81],[v,yy,k*v*.81],.28,.38,beamCol);
    }
  }
  let [ax,ay,az]=pt(0,h,0); b.box(ax,ay,az,6,1.4,6,steel,angle);
  [ax,ay,az]=pt(-1.2,h+1.6,-1);b.box(ax,ay,az,3,2.4,3.7,amber,angle);
  for(const j of [-1,1]){
    beam([j*1.6,h,1],[j*.7,h+9,22],.31,.33,beamCol);
    beam([j*1.6,h+3,0],[j*.7,h+9.72,22],.27,.3,beamCol);
    for(let k=0;k<6;k++){
      const t=k/6,u=(k+1)/6;
      beam([j*(1.6-.9*t),h+3+6.72*t,22*t],[j*(1.6-.9*u),h+9*u,22*u],.18,.17,rust);
    }
  }
  beam([0,h+9.3,22],[0,h-1.5,22],.08,.08,iron);
  [ax,ay,az]=pt(0,h-1.5,22);b.box(ax,ay,az,.6,.8,.5,iron);
}

function barriers(b,x,z,w,d,h,heading=0) {
  b.box(x,h*.37,z,w,h*.72,d,concrete,heading);
  b.box(x,h*.78,z,w*.65,h*.49,d,concrete,heading);
  const c=Math.cos(heading),s=Math.sin(heading);
  for(const k of [-1,1]) {
    b.plane(x+k*w*.345*c,h*.8,z-k*w*.345*s,d*.95,h*.28,hazard,heading+k*Math.PI/2);
  }
}

function lamp(b,x,z,heading=0) {
  const c=Math.cos(heading),s=Math.sin(heading);
  b.cyl(x,.48,z,.43,.96,concrete);
  b.cyl(x,4.3,z,.108,8.3,iron);
  b.beam([x,8.3,z],[x+c*1.8,9.12,z+s*1.8],.15,.15,iron);
  b.box(x+c*1.9,9.06,z+s*1.9,1.04,.2,.53,iron, -heading);
  b.box(x+c*1.95,8.93,z+s*1.95,.83,.035,.4,paint('#f6d899',true),-heading);
}

function gates(b) {
  const topSigns=[label('CHECKPOINT','#29332c','#dbc996',{frame:true}),
    label('START   /   FINISH','#33382f','#e5d7ac',{frame:true}),
    label('PORT  AUTHORITY','#493d31','#d7bf95',{frame:true})];
  CHECKPOINTS.forEach((g,i)=>{
    const c=Math.cos(g.heading),s=Math.sin(g.heading);
    const at=(x,y,z)=>[g.x+x*c+z*s,y,g.z-x*s+z*c];
    const cube=(x,y,z,w,h,d,m)=>b.box(...at(x,y,z),w,h,d,m,g.heading);
    const beam=(a,bb,w,d,m)=>b.beam(at(...a),at(...bb),w,d,m);
    const cross=i===0 || i===4 || i===9;
    for(const sign of [-1,1]){
      const px=sign*(ROAD_WIDTH/2+1.1);
      cube(px,.46,0,.82,.92,.89,grime);
      cube(px,cross?3.7:2.25,0,.3,cross?7.4:4.5,.36,steel);
      cube(px,.96,0,.38,1.25,.46,amber);
      for(const zz of [-1,1]) {
        if(cross) beam([px,.4,zz*1.05],[px,6.32,0],.18,.2,rust);
      }
      if(!cross) {
        const panelAt=at(px,3.54,-.07);
        b.plane(...panelAt,1.35,1.3,numberSigns[i],g.heading+Math.PI);
        cube(px,4.5,0,.5,.2,.46,amber);
      }
    }
    if(cross){
      const hw=ROAD_WIDTH/2+1.1;
      for(const yy of [6.4,7.57]) for(const zz of [-.35,.35]) cube(0,yy,zz,hw*2+.5,.19,.18,iron);
      for(let seg=0;seg<11;seg++) {
        const x=-hw+seg*2*hw/11,xx=x+2*hw/11;
        for(const zz of [-.32,.32]) beam([x,6.45,zz],[xx,7.5,zz],.12,.13,rust);
      }
      const sign=i===9?topSigns[1]:i===0?topSigns[0]:topSigns[2];
      const pos=at(0,7.03,-.55);b.plane(...pos,10.4,1.72,sign,g.heading+Math.PI);
      for(const k of [-1,1]) {
        cube(k*7.1,6.82,-.52,1.66,.44,.25,iron);
        for(const j of [-.5,0,.5]) cube(k*7.1+j,6.82,-.68,.27,.24,.1,paint('#edac4e',true));
      }
    }
    if(i===9){
      for(let a=-11;a<11;a++)for(let j=0;j<2;j++){
        cube(a+.5,.046,j-.5,1,.017,1,(a+j)%2===0?offwhite:grime);
      }
    } else {
      cube(0,.043,0,ROAD_WIDTH-.9,.015,.24,paint('#ab9b72'));
    }
  });
}
const numberSigns=CHECKPOINTS.map((g,i)=>label(String(i+1).padStart(2,'0'),'#3a3c34','#deba6e',{w:80,h:80,size:.76,frame:true}));

function buildEnvironment(scene,b) {
  mountains(b);
  const smoke=[],rng=random(33012);
  let containerN=0;
  const containerColors=['#a95d40','#4e6e70','#8c7960','#ac694b','#768075'].map(corrugated);
  for(const p of PROPS){
    switch(p.type){
      case 'factory':
        warehouse(b,p.x,p.z,p.width,p.length,11.3);
        for(const k of [-1,1]) chimney(b,p.x+p.width*.32,p.z+k*p.length*.33,1.12,k===1?24:21,smoke);
        break;
      case 'workshop': warehouse(b,p.x,p.z,p.width,p.length,5.5,1); break;
      case 'tank': tank(b,p.x,p.z,p.r,p.r*1.55);break;
      case 'container': {
        const h=3.7;
        container(b,p.x,p.z,p.width,p.length,h,p.heading,containerColors[containerN%5],containerN);
        containerN++;
        break;
      }
      case 'drums':
        [[-.67,-.54],[.74,-.43],[-.15,.7]].forEach(([dx,dz],i)=>{
          const x=p.x+dx,z=p.z+dz, c=i===1?rust:paint('#9d6343');
          b.cyl(x,.71,z,.60,1.42,c);
          for(const y of [.12,.49,1.02,1.39])b.cyl(x,y,z,.619,.07,iron);
          b.cyl(x+.22,1.43,z+.16,.11,.03,grime);
        });
        break;
      case 'barrier':barriers(b,p.x,p.z,p.width,p.length,1.18,p.heading);break;
    }
  }
  // Power lines sag between three-bay timber poles along the port perimeter.
  for(const side of [-1,1]){
    const x=side*94;
    for(let j=0;j<6;j++){
      const z=-103+j*42, height=13+(j%2)*.4;
      b.cyl(x,height*.5,z,.21,height,grime);
      b.box(x,height-.35,z,3.7,.22,.22,grime);
      for(const k of [-1,0,1]){
        const xx=x+k*1.49;
        b.cyl(xx,height+.05,z,.12,.46,offwhite);
        if(j===5)continue;
        for(let n=0;n<5;n++){
          const q=n/5,r=(n+1)/5, nextHeight=13+((j+1)%2)*.4;
          const wireY=(t)=>height+(nextHeight-height)*t-1.25*4*t*(1-t);
          b.beam([xx,wireY(q),z+42*q],[xx,wireY(r),z+42*r],.055,.055,iron);
        }
      }
    }
  }
  const {minX,maxX,minZ,maxZ}=BOUNDS;
  // The concrete wall follows the playable boundary around the entire yard.
  for(const x of [minX-1,maxX+1]) for(let z=minZ;z<=maxZ;z+=8) barriers(b,x,z,1.65,7.75,1.45);
  for(const z of [minZ-1,maxZ+1]) for(let x=minX;x<=maxX;x+=8) barriers(b,x,z,1.65,7.75,1.45,Math.PI/2);
  for(let z=-102;z<112;z+=21){lamp(b,-83,z);lamp(b,85,z,Math.PI);}
  for(let x=-76;x<84;x+=23){lamp(b,x,108,-Math.PI/2);lamp(b,x,-109,Math.PI/2);}
  // Larger working structures beyond the wall give every driving direction a skyline.
  for(let i=0;i<4;i++) {
    const z=-91+i*57;
    warehouse(b,-111,z,22,33,9+rng()*7,i%3);
    warehouse(b,114,z+12,29,36,8+rng()*9,(i+2)%3);
  }
  for(const z of [143,-144]) for(let i=0;i<3;i++)
    warehouse(b,-63+i*65,z+7*rng(),35+rng()*9,22+rng()*12,8+rng()*7,i);
  for(const [x,z,r,h] of [[-114,74,2.2,36],[-121,66,1.9,43],[101,78,2.3,29],[119,-39,2,34],[-25,-151,2.2,38],[44,147,3,35],[60,148,2.5,32]])
    chimney(b,x,z,r,h,smoke);
  for(const [x,z,r,h] of [[-102,-106,8,10],[-118,-103,7,12],[100,23,7,13],[121,-81,8,11],[-59,132,8,15],[-44,130,6,12],[84,120,7,10],[46,-142,7,10]]) tank(b,x,z,r,h,false);
  for(const [x,z,h,a] of [[-93,89,29,1.14],[85,120,36,-.62],[-93,-73,29,1.46],[105,-100,25,-1.1]])
    crane(b,x,z,h,a);
  // Roadside billboard outside the collision wall, readable on the opening straight.
  for(const [x,z,angle,mat] of [[-76,118,-.19,district],[90,-87,-1.4,dock],[45,-122,Math.PI,steelworks]]){
    const c=Math.cos(angle),s=Math.sin(angle);
    for(const k of [-5,5]) b.box(x+k*c,5,z-k*s,.38,10,.44,steel,angle);
    b.box(x,10,z,17,3.8,.42,iron,angle);
    b.plane(x-s*.24,10,z-c*.24,16.75,3.65,mat,angle+Math.PI);
  }
  gates(b);
  return smoke;
}

function loft(sections) {
  const pos=[],uv=[];
  const rings=sections.map(([z,w,deck,sill])=>[
    [-w*.87,.46,z],[-w,sill,z],[-w*.96,deck-.085,z],[-w*.81,deck,z],
    [w*.81,deck,z],[w*.96,deck-.085,z],[w,sill,z],[w*.87,.46,z]
  ]);
  const tri=(a,b,c)=>{pos.push(...a,...b,...c);uv.push(0,0,0,1,1,0);};
  for(let k=0;k<rings.length-1;k++) for(let i=0;i<8;i++){
    const j=(i+1)%8; tri(rings[k][i],rings[k+1][i],rings[k][j]);
    tri(rings[k][j],rings[k+1][i],rings[k+1][j]);
  }
  for(const k of [0,rings.length-1]) for(let i=1;i<7;i++)tri(rings[k][0],rings[k][i],rings[k][i+1]);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.computeVertexNormals();return g;
}

function panel(b,points,mat) {
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute([...points[0],...points[1],...points[3],...points[1],...points[2],...points[3]],3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1,1,0,1,1,0,1],2));g.computeVertexNormals();
  b.add(g,mat,0,0,0);
}

const carShadow=new THREE.MeshBasicMaterial({map:textureCanvas(96,152,(ctx,w,h)=>{
  ctx.scale(w,h);const g=ctx.createRadialGradient(.5,.5,.19,.5,.5,.52);
  g.addColorStop(0,'rgba(26,24,21,.78)');g.addColorStop(.65,'rgba(26,24,21,.65)');g.addColorStop(1,'rgba(26,24,21,0)');
  ctx.fillStyle=g;ctx.fillRect(0,0,1,1);
}),transparent:true,depthWrite:false});
const tire=paint('#222222'), rims=paint('#77766f'), highlight=paint('#c3b9a2');
const glass=new THREE.MeshPhongMaterial({color:'#405861',emissive:'#142026',specular:'#c6b3a3',shininess:18,side:THREE.DoubleSide,flatShading:true}), glassGlint=paint('#778782'), rearLight=paint('#fa4932',true);
const carNumbers=['07','12','33','66'];
const sideNumbers=carNumbers.map(n=>label(n,null,'#f1e0b4',{w:120,h:80,size:.92,italic:true}));
const rearPlates=carNumbers.map(n=>label('WD  '+n,'#d2bd8d','#302d29',{w:128,h:42,size:.81}));
const flameGeo=new THREE.ConeGeometry(.144,1.2,7);
flameGeo.translate(0,.6,0);flameGeo.rotateX(-Math.PI/2);

function makeCar(hero,index,color) {
  const root=new THREE.Group(), body=new THREE.Group(), b=new Batch();
  const carIndex=hero?0:1+index;
  root.add(body);
  const shell=paint(hero?'#9e3022':color), darkTrim=paint(hero?'#652b25':'#4d4340');
  const stripe=hero?paint('#e1cda3'):paint('#292a26');
  const sections=[[-2.49,1.06,1.08,.68],[-2.11,1.25,1.20,.72],[-1.38,1.28,1.19,.73],[-.58,1.19,1.13,.68],[.78,1.18,1.11,.68],[1.48,1.29,1.14,.72],[2.10,1.24,1.075,.68],[2.48,1.05,.94,.61]];
  b.add(loft(sections),shell,0,0,0);
  // Wide fender shoulders surround a narrower, raked glasshouse.
  const base=[[-.99,1.13,-1.64],[.99,1.13,-1.64],[1.02,1.12,.74],[-1.02,1.12,.74]];
  const top=[[-.74,1.81,-.82],[.74,1.81,-.82],[.75,1.80,.02],[-.75,1.80,.02]];
  for(let k=0;k<4;k++) {
    const j=(k+1)%4;panel(b,[base[k],base[j],top[j],top[k]],glass);
    b.beam(base[k],top[k],.095,.095,shell);
    b.beam(top[k],top[j],.07,.09,shell);
  }
  panel(b,top,shell);
  for(const s of [-1,1]){
    b.beam([s*.99,1.15,-.44],[s*.746,1.79,-.44],.09,.11,dark);
    b.beam([s*1.04,1.13,.58],[s*1.14,1.28,.58],.08,.08,iron);
    b.box(s*1.18,1.30,.58,.22,.14,.24,darkTrim);
    b.box(s*1.225,.62,-.03,.09,.16,1.86,darkTrim);
    b.box(s*1.203,1.04,-.67,.04,.052,.22,highlight);
    for(const z of [-1.53,1.47]){
      const xx=s*1.19;
      b.cyl(xx,.57,z,.57,.34,tire,0,0,Math.PI/2);
      b.cyl(s*1.369,.57,z,.373,.035,rims,0,0,Math.PI/2);
      b.cyl(s*1.392,.57,z,.27,.03,iron,0,0,Math.PI/2);
      b.cyl(s*1.411,.57,z,.12,.045,highlight,0,0,Math.PI/2);
      for(let k=0;k<5;k++){
        const a=TAU*k/5;
        b.box(s*1.417,.57+Math.sin(a)*.19,z+Math.cos(a)*.19,.018,.075,.1,rims,0,-a);
      }
    }
    // Thin steel push bars protect the front lamps and wrap the back corners.
    b.beam([s*1.08,.72,2.41],[s*.78,.76,2.62],.12,.11,grime);
    b.box(s*.78,.944,2.457,.39,.155,.075,paint('#fdd499',true));
    b.box(s*.78,.975,2.507,.048,.20,.051,steel);
    b.box(s*.80,.945,-2.478,.54,.16,.046,rearLight);
    for(let k=0;k<3;k++) b.box(s*(.59+k*.18),.945,-2.51,.045,.17,.035,iron);
    b.cyl(s*.83,.45,-2.48,.131,.42,steel,0,Math.PI/2);
    b.cyl(s*.83,.45,-2.702,.095,.026,dark,0,Math.PI/2);
    // Paired cream stripes taper across hood, roof and trunk.
    for(const [[z1,y1],[z2,y2]] of [[[.73,1.126],[1.48,1.154]],[[1.48,1.154],[2.10,1.09]],[[2.10,1.09],[2.45,.965]],[[-2.46,1.099],[-2.11,1.215]],[[-2.11,1.215],[-1.63,1.207]],[[-.82,1.831],[.02,1.821]]]){
      const x=s*.255, hw=.132;
      panel(b,[[x-hw,y1,z1],[x+hw,y1,z1],[x+hw,y2,z2],[x-hw,y2,z2]],stripe);
    }
    b.plane(s*1.201,.90,-.015,.94,.47,sideNumbers[carIndex],s*Math.PI/2);
  }
  b.box(0,.70,-2.515,2.21,.17,.17,grime);
  b.box(0,.72,2.52,1.75,.13,.15,steel);
  b.box(0,.915,2.482,.96,.18,.06,dark);
  for(let k=-4;k<=4;k++)b.box(k*.099,.915,2.523,.023,.145,.03,rims);
  b.plane(0,.899,-2.507,.47,.19,rearPlates[carIndex],Math.PI);
  b.box(0,.52,0,1.85,.19,3.85,dark);
  if(hero||index===0){
    // External blower, pulley and three circular black air intake butterflies.
    b.box(0,1.26,1.30,.64,.30,.68,steel);
    b.box(0,1.45,1.32,.76,.16,.51,highlight);
    b.box(0,1.43,1.605,.68,.19,.07,dark);
    for(const x of [-.23,0,.23])b.cyl(x,1.44,1.66,.082,.065,iron,0,Math.PI/2);
    for(const s of [-1,1]) b.beam([s*.68,1.20,-1.74],[s*.58,1.23,-2.18],.07,.07,iron);
  }
  // Rear window louvers provide a strong chase-camera silhouette.
  for(let k=1;k<=4;k++){
    const t=k/5, w=(.99+(.74-.99)*t)*2;
    b.box(0,1.155+t*.68,-1.645+t*.82,w,.055,.094,iron);
  }
  b.beam([-.653,1.72,.13],[-.27,1.45,.44],.038,.034,glassGlint);
  for(const s of [-1,1]) b.box(s*.75,1.24,-2.15,.095,.16,.23,iron);
  b.box(0,1.347,-2.16,2.34,.1,.32,darkTrim);
  b.finish(body);
  for(const mesh of body.children)mesh.receiveShadow=true;
  const shadow=new THREE.Mesh(unitPlane,carShadow);
  shadow.rotation.x=-Math.PI/2;shadow.position.y=.065;shadow.scale.set(3.6,6.12,1);root.add(shadow);
  const flames=new THREE.Group();
  for(const s of [-1,1]){
    const f=new THREE.Mesh(flameGeo,paint('#ff9b32',true));f.position.set(s*.83,.45,-2.71);flames.add(f);
    const core=new THREE.Mesh(flameGeo,paint('#fff0a4',true)); core.scale.set(.62,.62,.58);core.position.copy(f.position);flames.add(core);
  }
  root.add(flames);root.userData={body,flames};return root;
}

function smokeTexture() {
  return textureCanvas(64,64,(ctx)=>{
    const rng=random(719);
    for(let i=0;i<15;i++){
      const a=rng()*TAU,d=rng()*12,r=10+rng()*9;
      const x=32+Math.sin(a)*d,y=32+Math.cos(a)*d;
      const g=ctx.createRadialGradient(x,y,0,x,y,r);
      g.addColorStop(0,'rgba(230,224,213,.62)');g.addColorStop(.56,'rgba(221,215,211,.28)');g.addColorStop(1,'rgba(216,207,201,0)');
      ctx.fillStyle=g;ctx.fillRect(0,0,64,64);
    }
  });
}

function effects(scene,stacks) {
  const map=smokeTexture(), rng=random(72883);
  const stackMat=new THREE.MeshBasicMaterial({map,color:'#726264',transparent:true,opacity:.32,depthWrite:false});
  const stackCount=stacks.length*7;
  const stackMesh=new THREE.InstancedMesh(unitPlane,stackMat,stackCount);
  stackMesh.frustumCulled=false;stackMesh.renderOrder=1;scene.add(stackMesh);
  const smokeMat=new THREE.MeshBasicMaterial({map,color:'#ac9b83',transparent:true,opacity:.48,depthWrite:false});
  const puffs=new THREE.InstancedMesh(unitPlane,smokeMat,96);puffs.frustumCulled=false;puffs.renderOrder=2;puffs.count=0;scene.add(puffs);
  const sparkMat=paint('#ffbf58',true);
  const sparks=new THREE.InstancedMesh(unitBox,sparkMat,120);sparks.frustumCulled=false;sparks.count=0;scene.add(sparks);
  const skidMat=new THREE.MeshBasicMaterial({color:'#292727',transparent:true,opacity:.46,depthWrite:false});
  const skids=new THREE.InstancedMesh(unitPlane,skidMat,260);skids.frustumCulled=false;skids.count=0;scene.add(skids);
  const smoke=[],spark=[],trail=new Map();
  let stamp=0,previousState=null,lastElapsed=-1;
  const pushSmoke=(x,y,z,s,darkness=0)=>{
    if(smoke.length<96)smoke.push({x,y,z,s,life:0,duration:.6+rng()*.55+darkness,
      dx:(rng()-.5)*1.5,dy:.5+darkness*1.4,dz:(rng()-.5)*1.2});
  };
  function update(state,t,dt,cam,reduced) {
    stackMesh.visible=!reduced;puffs.visible=!reduced;sparks.visible=!reduced;skids.visible=!reduced;
    if(reduced)return;
    if(state!==previousState){
      skids.count=0;stamp=0;smoke.length=0;spark.length=0;trail.clear();
      previousState=state;lastElapsed=-1;
    }
    let idx=0;
    stacks.forEach((st,i)=>{
      for(let j=0;j<7;j++){
        const v=((t*.11+j/7+i*.21)%1), amt=st.scale;
        tempObject.position.set(st.x+v*v*12*amt,st.y+v*12*amt,st.z+Math.sin(i+j+v)*v*amt);
        tempObject.quaternion.copy(cam.quaternion);
        const sz=(2.5+v*7)*amt;tempObject.scale.set(sz,sz*.8,sz);tempObject.updateMatrix();
        stackMesh.setMatrixAt(idx++,tempObject.matrix);
      }
    });
    stackMesh.instanceMatrix.needsUpdate=true;
    if(state.elapsed!==lastElapsed){
      lastElapsed=state.elapsed;
      for(const e of state.events||[]){
        if(!['impact','hit','wreck','crash','ram','collision'].includes(e.type))continue;
        for(let k=0;k<(e.type==='wreck'?30:12) && spark.length<120;k++){
          const a=rng()*TAU,v=2+rng()*8;
          spark.push({x:e.x,y:.6+rng()*.6,z:e.z,dx:Math.sin(a)*v,dy:1+rng()*4,dz:Math.cos(a)*v,life:.3+rng()*.35});
        }
      }
    }
    for(const car of [state.player,...state.rivals]){
      const s=Math.sin(car.heading),c=Math.cos(car.heading), x=car.x-s*1.56,z=car.z-c*1.56;
      let prev=trail.get(car.id),dist=prev?Math.hypot(x-prev.x,z-prev.z):0;
      if((car.skid>.14||car.boosting)&&rng()<dt*(car.boosting?8:18))pushSmoke(x+c*(rng()>.5?1:-1),.3,z-s*(rng()>.5?1:-1),.6+car.skid);
      if(car.health<43&&rng()<dt*(car.alive?9:19))pushSmoke(car.x+s*1.3,1.35,car.z+c*1.3,.7,car.alive?.4:.9);
      if(car.skid>.17 && dist>.37&&dist<4){
        const heading=Math.atan2(x-prev.x,z-prev.z);
        for(const sign of [-1,1]){
          tempObject.position.set((x+prev.x)/2+c*sign*1.13,.061,(z+prev.z)/2-s*sign*1.13);
          tempObject.rotation.set(-Math.PI/2,heading,0,'YXZ');tempObject.scale.set(.28,dist+.06,1);tempObject.updateMatrix();
          skids.setMatrixAt(stamp%260,tempObject.matrix);stamp++;
        }
        skids.count=Math.min(260,stamp);skids.instanceMatrix.needsUpdate=true;
      }
      if(!prev||dist>.37) trail.set(car.id,{x,z});
    }
    idx=0;
    for(let i=smoke.length-1;i>=0;i--){
      const p=smoke[i];p.life+=dt;
      if(p.life>p.duration){smoke.splice(i,1);continue;}
      p.x+=p.dx*dt;p.y+=p.dy*dt;p.z+=p.dz*dt;
      const q=p.life/p.duration, size=p.s*(.45+1.6*q)*(1-Math.pow(q,3));
      tempObject.position.set(p.x,p.y,p.z);tempObject.quaternion.copy(cam.quaternion);
      tempObject.scale.setScalar(size);tempObject.updateMatrix();puffs.setMatrixAt(idx++,tempObject.matrix);
    }
    puffs.count=idx;puffs.instanceMatrix.needsUpdate=true;
    idx=0;
    for(let i=spark.length-1;i>=0;i--){
      const p=spark[i];p.life-=dt;if(p.life<0){spark.splice(i,1);continue;}
      p.dy-=8*dt;p.x+=p.dx*dt;p.y=Math.max(.12,p.y+p.dy*dt);p.z+=p.dz*dt;
      tempObject.position.set(p.x,p.y,p.z);tempObject.rotation.set(.3,Math.atan2(p.dx,p.dz),.2);
      tempObject.scale.set(.048,.048,.4);tempObject.updateMatrix();sparks.setMatrixAt(idx++,tempObject.matrix);
    }
    sparks.count=idx;sparks.instanceMatrix.needsUpdate=true;
  }
  return update;
}

export function createWorld(canvas) {
  const renderer = new THREE.WebGLRenderer({canvas,alpha:false,antialias:true,powerPreference:'high-performance'});
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  const scene=new THREE.Scene();
  scene.fog=new THREE.FogExp2(0xc49980,.0058);
  const skyDome=sky(scene);
  scene.add(new THREE.HemisphereLight(0xe2e6eb,0x957e6e,1.34));
  const sun=new THREE.DirectionalLight(0xffdfb6,1.72);sun.position.set(-140,196,144);scene.add(sun);
  // The architecture never moves. Bake this light's depth map on the first
  // frame and reuse it while the cars cast their inexpensive contact shadows.
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
  sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);
  Object.assign(sun.shadow.camera,{left:-165,right:165,top:160,bottom:-160,near:60,far:510});
  sun.shadow.camera.updateProjectionMatrix();sun.shadow.bias=-.0003;sun.shadow.normalBias=.12;
  const bounce=new THREE.DirectionalLight(0xa7c1c4,.53);bounce.position.set(53,27,-61);scene.add(bounce);
  const b=new Batch();
  buildRoad(scene,b);
  const stacks=buildEnvironment(scene,b);
  const shadowMat=new THREE.MeshBasicMaterial({color:'#3d3530',transparent:true,opacity:.22,depthWrite:false});
  for(const p of PROPS){
    b.plane(p.x+.7,.015,p.z-.5,p.width+1.2,p.length+1,shadowMat,p.heading,-Math.PI/2);
  }
  b.finish(scene);
  for(const mesh of scene.children){
    if(!mesh.isMesh || !mesh.material?.isMeshLambertMaterial)continue;
    mesh.receiveShadow=true;
    mesh.castShadow=Boolean(mesh.material.userData.castsShadow)||(!mesh.material.map && mesh.geometry.attributes.position.count>24);
  }
  const camera=new THREE.PerspectiveCamera(61,1,.16,570);
  const actors = new Map(), updateEffects=effects(scene,stacks);
  const marker=new THREE.Group(), arrow=new THREE.Shape();
  arrow.moveTo(-.86,.65);arrow.lineTo(0,.02);arrow.lineTo(.86,.65);arrow.lineTo(.86,.10);arrow.lineTo(0,-.58);arrow.lineTo(-.86,.10);arrow.closePath();
  const arrowGeo=new THREE.ShapeGeometry(arrow), markMat=paint('#ffe49a',true);
  for(let n=0;n<2;n++){
    const m=new THREE.Mesh(arrowGeo,markMat);m.position.y=n*.75;marker.add(m);
  }
  scene.add(marker);
  let previousMode='',lastState=null,elapsed=0,lastTime=0,lastWidth=0,lastHeight=0;
  let camHeading=0,camFov=61;
  const focus=new THREE.Vector3(),target=new THREE.Vector3();
  function resize(force=false){
    const width=Math.max(1,canvas.clientWidth),height=Math.max(1,canvas.clientHeight);
    if(!force&&lastWidth===width&&lastHeight===height)return;
    lastWidth=width;lastHeight=height;
    const dpr=Math.min(window.devicePixelRatio||1,1.65,Math.sqrt(1580000/(width*height)));
    renderer.setPixelRatio(dpr);renderer.setSize(width,height,false);
    camera.aspect=width/height;camera.updateProjectionMatrix();
  }
  function render(state,options={}){
    if(!state?.player)return;
    resize();
    const now=performance.now()/1000;
    const dt=Math.min(.1,Math.max(0,options.dt??(lastTime?now-lastTime:1/60)));lastTime=now;
    elapsed=Number.isFinite(options.time)?options.time:elapsed+dt;
    const mode=options.mode||'play',p=state.player, reduced=Boolean(options.reducedMotion);
    const snap=mode!==previousMode||lastState!==state;previousMode=mode;lastState=state;
    [p,...state.rivals].forEach((car,i)=>{
      if(!actors.has(car.id)){
        const actor=makeCar(i===0,i-1,car.color);scene.add(actor);actors.set(car.id,actor);
      }
      const obj=actors.get(car.id),{body,flames}=obj.userData;
      obj.position.set(car.x,0,car.z);obj.rotation.y=car.heading;
      body.rotation.z=car.alive?(reduced?0:Math.max(-.05,Math.min(.05,(car.steering||0)*Math.abs(car.speed)*.002))):.095;
      body.position.y=car.alive?(reduced?0:Math.sin(elapsed*34)*Math.min(Math.abs(car.speed)*.00045,.022)):-.12;
      if((obj.userData.dead||false)===car.alive){
        obj.userData.dead=!car.alive;
        for(const mesh of body.children){
          mesh.userData.originalMat??=mesh.material;
          mesh.material=car.alive?mesh.userData.originalMat:(mesh.material===rearLight?dark:paint('#4b4139'));
        }
      }
      flames.visible=car.boosting;flames.scale.z=reduced?1:1+Math.sin(elapsed*59)*.11;
    });
    const portrait=camera.aspect<1;
    if(mode==='attract'){
      const a=p.heading+.83+(reduced?0:Math.sin(elapsed*.17)*.28),dist=portrait?8:6.8;
      camera.position.set(p.x+Math.sin(a)*dist,2.25,p.z+Math.cos(a)*dist);
      camera.lookAt(p.x,.98,p.z);camFov=portrait?56:48;
    }else{
      if(snap)camHeading=p.heading;
      const turn=Math.atan2(Math.sin(p.heading-camHeading),Math.cos(p.heading-camHeading));
      camHeading+=turn*(1-Math.exp(-dt*8));
      const s=Math.sin(camHeading),c=Math.cos(camHeading),v=Math.min(Math.abs(p.speed)/45,1);
      const dist=(portrait?9:7.9)+v*.85;
      target.set(p.x-s*dist,(portrait?4.35:3.62)+v*.3,p.z-c*dist);
      if(snap)camera.position.copy(target);
      else camera.position.lerp(target,1-Math.exp(-dt*15));
      focus.set(p.x+s*(6.9+v*2.2),1.42,p.z+c*(6.9+v*2.2));camera.lookAt(focus);
      const fov=(portrait?67:59)+(reduced?0:v*3.5+(p.boosting?6:0));
      camFov=snap?fov:camFov+(fov-camFov)*(1-Math.exp(-dt*5));
    }
    if(Math.abs(camera.fov-camFov)>.02){camera.fov=camFov;camera.updateProjectionMatrix();}
    skyDome.position.copy(camera.position);
    const gate=CHECKPOINTS[state.checkpoint % CHECKPOINTS.length]||CHECKPOINTS[0];
    marker.position.set(gate.x,4.8+(reduced?0:Math.sin(elapsed*3)*.2),gate.z);
    marker.quaternion.copy(camera.quaternion);marker.visible=mode!=='attract';
    updateEffects(state,elapsed,dt,camera,reduced);
    renderer.render(scene,camera);
  }
  return {render,resize};
}
