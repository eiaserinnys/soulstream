import { MAX_WEBGL_GLASS_CARDS } from "./webgl-glass";

export const WEBGL_GLASS_VERTEX_SHADER = `#version 300 es
precision highp float;
const vec2 P[3] = vec2[3](vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
void main(){ gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }
`;

export const WEBGL_GLASS_FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform sampler2D uBg;
uniform int uCount;
uniform vec4 uCards[${MAX_WEBGL_GLASS_CARDS}];
uniform vec4 uClips[${MAX_WEBGL_GLASS_CARDS}];
uniform float uClipRadii[${MAX_WEBGL_GLASS_CARDS}];
uniform float uRadius, uDpr, uScale, uBlur, uAb, uRim, uGlass;
float sdRound(vec2 p, vec2 b, float r){ vec2 q=abs(p)-b+r; return min(max(q.x,q.y),0.0)+length(max(q,0.0))-r; }
float fCurve(float x){ return 1.0 - 2.3*pow(5.2*2.71828182845, -6.9*x - 0.7); }
float rand2(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233)))*43758.5453); }
float sat(float x){ return clamp(x,0.0,1.0); }
vec3 blurRGB(sampler2D t, vec2 c, float rpx, vec2 ipx){
  vec3 a = texture(t,c).rgb*0.196;
  for(int k=0;k<6;k++){ float ang=float(k)*1.0472; vec2 dir=vec2(cos(ang),sin(ang));
    a += texture(t, c+dir*(rpx*0.5)*ipx).rgb*0.090;
    a += texture(t, c+dir*(rpx*1.0)*ipx).rgb*0.044; }
  return a;
}
void main(){
  vec2 fragPx = gl_FragCoord.xy/uDpr; fragPx.y = uRes.y/uDpr - fragPx.y;
  vec2 uv = fragPx*uDpr/uRes;
  vec3 col = texture(uBg, uv).rgb;
  if(uGlass>0.5){
    for(int i=0;i<${MAX_WEBGL_GLASS_CARDS};i++){
      if(i>=uCount) break;
      vec4 cd=uCards[i]; vec2 center=cd.xy+cd.zw*0.5; vec2 hsz=cd.zw*0.5;
      vec4 cl=uClips[i];
      if(fragPx.x<cl.x || fragPx.y<cl.y || fragPx.x>cl.x+cl.z || fragPx.y>cl.y+cl.w) continue;
      float clipRadius=min(uClipRadii[i], min(cl.z, cl.w)*0.5);
      if(clipRadius>0.0){
        vec2 clipCenter=cl.xy+cl.zw*0.5;
        vec2 clipHalf=cl.zw*0.5;
        if(sdRound(fragPx-clipCenter, clipHalf, clipRadius)>0.0) continue;
      }
      vec2 lp=fragPx-center;
      if(abs(lp.x)>hsz.x || abs(lp.y)>hsz.y) continue;
      float R=min(uRadius, min(hsz.x,hsz.y));
      float d=sdRound(lp,hsz,R);
      if(d<0.0){
        float inside=-d; float distN=sat(inside/min(hsz.x,hsz.y));
        vec2 pn=lp/hsz;
        float factor=pow(fCurve(distN), max(0.2, uScale*0.08));
        vec2 ipx=uDpr/uRes; float edgeAmt=1.0-factor;
        vec2 uvG=(center+pn*factor*hsz)*uDpr/uRes;
        vec3 refr=blurRGB(uBg, uvG, uBlur*1.7, ipx);
        vec2 chrom=pn*(uAb*edgeAmt*14.0)*ipx; float fl=min(uBlur,4.0);
        refr.r=mix(refr.r, textureLod(uBg,uvG+chrom,fl).r, 0.75);
        refr.b=mix(refr.b, textureLod(uBg,uvG-chrom,fl).b, 0.75);
        refr += (rand2(fragPx*0.7)-0.5)*0.02;
        float luma=dot(refr,vec3(0.2126,0.7152,0.0722));
        refr=clamp(mix(vec3(luma),refr,1.4),0.0,1.0);
        float litEdge=smoothstep(0.30,0.0,distN);
        float lightFace=sat(dot(normalize(pn+1e-4),normalize(vec2(-0.6,-0.8))));
        refr += uRim*(litEdge*pow(lightFace,1.5))*0.6;
        refr += uRim*pow(sat(-pn.x*0.5-pn.y*0.5),3.0)*0.08;
        float aa=smoothstep(0.0, max(fwidth(d),1.0), -d);
        col=mix(col,refr,aa);
      }
    }
  }
  outColor=vec4(col,1.0);
}
`;
