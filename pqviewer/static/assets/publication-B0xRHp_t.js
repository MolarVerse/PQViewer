import{M as ht,O as Pt,B as Et,F as Ce,V as A,a as ue,b as et,D as pt,R as Ue,W as $e,H as Je,S as X,N as W,U as F,c as bt,A as Se,Z as xe,d as nt,e as ot,C as Dt,f as mt,g as Ct,h as Ut,i as At,j as rt,k as Nt,l as Rt,m as Ot,n as zt,o as Lt,L as It,p as Vt,q as Ft,r as jt,s as Bt,t as Gt,u as Ht,v as Wt,w as be,x as De,I as kt,y as Ke,z as Q,E as qt,G as tt,J as vt,K as he,P as Zt,Q as Xt}from"./three-DB1ptx6N.js";class it{constructor(){this.isPass=!0,this.enabled=!0,this.needsSwap=!0,this.clear=!1,this.renderToScreen=!1}setSize(){}render(){console.error("THREE.Pass: .render() must be implemented in derived pass.")}dispose(){}}const Yt=new Pt(-1,1,1,-1,0,1);class Qt extends Et{constructor(){super(),this.setAttribute("position",new Ce([-1,3,0,-1,-1,0,3,-1,0],3)),this.setAttribute("uv",new Ce([0,2,0,0,2,0],2))}}const $t=new Qt;class at{constructor(e){this._mesh=new ht($t,e)}dispose(){this._mesh.geometry.dispose()}render(e){e.render(this._mesh,Yt)}get material(){return this._mesh.material}set material(e){this._mesh.material=e}}const _e={defines:{PERSPECTIVE_CAMERA:1,SAMPLES:16,NORMAL_VECTOR_TYPE:1,DEPTH_SWIZZLING:"x",SCREEN_SPACE_RADIUS:0,SCREEN_SPACE_RADIUS_SCALE:100,SCENE_CLIP_BOX:0},uniforms:{tNormal:{value:null},tDepth:{value:null},tNoise:{value:null},resolution:{value:new et},cameraNear:{value:null},cameraFar:{value:null},cameraProjectionMatrix:{value:new ue},cameraProjectionMatrixInverse:{value:new ue},cameraWorldMatrix:{value:new ue},radius:{value:.25},distanceExponent:{value:1},thickness:{value:1},distanceFallOff:{value:1},scale:{value:1},sceneBoxMin:{value:new A(-1,-1,-1)},sceneBoxMax:{value:new A(1,1,1)}},vertexShader:`

		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`
		varying vec2 vUv;
		uniform highp sampler2D tNormal;
		uniform highp sampler2D tDepth;
		uniform sampler2D tNoise;
		uniform vec2 resolution;
		uniform float cameraNear;
		uniform float cameraFar;
		uniform mat4 cameraProjectionMatrix;
		uniform mat4 cameraProjectionMatrixInverse;
		uniform mat4 cameraWorldMatrix;
		uniform float radius;
		uniform float distanceExponent;
		uniform float thickness;
		uniform float distanceFallOff;
		uniform float scale;
		#if SCENE_CLIP_BOX == 1
			uniform vec3 sceneBoxMin;
			uniform vec3 sceneBoxMax;
		#endif

		#include <common>
		#include <packing>

		#ifndef FRAGMENT_OUTPUT
		#define FRAGMENT_OUTPUT vec4(vec3(ao), 1.)
		#endif

		vec3 getViewPosition(const in vec2 screenPosition, const in float depth) {
			vec4 clipSpacePosition = vec4(vec3(screenPosition, depth) * 2.0 - 1.0, 1.0);
			vec4 viewSpacePosition = cameraProjectionMatrixInverse * clipSpacePosition;
			return viewSpacePosition.xyz / viewSpacePosition.w;
		}

		float getDepth(const vec2 uv) {
			return textureLod(tDepth, uv.xy, 0.0).DEPTH_SWIZZLING;
		}

		float fetchDepth(const ivec2 uv) {
			return texelFetch(tDepth, uv.xy, 0).DEPTH_SWIZZLING;
		}

		float getViewZ(const in float depth) {
			#if PERSPECTIVE_CAMERA == 1
				return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
			#else
				return orthographicDepthToViewZ(depth, cameraNear, cameraFar);
			#endif
		}

		vec3 computeNormalFromDepth(const vec2 uv) {
			vec2 size = vec2(textureSize(tDepth, 0));
			ivec2 p = ivec2(uv * size);
			float c0 = fetchDepth(p);
			float l2 = fetchDepth(p - ivec2(2, 0));
			float l1 = fetchDepth(p - ivec2(1, 0));
			float r1 = fetchDepth(p + ivec2(1, 0));
			float r2 = fetchDepth(p + ivec2(2, 0));
			float b2 = fetchDepth(p - ivec2(0, 2));
			float b1 = fetchDepth(p - ivec2(0, 1));
			float t1 = fetchDepth(p + ivec2(0, 1));
			float t2 = fetchDepth(p + ivec2(0, 2));
			float dl = abs((2.0 * l1 - l2) - c0);
			float dr = abs((2.0 * r1 - r2) - c0);
			float db = abs((2.0 * b1 - b2) - c0);
			float dt = abs((2.0 * t1 - t2) - c0);
			vec3 ce = getViewPosition(uv, c0).xyz;
			vec3 dpdx = (dl < dr) ? ce - getViewPosition((uv - vec2(1.0 / size.x, 0.0)), l1).xyz : -ce + getViewPosition((uv + vec2(1.0 / size.x, 0.0)), r1).xyz;
			vec3 dpdy = (db < dt) ? ce - getViewPosition((uv - vec2(0.0, 1.0 / size.y)), b1).xyz : -ce + getViewPosition((uv + vec2(0.0, 1.0 / size.y)), t1).xyz;
			return normalize(cross(dpdx, dpdy));
		}

		vec3 getViewNormal(const vec2 uv) {
			#if NORMAL_VECTOR_TYPE == 2
				return normalize(textureLod(tNormal, uv, 0.).rgb);
			#elif NORMAL_VECTOR_TYPE == 1
				return unpackRGBToNormal(textureLod(tNormal, uv, 0.).rgb);
			#else
				return computeNormalFromDepth(uv);
			#endif
		}

		vec3 getSceneUvAndDepth(vec3 sampleViewPos) {
			vec4 sampleClipPos = cameraProjectionMatrix * vec4(sampleViewPos, 1.);
			vec2 sampleUv = sampleClipPos.xy / sampleClipPos.w * 0.5 + 0.5;
			float sampleSceneDepth = getDepth(sampleUv);
			return vec3(sampleUv, sampleSceneDepth);
		}

		void main() {
			float depth = getDepth(vUv.xy);
			if (depth >= 1.0) {
				discard;
				return;
			}
			vec3 viewPos = getViewPosition(vUv, depth);
			vec3 viewNormal = getViewNormal(vUv);

			float radiusToUse = radius;
			float distanceFalloffToUse = thickness;
			#if SCREEN_SPACE_RADIUS == 1
				float radiusScale = getViewPosition(vec2(0.5 + float(SCREEN_SPACE_RADIUS_SCALE) / resolution.x, 0.0), depth).x;
				radiusToUse *= radiusScale;
				distanceFalloffToUse *= radiusScale;
			#endif

			#if SCENE_CLIP_BOX == 1
				vec3 worldPos = (cameraWorldMatrix * vec4(viewPos, 1.0)).xyz;
				float boxDistance = length(max(vec3(0.0), max(sceneBoxMin - worldPos, worldPos - sceneBoxMax)));
				if (boxDistance > radiusToUse) {
					discard;
					return;
				}
			#endif

			vec2 noiseResolution = vec2(textureSize(tNoise, 0));
			vec2 noiseUv = vUv * resolution / noiseResolution;
			vec4 noiseTexel = textureLod(tNoise, noiseUv, 0.0);
			vec3 randomVec = noiseTexel.xyz * 2.0 - 1.0;
			vec3 tangent = normalize(vec3(randomVec.xy, 0.));
			vec3 bitangent = vec3(-tangent.y, tangent.x, 0.);
			mat3 kernelMatrix = mat3(tangent, bitangent, vec3(0., 0., 1.));

			const int DIRECTIONS = SAMPLES < 30 ? 3 : 5;
			const int STEPS = (SAMPLES + DIRECTIONS - 1) / DIRECTIONS;
			float ao = 0.0;
			for (int i = 0; i < DIRECTIONS; ++i) {

				float angle = float(i) / float(DIRECTIONS) * PI;
				vec4 sampleDir = vec4(cos(angle), sin(angle), 0., 0.5 + 0.5 * noiseTexel.w);
				sampleDir.xyz = normalize(kernelMatrix * sampleDir.xyz);

				vec3 viewDir = normalize(-viewPos.xyz);
				vec3 sliceBitangent = normalize(cross(sampleDir.xyz, viewDir));
				vec3 sliceTangent = cross(sliceBitangent, viewDir);
				vec3 normalInSlice = normalize(viewNormal - sliceBitangent * dot(viewNormal, sliceBitangent));

				vec3 tangentToNormalInSlice = cross(normalInSlice, sliceBitangent);
				vec2 cosHorizons = vec2(dot(viewDir, tangentToNormalInSlice), dot(viewDir, -tangentToNormalInSlice));

				for (int j = 0; j < STEPS; ++j) {
					vec3 sampleViewOffset = sampleDir.xyz * radiusToUse * sampleDir.w * pow(float(j + 1) / float(STEPS), distanceExponent);

					vec3 sampleSceneUvDepth = getSceneUvAndDepth(viewPos + sampleViewOffset);
					vec3 sampleSceneViewPos = getViewPosition(sampleSceneUvDepth.xy, sampleSceneUvDepth.z);
					vec3 viewDelta = sampleSceneViewPos - viewPos;
					if (abs(viewDelta.z) < thickness) {
						float sampleCosHorizon = dot(viewDir, normalize(viewDelta));
						cosHorizons.x += max(0., (sampleCosHorizon - cosHorizons.x) * mix(1., 2. / float(j + 2), distanceFallOff));
					}

					sampleSceneUvDepth = getSceneUvAndDepth(viewPos - sampleViewOffset);
					sampleSceneViewPos = getViewPosition(sampleSceneUvDepth.xy, sampleSceneUvDepth.z);
					viewDelta = sampleSceneViewPos - viewPos;
					if (abs(viewDelta.z) < thickness) {
						float sampleCosHorizon = dot(viewDir, normalize(viewDelta));
						cosHorizons.y += max(0., (sampleCosHorizon - cosHorizons.y) * mix(1., 2. / float(j + 2), distanceFallOff));
					}
				}

				vec2 sinHorizons = sqrt(1. - cosHorizons * cosHorizons);
				float nx = dot(normalInSlice, sliceTangent);
				float ny = dot(normalInSlice, viewDir);
				float nxb = 1. / 2. * (acos(cosHorizons.y) - acos(cosHorizons.x) + sinHorizons.x * cosHorizons.x - sinHorizons.y * cosHorizons.y);
				float nyb = 1. / 2. * (2. - cosHorizons.x * cosHorizons.x - cosHorizons.y * cosHorizons.y);
				float occlusion = nx * nxb + ny * nyb;
				ao += occlusion;
			}

			ao = clamp(ao / float(DIRECTIONS), 0., 1.);
		#if SCENE_CLIP_BOX == 1
			ao = mix(ao, 1., smoothstep(0., radiusToUse, boxDistance));
		#endif
			ao = pow(ao, scale);

			gl_FragColor = FRAGMENT_OUTPUT;
		}`},Me={defines:{PERSPECTIVE_CAMERA:1},uniforms:{tDepth:{value:null},cameraNear:{value:null},cameraFar:{value:null}},vertexShader:`
		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`
		uniform sampler2D tDepth;
		uniform float cameraNear;
		uniform float cameraFar;
		varying vec2 vUv;

		#include <packing>

		float getLinearDepth( const in vec2 screenPosition ) {
			#if PERSPECTIVE_CAMERA == 1
				float fragCoordZ = texture2D( tDepth, screenPosition ).x;
				float viewZ = perspectiveDepthToViewZ( fragCoordZ, cameraNear, cameraFar );
				return viewZToOrthographicDepth( viewZ, cameraNear, cameraFar );
			#else
				return texture2D( tDepth, screenPosition ).x;
			#endif
		}

		void main() {
			float depth = getLinearDepth( vUv );
			gl_FragColor = vec4( vec3( 1.0 - depth ), 1.0 );

		}`},Ze={uniforms:{tDiffuse:{value:null},intensity:{value:1}},vertexShader:`
		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`
		uniform float intensity;
		uniform sampler2D tDiffuse;
		varying vec2 vUv;

		void main() {
			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = vec4(mix(vec3(1.), texel.rgb, intensity), texel.a);
		}`};function Jt(l=5){const e=Math.floor(l)%2===0?Math.floor(l)+1:Math.floor(l),t=Kt(e),i=t.length,a=new Uint8Array(i*4);for(let o=0;o<i;++o){const n=t[o],d=2*Math.PI*n/i,r=new A(Math.cos(d),Math.sin(d),0).normalize();a[o*4]=(r.x*.5+.5)*255,a[o*4+1]=(r.y*.5+.5)*255,a[o*4+2]=127,a[o*4+3]=255}const s=new pt(a,e,e);return s.wrapS=Ue,s.wrapT=Ue,s.needsUpdate=!0,s}function Kt(l){const e=Math.floor(l)%2===0?Math.floor(l)+1:Math.floor(l),t=e*e,i=Array(t).fill(0);let a=Math.floor(e/2),s=e-1;for(let o=1;o<=t;){if(a===-1&&s===e?(s=e-2,a=0):(s===e&&(s=0),a<0&&(a=e-1)),i[a*e+s]!==0){s-=2,a++;continue}else i[a*e+s]=o++;s++,a--}return i}const ye={defines:{SAMPLES:16,SAMPLE_VECTORS:gt(16,2,1),NORMAL_VECTOR_TYPE:1,DEPTH_VALUE_SOURCE:0},uniforms:{tDiffuse:{value:null},tNormal:{value:null},tDepth:{value:null},tNoise:{value:null},resolution:{value:new et},cameraProjectionMatrixInverse:{value:new ue},lumaPhi:{value:5},depthPhi:{value:5},normalPhi:{value:5},radius:{value:4},index:{value:0}},vertexShader:`

		varying vec2 vUv;

		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,fragmentShader:`

		varying vec2 vUv;

		uniform sampler2D tDiffuse;
		uniform sampler2D tNormal;
		uniform sampler2D tDepth;
		uniform sampler2D tNoise;
		uniform vec2 resolution;
		uniform mat4 cameraProjectionMatrixInverse;
		uniform float lumaPhi;
		uniform float depthPhi;
		uniform float normalPhi;
		uniform float radius;
		uniform int index;

		#include <common>
		#include <packing>

		#ifndef SAMPLE_LUMINANCE
		#define SAMPLE_LUMINANCE dot(vec3(0.2125, 0.7154, 0.0721), a)
		#endif

		#ifndef FRAGMENT_OUTPUT
		#define FRAGMENT_OUTPUT vec4(denoised, 1.)
		#endif

		float getLuminance(const in vec3 a) {
			return SAMPLE_LUMINANCE;
		}

		const vec3 poissonDisk[SAMPLES] = SAMPLE_VECTORS;

		vec3 getViewPosition(const in vec2 screenPosition, const in float depth) {
			vec4 clipSpacePosition = vec4(vec3(screenPosition, depth) * 2.0 - 1.0, 1.0);
			vec4 viewSpacePosition = cameraProjectionMatrixInverse * clipSpacePosition;
			return viewSpacePosition.xyz / viewSpacePosition.w;
		}

		float getDepth(const vec2 uv) {
		#if DEPTH_VALUE_SOURCE == 1
			return textureLod(tDepth, uv.xy, 0.0).a;
		#else
			return textureLod(tDepth, uv.xy, 0.0).r;
		#endif
		}

		float fetchDepth(const ivec2 uv) {
			#if DEPTH_VALUE_SOURCE == 1
				return texelFetch(tDepth, uv.xy, 0).a;
			#else
				return texelFetch(tDepth, uv.xy, 0).r;
			#endif
		}

		vec3 computeNormalFromDepth(const vec2 uv) {
			vec2 size = vec2(textureSize(tDepth, 0));
			ivec2 p = ivec2(uv * size);
			float c0 = fetchDepth(p);
			float l2 = fetchDepth(p - ivec2(2, 0));
			float l1 = fetchDepth(p - ivec2(1, 0));
			float r1 = fetchDepth(p + ivec2(1, 0));
			float r2 = fetchDepth(p + ivec2(2, 0));
			float b2 = fetchDepth(p - ivec2(0, 2));
			float b1 = fetchDepth(p - ivec2(0, 1));
			float t1 = fetchDepth(p + ivec2(0, 1));
			float t2 = fetchDepth(p + ivec2(0, 2));
			float dl = abs((2.0 * l1 - l2) - c0);
			float dr = abs((2.0 * r1 - r2) - c0);
			float db = abs((2.0 * b1 - b2) - c0);
			float dt = abs((2.0 * t1 - t2) - c0);
			vec3 ce = getViewPosition(uv, c0).xyz;
			vec3 dpdx = (dl < dr) ?  ce - getViewPosition((uv - vec2(1.0 / size.x, 0.0)), l1).xyz
									: -ce + getViewPosition((uv + vec2(1.0 / size.x, 0.0)), r1).xyz;
			vec3 dpdy = (db < dt) ?  ce - getViewPosition((uv - vec2(0.0, 1.0 / size.y)), b1).xyz
									: -ce + getViewPosition((uv + vec2(0.0, 1.0 / size.y)), t1).xyz;
			return normalize(cross(dpdx, dpdy));
		}

		vec3 getViewNormal(const vec2 uv) {
		#if NORMAL_VECTOR_TYPE == 2
			return normalize(textureLod(tNormal, uv, 0.).rgb);
		#elif NORMAL_VECTOR_TYPE == 1
			return unpackRGBToNormal(textureLod(tNormal, uv, 0.).rgb);
		#else
			return computeNormalFromDepth(uv);
		#endif
		}

		void denoiseSample(in vec3 center, in vec3 viewNormal, in vec3 viewPos, in vec2 sampleUv, inout vec3 denoised, inout float totalWeight) {
			vec4 sampleTexel = textureLod(tDiffuse, sampleUv, 0.0);
			float sampleDepth = getDepth(sampleUv);
			vec3 sampleNormal = getViewNormal(sampleUv);
			vec3 neighborColor = sampleTexel.rgb;
			vec3 viewPosSample = getViewPosition(sampleUv, sampleDepth);

			float normalDiff = dot(viewNormal, sampleNormal);
			float normalSimilarity = pow(max(normalDiff, 0.), normalPhi);
			float lumaDiff = abs(getLuminance(neighborColor) - getLuminance(center));
			float lumaSimilarity = max(1.0 - lumaDiff / lumaPhi, 0.0);
			float depthDiff = abs(dot(viewPos - viewPosSample, viewNormal));
			float depthSimilarity = max(1. - depthDiff / depthPhi, 0.);
			float w = lumaSimilarity * depthSimilarity * normalSimilarity;

			denoised += w * neighborColor;
			totalWeight += w;
		}

		void main() {
			float depth = getDepth(vUv.xy);
			vec3 viewNormal = getViewNormal(vUv);
			if (depth == 1. || dot(viewNormal, viewNormal) == 0.) {
				discard;
				return;
			}
			vec4 texel = textureLod(tDiffuse, vUv, 0.0);
			vec3 center = texel.rgb;
			vec3 viewPos = getViewPosition(vUv, depth);

			vec2 noiseResolution = vec2(textureSize(tNoise, 0));
			vec2 noiseUv = vUv * resolution / noiseResolution;
			vec4 noiseTexel = textureLod(tNoise, noiseUv, 0.0);
      		vec2 noiseVec = vec2(sin(noiseTexel[index % 4] * 2. * PI), cos(noiseTexel[index % 4] * 2. * PI));
    		mat2 rotationMatrix = mat2(noiseVec.x, -noiseVec.y, noiseVec.x, noiseVec.y);

			float totalWeight = 1.0;
			vec3 denoised = texel.rgb;
			for (int i = 0; i < SAMPLES; i++) {
				vec3 sampleDir = poissonDisk[i];
				vec2 offset = rotationMatrix * (sampleDir.xy * (1. + sampleDir.z * (radius - 1.)) / resolution);
				vec2 sampleUv = vUv + offset;
				denoiseSample(center, viewNormal, viewPos, sampleUv, denoised, totalWeight);
			}

			if (totalWeight > 0.) {
				denoised /= totalWeight;
			}
			gl_FragColor = FRAGMENT_OUTPUT;
		}`};function gt(l,e,t){const i=ei(l,e,t);let a="vec3[SAMPLES](";for(let s=0;s<l;s++){const o=i[s];a+=`vec3(${o.x}, ${o.y}, ${o.z})${s<l-1?",":")"}`}return a}function ei(l,e,t){const i=[];for(let a=0;a<l;a++){const s=2*Math.PI*e*a/l,o=Math.pow(a/(l-1),t);i.push(new A(Math.cos(s),Math.sin(s),o))}return i}const $={uniforms:{tDiffuse:{value:null},opacity:{value:1}},vertexShader:`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;


		}`};class ti{constructor(e=Math){this.grad3=[[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]],this.grad4=[[0,1,1,1],[0,1,1,-1],[0,1,-1,1],[0,1,-1,-1],[0,-1,1,1],[0,-1,1,-1],[0,-1,-1,1],[0,-1,-1,-1],[1,0,1,1],[1,0,1,-1],[1,0,-1,1],[1,0,-1,-1],[-1,0,1,1],[-1,0,1,-1],[-1,0,-1,1],[-1,0,-1,-1],[1,1,0,1],[1,1,0,-1],[1,-1,0,1],[1,-1,0,-1],[-1,1,0,1],[-1,1,0,-1],[-1,-1,0,1],[-1,-1,0,-1],[1,1,1,0],[1,1,-1,0],[1,-1,1,0],[1,-1,-1,0],[-1,1,1,0],[-1,1,-1,0],[-1,-1,1,0],[-1,-1,-1,0]],this.p=[];for(let t=0;t<256;t++)this.p[t]=Math.floor(e.random()*256);this.perm=[];for(let t=0;t<512;t++)this.perm[t]=this.p[t&255];this.simplex=[[0,1,2,3],[0,1,3,2],[0,0,0,0],[0,2,3,1],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,2,3,0],[0,2,1,3],[0,0,0,0],[0,3,1,2],[0,3,2,1],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,3,2,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[1,2,0,3],[0,0,0,0],[1,3,0,2],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,3,0,1],[2,3,1,0],[1,0,2,3],[1,0,3,2],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,0,3,1],[0,0,0,0],[2,1,3,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0],[2,0,1,3],[0,0,0,0],[0,0,0,0],[0,0,0,0],[3,0,1,2],[3,0,2,1],[0,0,0,0],[3,1,2,0],[2,1,0,3],[0,0,0,0],[0,0,0,0],[0,0,0,0],[3,1,0,2],[0,0,0,0],[3,2,0,1],[3,2,1,0]]}noise(e,t){let i,a,s;const o=.5*(Math.sqrt(3)-1),n=(e+t)*o,d=Math.floor(e+n),r=Math.floor(t+n),c=(3-Math.sqrt(3))/6,f=(d+r)*c,g=d-f,p=r-f,M=e-g,P=t-p;let U,N;M>P?(U=1,N=0):(U=0,N=1);const _=M-U+c,h=P-N+c,u=M-1+2*c,b=P-1+2*c,D=d&255,C=r&255,R=this.perm[D+this.perm[C]]%12,m=this.perm[D+U+this.perm[C+N]]%12,v=this.perm[D+1+this.perm[C+1]]%12;let S=.5-M*M-P*P;S<0?i=0:(S*=S,i=S*S*this._dot(this.grad3[R],M,P));let x=.5-_*_-h*h;x<0?a=0:(x*=x,a=x*x*this._dot(this.grad3[m],_,h));let O=.5-u*u-b*b;return O<0?s=0:(O*=O,s=O*O*this._dot(this.grad3[v],u,b)),70*(i+a+s)}noise3d(e,t,i){let a,s,o,n;const r=(e+t+i)*.3333333333333333,c=Math.floor(e+r),f=Math.floor(t+r),g=Math.floor(i+r),p=1/6,M=(c+f+g)*p,P=c-M,U=f-M,N=g-M,_=e-P,h=t-U,u=i-N;let b,D,C,R,m,v;_>=h?h>=u?(b=1,D=0,C=0,R=1,m=1,v=0):_>=u?(b=1,D=0,C=0,R=1,m=0,v=1):(b=0,D=0,C=1,R=1,m=0,v=1):h<u?(b=0,D=0,C=1,R=0,m=1,v=1):_<u?(b=0,D=1,C=0,R=0,m=1,v=1):(b=0,D=1,C=0,R=1,m=1,v=0);const S=_-b+p,x=h-D+p,O=u-C+p,J=_-R+2*p,K=h-m+2*p,ee=u-v+2*p,te=_-1+3*p,ie=h-1+3*p,E=u-1+3*p,k=c&255,q=f&255,Z=g&255,pe=this.perm[k+this.perm[q+this.perm[Z]]]%12,me=this.perm[k+b+this.perm[q+D+this.perm[Z+C]]]%12,ve=this.perm[k+R+this.perm[q+m+this.perm[Z+v]]]%12,ge=this.perm[k+1+this.perm[q+1+this.perm[Z+1]]]%12;let j=.6-_*_-h*h-u*u;j<0?a=0:(j*=j,a=j*j*this._dot3(this.grad3[pe],_,h,u));let B=.6-S*S-x*x-O*O;B<0?s=0:(B*=B,s=B*B*this._dot3(this.grad3[me],S,x,O));let G=.6-J*J-K*K-ee*ee;G<0?o=0:(G*=G,o=G*G*this._dot3(this.grad3[ve],J,K,ee));let H=.6-te*te-ie*ie-E*E;return H<0?n=0:(H*=H,n=H*H*this._dot3(this.grad3[ge],te,ie,E)),32*(a+s+o+n)}noise4d(e,t,i,a){const s=this.grad4,o=this.simplex,n=this.perm,d=(Math.sqrt(5)-1)/4,r=(5-Math.sqrt(5))/20;let c,f,g,p,M;const P=(e+t+i+a)*d,U=Math.floor(e+P),N=Math.floor(t+P),_=Math.floor(i+P),h=Math.floor(a+P),u=(U+N+_+h)*r,b=U-u,D=N-u,C=_-u,R=h-u,m=e-b,v=t-D,S=i-C,x=a-R,O=m>v?32:0,J=m>S?16:0,K=v>S?8:0,ee=m>x?4:0,te=v>x?2:0,ie=S>x?1:0,E=O+J+K+ee+te+ie,k=o[E][0]>=3?1:0,q=o[E][1]>=3?1:0,Z=o[E][2]>=3?1:0,pe=o[E][3]>=3?1:0,me=o[E][0]>=2?1:0,ve=o[E][1]>=2?1:0,ge=o[E][2]>=2?1:0,j=o[E][3]>=2?1:0,B=o[E][0]>=1?1:0,G=o[E][1]>=1?1:0,H=o[E][2]>=1?1:0,st=o[E][3]>=1?1:0,Ae=m-k+r,Ne=v-q+r,Re=S-Z+r,Oe=x-pe+r,ze=m-me+2*r,Le=v-ve+2*r,Ie=S-ge+2*r,Ve=x-j+2*r,Fe=m-B+3*r,je=v-G+3*r,Be=S-H+3*r,Ge=x-st+3*r,He=m-1+4*r,We=v-1+4*r,ke=S-1+4*r,qe=x-1+4*r,ae=U&255,se=N&255,ne=_&255,oe=h&255,_t=n[ae+n[se+n[ne+n[oe]]]]%32,Mt=n[ae+k+n[se+q+n[ne+Z+n[oe+pe]]]]%32,yt=n[ae+me+n[se+ve+n[ne+ge+n[oe+j]]]]%32,wt=n[ae+B+n[se+G+n[ne+H+n[oe+st]]]]%32,Tt=n[ae+1+n[se+1+n[ne+1+n[oe+1]]]]%32;let re=.6-m*m-v*v-S*S-x*x;re<0?c=0:(re*=re,c=re*re*this._dot4(s[_t],m,v,S,x));let le=.6-Ae*Ae-Ne*Ne-Re*Re-Oe*Oe;le<0?f=0:(le*=le,f=le*le*this._dot4(s[Mt],Ae,Ne,Re,Oe));let ce=.6-ze*ze-Le*Le-Ie*Ie-Ve*Ve;ce<0?g=0:(ce*=ce,g=ce*ce*this._dot4(s[yt],ze,Le,Ie,Ve));let de=.6-Fe*Fe-je*je-Be*Be-Ge*Ge;de<0?p=0:(de*=de,p=de*de*this._dot4(s[wt],Fe,je,Be,Ge));let fe=.6-He*He-We*We-ke*ke-qe*qe;return fe<0?M=0:(fe*=fe,M=fe*fe*this._dot4(s[Tt],He,We,ke,qe)),27*(c+f+g+p+M)}_dot(e,t,i){return e[0]*t+e[1]*i}_dot3(e,t,i,a){return e[0]*t+e[1]*i+e[2]*a}_dot4(e,t,i,a,s){return e[0]*t+e[1]*i+e[2]*a+e[3]*s}}class I extends it{constructor(e,t,i=512,a=512,s,o,n){super(),this.width=i,this.height=a,this.clear=!0,this.camera=t,this.scene=e,this.output=0,this._renderGBuffer=!0,this._visibilityCache=[],this.blendIntensity=1,this.pdRings=2,this.pdRadiusExponent=2,this.pdSamples=16,this.gtaoNoiseTexture=Jt(),this.pdNoiseTexture=this._generateNoise(),this.gtaoRenderTarget=new $e(this.width,this.height,{type:Je}),this.pdRenderTarget=this.gtaoRenderTarget.clone(),this.gtaoMaterial=new X({defines:Object.assign({},_e.defines),uniforms:F.clone(_e.uniforms),vertexShader:_e.vertexShader,fragmentShader:_e.fragmentShader,blending:W,depthTest:!1,depthWrite:!1}),this.gtaoMaterial.defines.PERSPECTIVE_CAMERA=this.camera.isPerspectiveCamera?1:0,this.gtaoMaterial.uniforms.tNoise.value=this.gtaoNoiseTexture,this.gtaoMaterial.uniforms.resolution.value.set(this.width,this.height),this.gtaoMaterial.uniforms.cameraNear.value=this.camera.near,this.gtaoMaterial.uniforms.cameraFar.value=this.camera.far,this.normalMaterial=new bt,this.normalMaterial.blending=W,this.pdMaterial=new X({defines:Object.assign({},ye.defines),uniforms:F.clone(ye.uniforms),vertexShader:ye.vertexShader,fragmentShader:ye.fragmentShader,depthTest:!1,depthWrite:!1}),this.pdMaterial.uniforms.tDiffuse.value=this.gtaoRenderTarget.texture,this.pdMaterial.uniforms.tNoise.value=this.pdNoiseTexture,this.pdMaterial.uniforms.resolution.value.set(this.width,this.height),this.pdMaterial.uniforms.lumaPhi.value=10,this.pdMaterial.uniforms.depthPhi.value=2,this.pdMaterial.uniforms.normalPhi.value=3,this.pdMaterial.uniforms.radius.value=8,this.depthRenderMaterial=new X({defines:Object.assign({},Me.defines),uniforms:F.clone(Me.uniforms),vertexShader:Me.vertexShader,fragmentShader:Me.fragmentShader,blending:W}),this.depthRenderMaterial.uniforms.cameraNear.value=this.camera.near,this.depthRenderMaterial.uniforms.cameraFar.value=this.camera.far,this.copyMaterial=new X({uniforms:F.clone($.uniforms),vertexShader:$.vertexShader,fragmentShader:$.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,blendSrc:ot,blendDst:xe,blendEquation:Se,blendSrcAlpha:nt,blendDstAlpha:xe,blendEquationAlpha:Se}),this.blendMaterial=new X({uniforms:F.clone(Ze.uniforms),vertexShader:Ze.vertexShader,fragmentShader:Ze.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,blending:Dt,blendSrc:ot,blendDst:xe,blendEquation:Se,blendSrcAlpha:nt,blendDstAlpha:xe,blendEquationAlpha:Se}),this._fsQuad=new at(null),this._originalClearColor=new mt,this.setGBuffer(s?s.depthTexture:void 0,s?s.normalTexture:void 0),o!==void 0&&this.updateGtaoMaterial(o),n!==void 0&&this.updatePdMaterial(n)}setSize(e,t){this.width=e,this.height=t,this.gtaoRenderTarget.setSize(e,t),this.normalRenderTarget.setSize(e,t),this.pdRenderTarget.setSize(e,t),this.gtaoMaterial.uniforms.resolution.value.set(e,t),this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix),this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this.pdMaterial.uniforms.resolution.value.set(e,t),this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse)}dispose(){this.gtaoNoiseTexture.dispose(),this.pdNoiseTexture.dispose(),this.normalRenderTarget.dispose(),this.gtaoRenderTarget.dispose(),this.pdRenderTarget.dispose(),this.normalMaterial.dispose(),this.pdMaterial.dispose(),this.copyMaterial.dispose(),this.depthRenderMaterial.dispose(),this._fsQuad.dispose()}get gtaoMap(){return this.pdRenderTarget.texture}setGBuffer(e,t){e!==void 0?(this.depthTexture=e,this.normalTexture=t,this._renderGBuffer=!1):(this.depthTexture=new Ct,this.depthTexture.format=Ut,this.depthTexture.type=At,this.normalRenderTarget=new $e(this.width,this.height,{minFilter:rt,magFilter:rt,type:Je,depthTexture:this.depthTexture}),this.normalTexture=this.normalRenderTarget.texture,this._renderGBuffer=!0);const i=this.normalTexture?1:0,a=this.depthTexture===this.normalTexture?"w":"x";this.gtaoMaterial.defines.NORMAL_VECTOR_TYPE=i,this.gtaoMaterial.defines.DEPTH_SWIZZLING=a,this.gtaoMaterial.uniforms.tNormal.value=this.normalTexture,this.gtaoMaterial.uniforms.tDepth.value=this.depthTexture,this.pdMaterial.defines.NORMAL_VECTOR_TYPE=i,this.pdMaterial.defines.DEPTH_SWIZZLING=a,this.pdMaterial.uniforms.tNormal.value=this.normalTexture,this.pdMaterial.uniforms.tDepth.value=this.depthTexture,this.depthRenderMaterial.uniforms.tDepth.value=this.normalRenderTarget.depthTexture}setSceneClipBox(e){e?(this.gtaoMaterial.needsUpdate=this.gtaoMaterial.defines.SCENE_CLIP_BOX!==1,this.gtaoMaterial.defines.SCENE_CLIP_BOX=1,this.gtaoMaterial.uniforms.sceneBoxMin.value.copy(e.min),this.gtaoMaterial.uniforms.sceneBoxMax.value.copy(e.max)):(this.gtaoMaterial.needsUpdate=this.gtaoMaterial.defines.SCENE_CLIP_BOX===0,this.gtaoMaterial.defines.SCENE_CLIP_BOX=0)}updateGtaoMaterial(e){e.radius!==void 0&&(this.gtaoMaterial.uniforms.radius.value=e.radius),e.distanceExponent!==void 0&&(this.gtaoMaterial.uniforms.distanceExponent.value=e.distanceExponent),e.thickness!==void 0&&(this.gtaoMaterial.uniforms.thickness.value=e.thickness),e.distanceFallOff!==void 0&&(this.gtaoMaterial.uniforms.distanceFallOff.value=e.distanceFallOff,this.gtaoMaterial.needsUpdate=!0),e.scale!==void 0&&(this.gtaoMaterial.uniforms.scale.value=e.scale),e.samples!==void 0&&e.samples!==this.gtaoMaterial.defines.SAMPLES&&(this.gtaoMaterial.defines.SAMPLES=e.samples,this.gtaoMaterial.needsUpdate=!0),e.screenSpaceRadius!==void 0&&(e.screenSpaceRadius?1:0)!==this.gtaoMaterial.defines.SCREEN_SPACE_RADIUS&&(this.gtaoMaterial.defines.SCREEN_SPACE_RADIUS=e.screenSpaceRadius?1:0,this.gtaoMaterial.needsUpdate=!0)}updatePdMaterial(e){let t=!1;e.lumaPhi!==void 0&&(this.pdMaterial.uniforms.lumaPhi.value=e.lumaPhi),e.depthPhi!==void 0&&(this.pdMaterial.uniforms.depthPhi.value=e.depthPhi),e.normalPhi!==void 0&&(this.pdMaterial.uniforms.normalPhi.value=e.normalPhi),e.radius!==void 0&&e.radius!==this.radius&&(this.pdMaterial.uniforms.radius.value=e.radius),e.radiusExponent!==void 0&&e.radiusExponent!==this.pdRadiusExponent&&(this.pdRadiusExponent=e.radiusExponent,t=!0),e.rings!==void 0&&e.rings!==this.pdRings&&(this.pdRings=e.rings,t=!0),e.samples!==void 0&&e.samples!==this.pdSamples&&(this.pdSamples=e.samples,t=!0),t&&(this.pdMaterial.defines.SAMPLES=this.pdSamples,this.pdMaterial.defines.SAMPLE_VECTORS=gt(this.pdSamples,this.pdRings,this.pdRadiusExponent),this.pdMaterial.needsUpdate=!0)}render(e,t,i){switch(this._renderGBuffer&&(this._overrideVisibility(),this._renderOverride(e,this.normalMaterial,this.normalRenderTarget,7829503,1),this._restoreVisibility()),this.gtaoMaterial.uniforms.cameraNear.value=this.camera.near,this.gtaoMaterial.uniforms.cameraFar.value=this.camera.far,this.gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix),this.gtaoMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this.gtaoMaterial.uniforms.cameraWorldMatrix.value.copy(this.camera.matrixWorld),this._renderPass(e,this.gtaoMaterial,this.gtaoRenderTarget,16777215,1),this.pdMaterial.uniforms.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse),this._renderPass(e,this.pdMaterial,this.pdRenderTarget,16777215,1),this.output){case I.OUTPUT.Off:break;case I.OUTPUT.Diffuse:this.copyMaterial.uniforms.tDiffuse.value=i.texture,this.copyMaterial.blending=W,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case I.OUTPUT.AO:this.copyMaterial.uniforms.tDiffuse.value=this.gtaoRenderTarget.texture,this.copyMaterial.blending=W,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case I.OUTPUT.Denoise:this.copyMaterial.uniforms.tDiffuse.value=this.pdRenderTarget.texture,this.copyMaterial.blending=W,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case I.OUTPUT.Depth:this.depthRenderMaterial.uniforms.cameraNear.value=this.camera.near,this.depthRenderMaterial.uniforms.cameraFar.value=this.camera.far,this._renderPass(e,this.depthRenderMaterial,this.renderToScreen?null:t);break;case I.OUTPUT.Normal:this.copyMaterial.uniforms.tDiffuse.value=this.normalRenderTarget.texture,this.copyMaterial.blending=W,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t);break;case I.OUTPUT.Default:this.copyMaterial.uniforms.tDiffuse.value=i.texture,this.copyMaterial.blending=W,this._renderPass(e,this.copyMaterial,this.renderToScreen?null:t),this.blendMaterial.uniforms.intensity.value=this.blendIntensity,this.blendMaterial.uniforms.tDiffuse.value=this.pdRenderTarget.texture,this._renderPass(e,this.blendMaterial,this.renderToScreen?null:t);break;default:console.warn("THREE.GTAOPass: Unknown output type.")}}_renderPass(e,t,i,a,s){e.getClearColor(this._originalClearColor);const o=e.getClearAlpha(),n=e.autoClear;e.setRenderTarget(i),e.autoClear=!1,a!=null&&(e.setClearColor(a),e.setClearAlpha(s||0),e.clear()),this._fsQuad.material=t,this._fsQuad.render(e),e.autoClear=n,e.setClearColor(this._originalClearColor),e.setClearAlpha(o)}_renderOverride(e,t,i,a,s){e.getClearColor(this._originalClearColor);const o=e.getClearAlpha(),n=e.autoClear;e.setRenderTarget(i),e.autoClear=!1,a=t.clearColor||a,s=t.clearAlpha||s,a!=null&&(e.setClearColor(a),e.setClearAlpha(s||0),e.clear()),this.scene.overrideMaterial=t,e.render(this.scene,this.camera),this.scene.overrideMaterial=null,e.autoClear=n,e.setClearColor(this._originalClearColor),e.setClearAlpha(o)}_overrideVisibility(){const e=this.scene,t=this._visibilityCache;e.traverse(function(i){(i.isPoints||i.isLine||i.isLine2)&&i.visible&&(i.visible=!1,t.push(i))})}_restoreVisibility(){const e=this._visibilityCache;for(let t=0;t<e.length;t++)e[t].visible=!0;e.length=0}_generateNoise(e=64){const t=new ti,i=e*e*4,a=new Uint8Array(i);for(let o=0;o<e;o++)for(let n=0;n<e;n++){const d=o,r=n;a[(o*e+n)*4]=(t.noise(d,r)*.5+.5)*255,a[(o*e+n)*4+1]=(t.noise(d+e,r)*.5+.5)*255,a[(o*e+n)*4+2]=(t.noise(d,r+e)*.5+.5)*255,a[(o*e+n)*4+3]=(t.noise(d+e,r+e)*.5+.5)*255}const s=new pt(a,e,e,Nt,Rt);return s.wrapS=Ue,s.wrapT=Ue,s.needsUpdate=!0,s}}I.OUTPUT={Off:-1,Default:0,Diffuse:1,Depth:2,Normal:3,AO:4,Denoise:5};const ci=Object.freeze(Object.defineProperty({__proto__:null,GTAOPass:I},Symbol.toStringTag,{value:"Module"})),we={name:"OutputShader",uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1}},vertexShader:`
		precision highp float;

		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;

		attribute vec3 position;
		attribute vec2 uv;

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,fragmentShader:`

		precision highp float;

		uniform sampler2D tDiffuse;

		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );

			// tone mapping

			#ifdef LINEAR_TONE_MAPPING

				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );

			#elif defined( REINHARD_TONE_MAPPING )

				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );

			#elif defined( CINEON_TONE_MAPPING )

				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );

			#elif defined( ACES_FILMIC_TONE_MAPPING )

				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );

			#elif defined( AGX_TONE_MAPPING )

				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );

			#elif defined( NEUTRAL_TONE_MAPPING )

				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );

			#elif defined( CUSTOM_TONE_MAPPING )

				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );

			#endif

			// color space

			#ifdef SRGB_TRANSFER

				gl_FragColor = sRGBTransferOETF( gl_FragColor );

			#endif

		}`};class ii extends it{constructor(){super(),this.uniforms=F.clone(we.uniforms),this.material=new Ot({name:we.name,uniforms:this.uniforms,vertexShader:we.vertexShader,fragmentShader:we.fragmentShader}),this._fsQuad=new at(this.material),this._outputColorSpace=null,this._toneMapping=null}render(e,t,i){this.uniforms.tDiffuse.value=i.texture,this.uniforms.toneMappingExposure.value=e.toneMappingExposure,(this._outputColorSpace!==e.outputColorSpace||this._toneMapping!==e.toneMapping)&&(this._outputColorSpace=e.outputColorSpace,this._toneMapping=e.toneMapping,this.material.defines={},zt.getTransfer(this._outputColorSpace)===Lt&&(this.material.defines.SRGB_TRANSFER=""),this._toneMapping===It?this.material.defines.LINEAR_TONE_MAPPING="":this._toneMapping===Vt?this.material.defines.REINHARD_TONE_MAPPING="":this._toneMapping===Ft?this.material.defines.CINEON_TONE_MAPPING="":this._toneMapping===jt?this.material.defines.ACES_FILMIC_TONE_MAPPING="":this._toneMapping===Bt?this.material.defines.AGX_TONE_MAPPING="":this._toneMapping===Gt?this.material.defines.NEUTRAL_TONE_MAPPING="":this._toneMapping===Ht&&(this.material.defines.CUSTOM_TONE_MAPPING=""),this.material.needsUpdate=!0),this.renderToScreen===!0?(e.setRenderTarget(null),this._fsQuad.render(e)):(e.setRenderTarget(t),this.clear&&e.clear(e.autoClearColor,e.autoClearDepth,e.autoClearStencil),this._fsQuad.render(e))}dispose(){this.material.dispose(),this._fsQuad.dispose()}}const di=Object.freeze(Object.defineProperty({__proto__:null,OutputPass:ii},Symbol.toStringTag,{value:"Module"}));class ai extends it{constructor(e,t,i=0,a=0){super(),this.scene=e,this.camera=t,this.sampleLevel=4,this.unbiased=!0,this.stencilBuffer=!1,this.clearColor=i,this.clearAlpha=a,this._sampleRenderTarget=null,this._oldClearColor=new mt,this._copyUniforms=F.clone($.uniforms),this._copyMaterial=new X({uniforms:this._copyUniforms,vertexShader:$.vertexShader,fragmentShader:$.fragmentShader,transparent:!0,depthTest:!1,depthWrite:!1,premultipliedAlpha:!0,blending:Wt}),this._fsQuad=new at(this._copyMaterial)}dispose(){this._sampleRenderTarget&&(this._sampleRenderTarget.dispose(),this._sampleRenderTarget=null),this._copyMaterial.dispose(),this._fsQuad.dispose()}setSize(e,t){this._sampleRenderTarget&&this._sampleRenderTarget.setSize(e,t)}render(e,t,i){this._sampleRenderTarget||(this._sampleRenderTarget=new $e(i.width,i.height,{type:Je,stencilBuffer:this.stencilBuffer}),this._sampleRenderTarget.texture.name="SSAARenderPass.sample");const a=si[Math.max(0,Math.min(this.sampleLevel,5))],s=e.autoClear;e.autoClear=!1,e.getClearColor(this._oldClearColor);const o=e.getClearAlpha(),n=1/a.length,d=1/32;this._copyUniforms.tDiffuse.value=this._sampleRenderTarget.texture;const r={fullWidth:i.width,fullHeight:i.height,offsetX:0,offsetY:0,width:i.width,height:i.height},c=Object.assign({},this.camera.view);c.enabled&&Object.assign(r,c);for(let f=0;f<a.length;f++){const g=a[f];this.camera.setViewOffset&&this.camera.setViewOffset(r.fullWidth,r.fullHeight,r.offsetX+g[0]*.0625,r.offsetY+g[1]*.0625,r.width,r.height);let p=n;if(this.unbiased){const M=-.5+(f+.5)/a.length;p+=d*M}this._copyUniforms.opacity.value=p,e.setClearColor(this.clearColor,this.clearAlpha),e.setRenderTarget(this._sampleRenderTarget),e.clear(),e.render(this.scene,this.camera),e.setRenderTarget(this.renderToScreen?null:t),f===0&&(e.setClearColor(0,0),e.clear()),this._fsQuad.render(e)}this.camera.setViewOffset&&c.enabled?this.camera.setViewOffset(c.fullWidth,c.fullHeight,c.offsetX,c.offsetY,c.width,c.height):this.camera.clearViewOffset&&this.camera.clearViewOffset(),e.autoClear=s,e.setClearColor(this._oldClearColor,o)}}const si=[[[0,0]],[[4,4],[-4,-4]],[[-2,-6],[6,-2],[-6,2],[2,6]],[[1,-3],[-1,3],[5,1],[-3,-5],[-5,5],[-7,-1],[3,7],[7,-7]],[[1,1],[-1,-3],[-3,2],[4,-1],[-5,-2],[2,5],[5,3],[3,-5],[-2,6],[0,-7],[-4,-6],[-6,4],[-8,0],[7,-4],[6,7],[-7,-8]],[[-4,-7],[-7,-5],[-3,-5],[-5,-4],[-1,-4],[-2,-2],[-6,-1],[-4,0],[-7,1],[-1,2],[-6,3],[-3,3],[-7,6],[-3,6],[-5,7],[-1,7],[5,-7],[1,-6],[6,-5],[4,-4],[2,-3],[7,-2],[1,-1],[4,-1],[2,1],[6,2],[0,4],[4,4],[2,5],[7,5],[5,6],[3,7]]],fi=Object.freeze(Object.defineProperty({__proto__:null,SSAARenderPass:ai},Symbol.toStringTag,{value:"Module"}));De.line={worldUnits:{value:1},linewidth:{value:1},resolution:{value:new et(1,1)},dashOffset:{value:0},dashScale:{value:1},dashSize:{value:1},gapSize:{value:1}};be.line={uniforms:F.merge([De.common,De.fog,De.line]),vertexShader:`
		#include <common>
		#include <color_pars_vertex>
		#include <fog_pars_vertex>
		#include <logdepthbuf_pars_vertex>
		#include <clipping_planes_pars_vertex>

		uniform float linewidth;
		uniform vec2 resolution;

		attribute vec3 instanceStart;
		attribute vec3 instanceEnd;

		attribute vec3 instanceColorStart;
		attribute vec3 instanceColorEnd;

		#ifdef WORLD_UNITS

			varying vec4 worldPos;
			varying vec3 worldStart;
			varying vec3 worldEnd;

			#ifdef USE_DASH

				varying vec2 vUv;

			#endif

		#else

			varying vec2 vUv;

		#endif

		#ifdef USE_DASH

			uniform float dashScale;
			attribute float instanceDistanceStart;
			attribute float instanceDistanceEnd;
			varying float vLineDistance;

		#endif

		void trimSegment( const in vec4 start, inout vec4 end ) {

			// trim end segment so it terminates between the camera plane and the near plane

			// conservative estimate of the near plane
			float a = projectionMatrix[ 2 ][ 2 ]; // 3nd entry in 3th column
			float b = projectionMatrix[ 3 ][ 2 ]; // 3nd entry in 4th column
			float nearEstimate = - 0.5 * b / a;

			float alpha = ( nearEstimate - start.z ) / ( end.z - start.z );

			end.xyz = mix( start.xyz, end.xyz, alpha );

		}

		void main() {

			#ifdef USE_COLOR

				vColor.xyz = ( position.y < 0.5 ) ? instanceColorStart : instanceColorEnd;

			#endif

			#ifdef USE_DASH

				vLineDistance = ( position.y < 0.5 ) ? dashScale * instanceDistanceStart : dashScale * instanceDistanceEnd;
				vUv = uv;

			#endif

			float aspect = resolution.x / resolution.y;

			// camera space
			vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );
			vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );

			#ifdef WORLD_UNITS

				worldStart = start.xyz;
				worldEnd = end.xyz;

			#else

				vUv = uv;

			#endif

			// special case for perspective projection, and segments that terminate either in, or behind, the camera plane
			// clearly the gpu firmware has a way of addressing this issue when projecting into ndc space
			// but we need to perform ndc-space calculations in the shader, so we must address this issue directly
			// perhaps there is a more elegant solution -- WestLangley

			bool perspective = ( projectionMatrix[ 2 ][ 3 ] == - 1.0 ); // 4th entry in the 3rd column

			if ( perspective ) {

				if ( start.z < 0.0 && end.z >= 0.0 ) {

					trimSegment( start, end );

				} else if ( end.z < 0.0 && start.z >= 0.0 ) {

					trimSegment( end, start );

				}

			}

			// clip space
			vec4 clipStart = projectionMatrix * start;
			vec4 clipEnd = projectionMatrix * end;

			// ndc space
			vec3 ndcStart = clipStart.xyz / clipStart.w;
			vec3 ndcEnd = clipEnd.xyz / clipEnd.w;

			// direction
			vec2 dir = ndcEnd.xy - ndcStart.xy;

			// account for clip-space aspect ratio
			dir.x *= aspect;
			dir = normalize( dir );

			#ifdef WORLD_UNITS

				vec3 worldDir = normalize( end.xyz - start.xyz );
				vec3 tmpFwd = normalize( mix( start.xyz, end.xyz, 0.5 ) );
				vec3 worldUp = normalize( cross( worldDir, tmpFwd ) );
				vec3 worldFwd = cross( worldDir, worldUp );
				worldPos = position.y < 0.5 ? start: end;

				// height offset
				float hw = linewidth * 0.5;
				worldPos.xyz += position.x < 0.0 ? hw * worldUp : - hw * worldUp;

				// don't extend the line if we're rendering dashes because we
				// won't be rendering the endcaps
				#ifndef USE_DASH

					// cap extension
					worldPos.xyz += position.y < 0.5 ? - hw * worldDir : hw * worldDir;

					// add width to the box
					worldPos.xyz += worldFwd * hw;

					// endcaps
					if ( position.y > 1.0 || position.y < 0.0 ) {

						worldPos.xyz -= worldFwd * 2.0 * hw;

					}

				#endif

				// project the worldpos
				vec4 clip = projectionMatrix * worldPos;

				// shift the depth of the projected points so the line
				// segments overlap neatly
				vec3 clipPose = ( position.y < 0.5 ) ? ndcStart : ndcEnd;
				clip.z = clipPose.z * clip.w;

			#else

				vec2 offset = vec2( dir.y, - dir.x );
				// undo aspect ratio adjustment
				dir.x /= aspect;
				offset.x /= aspect;

				// sign flip
				if ( position.x < 0.0 ) offset *= - 1.0;

				// endcaps
				if ( position.y < 0.0 ) {

					offset += - dir;

				} else if ( position.y > 1.0 ) {

					offset += dir;

				}

				// adjust for linewidth
				offset *= linewidth;

				// adjust for clip-space to screen-space conversion // maybe resolution should be based on viewport ...
				offset /= resolution.y;

				// select end
				vec4 clip = ( position.y < 0.5 ) ? clipStart : clipEnd;

				// back to clip space
				offset *= clip.w;

				clip.xy += offset;

			#endif

			gl_Position = clip;

			vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation

			#include <logdepthbuf_vertex>
			#include <clipping_planes_vertex>
			#include <fog_vertex>

		}
		`,fragmentShader:`
		uniform vec3 diffuse;
		uniform float opacity;
		uniform float linewidth;

		#ifdef USE_DASH

			uniform float dashOffset;
			uniform float dashSize;
			uniform float gapSize;

		#endif

		varying float vLineDistance;

		#ifdef WORLD_UNITS

			varying vec4 worldPos;
			varying vec3 worldStart;
			varying vec3 worldEnd;

			#ifdef USE_DASH

				varying vec2 vUv;

			#endif

		#else

			varying vec2 vUv;

		#endif

		#include <common>
		#include <color_pars_fragment>
		#include <fog_pars_fragment>
		#include <logdepthbuf_pars_fragment>
		#include <clipping_planes_pars_fragment>

		vec2 closestLineToLine(vec3 p1, vec3 p2, vec3 p3, vec3 p4) {

			float mua;
			float mub;

			vec3 p13 = p1 - p3;
			vec3 p43 = p4 - p3;

			vec3 p21 = p2 - p1;

			float d1343 = dot( p13, p43 );
			float d4321 = dot( p43, p21 );
			float d1321 = dot( p13, p21 );
			float d4343 = dot( p43, p43 );
			float d2121 = dot( p21, p21 );

			float denom = d2121 * d4343 - d4321 * d4321;

			float numer = d1343 * d4321 - d1321 * d4343;

			mua = numer / denom;
			mua = clamp( mua, 0.0, 1.0 );
			mub = ( d1343 + d4321 * ( mua ) ) / d4343;
			mub = clamp( mub, 0.0, 1.0 );

			return vec2( mua, mub );

		}

		void main() {

			float alpha = opacity;
			vec4 diffuseColor = vec4( diffuse, alpha );

			#include <clipping_planes_fragment>

			#ifdef USE_DASH

				if ( vUv.y < - 1.0 || vUv.y > 1.0 ) discard; // discard endcaps

				if ( mod( vLineDistance + dashOffset, dashSize + gapSize ) > dashSize ) discard; // todo - FIX

			#endif

			#ifdef WORLD_UNITS

				// Find the closest points on the view ray and the line segment
				vec3 rayEnd = normalize( worldPos.xyz ) * 1e5;
				vec3 lineDir = worldEnd - worldStart;
				vec2 params = closestLineToLine( worldStart, worldEnd, vec3( 0.0, 0.0, 0.0 ), rayEnd );

				vec3 p1 = worldStart + lineDir * params.x;
				vec3 p2 = rayEnd * params.y;
				vec3 delta = p1 - p2;
				float len = length( delta );
				float norm = len / linewidth;

				#ifndef USE_DASH

					#ifdef USE_ALPHA_TO_COVERAGE

						float dnorm = fwidth( norm );
						alpha = 1.0 - smoothstep( 0.5 - dnorm, 0.5 + dnorm, norm );

					#else

						if ( norm > 0.5 ) {

							discard;

						}

					#endif

				#endif

			#else

				#ifdef USE_ALPHA_TO_COVERAGE

					// artifacts appear on some hardware if a derivative is taken within a conditional
					float a = vUv.x;
					float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
					float len2 = a * a + b * b;
					float dlen = fwidth( len2 );

					if ( abs( vUv.y ) > 1.0 ) {

						alpha = 1.0 - smoothstep( 1.0 - dlen, 1.0 + dlen, len2 );

					}

				#else

					if ( abs( vUv.y ) > 1.0 ) {

						float a = vUv.x;
						float b = ( vUv.y > 0.0 ) ? vUv.y - 1.0 : vUv.y + 1.0;
						float len2 = a * a + b * b;

						if ( len2 > 1.0 ) discard;

					}

				#endif

			#endif

			#include <logdepthbuf_fragment>
			#include <color_fragment>

			gl_FragColor = vec4( diffuseColor.rgb, alpha );

			#include <tonemapping_fragment>
			#include <colorspace_fragment>
			#include <fog_fragment>
			#include <premultiplied_alpha_fragment>

		}
		`};class St extends X{constructor(e){super({type:"LineMaterial",uniforms:F.clone(be.line.uniforms),vertexShader:be.line.vertexShader,fragmentShader:be.line.fragmentShader,clipping:!0}),this.isLineMaterial=!0,this.setValues(e)}get color(){return this.uniforms.diffuse.value}set color(e){this.uniforms.diffuse.value=e}get worldUnits(){return"WORLD_UNITS"in this.defines}set worldUnits(e){e===!0?this.defines.WORLD_UNITS="":delete this.defines.WORLD_UNITS}get linewidth(){return this.uniforms.linewidth.value}set linewidth(e){this.uniforms.linewidth&&(this.uniforms.linewidth.value=e)}get dashed(){return"USE_DASH"in this.defines}set dashed(e){e===!0!==this.dashed&&(this.needsUpdate=!0),e===!0?this.defines.USE_DASH="":delete this.defines.USE_DASH}get dashScale(){return this.uniforms.dashScale.value}set dashScale(e){this.uniforms.dashScale.value=e}get dashSize(){return this.uniforms.dashSize.value}set dashSize(e){this.uniforms.dashSize.value=e}get dashOffset(){return this.uniforms.dashOffset.value}set dashOffset(e){this.uniforms.dashOffset.value=e}get gapSize(){return this.uniforms.gapSize.value}set gapSize(e){this.uniforms.gapSize.value=e}get opacity(){return this.uniforms.opacity.value}set opacity(e){this.uniforms&&(this.uniforms.opacity.value=e)}get resolution(){return this.uniforms.resolution.value}set resolution(e){this.uniforms.resolution.value.copy(e)}get alphaToCoverage(){return"USE_ALPHA_TO_COVERAGE"in this.defines}set alphaToCoverage(e){this.defines&&(e===!0!==this.alphaToCoverage&&(this.needsUpdate=!0),e===!0?this.defines.USE_ALPHA_TO_COVERAGE="":delete this.defines.USE_ALPHA_TO_COVERAGE)}}const ui=Object.freeze(Object.defineProperty({__proto__:null,LineMaterial:St},Symbol.toStringTag,{value:"Module"})),lt=new tt,Te=new A;class xt extends kt{constructor(){super(),this.isLineSegmentsGeometry=!0,this.type="LineSegmentsGeometry";const e=[-1,2,0,1,2,0,-1,1,0,1,1,0,-1,0,0,1,0,0,-1,-1,0,1,-1,0],t=[-1,2,1,2,-1,1,1,1,-1,-1,1,-1,-1,-2,1,-2],i=[0,2,1,2,3,1,2,4,3,4,5,3,4,6,5,6,7,5];this.setIndex(i),this.setAttribute("position",new Ce(e,3)),this.setAttribute("uv",new Ce(t,2))}applyMatrix4(e){const t=this.attributes.instanceStart,i=this.attributes.instanceEnd;return t!==void 0&&(t.applyMatrix4(e),i.applyMatrix4(e),t.needsUpdate=!0),this.boundingBox!==null&&this.computeBoundingBox(),this.boundingSphere!==null&&this.computeBoundingSphere(),this}setPositions(e){let t;e instanceof Float32Array?t=e:Array.isArray(e)&&(t=new Float32Array(e));const i=new Ke(t,6,1);return this.setAttribute("instanceStart",new Q(i,3,0)),this.setAttribute("instanceEnd",new Q(i,3,3)),this.instanceCount=this.attributes.instanceStart.count,this.computeBoundingBox(),this.computeBoundingSphere(),this}setColors(e){let t;e instanceof Float32Array?t=e:Array.isArray(e)&&(t=new Float32Array(e));const i=new Ke(t,6,1);return this.setAttribute("instanceColorStart",new Q(i,3,0)),this.setAttribute("instanceColorEnd",new Q(i,3,3)),this}fromWireframeGeometry(e){return this.setPositions(e.attributes.position.array),this}fromEdgesGeometry(e){return this.setPositions(e.attributes.position.array),this}fromMesh(e){return this.fromWireframeGeometry(new qt(e.geometry)),this}fromLineSegments(e){const t=e.geometry;return this.setPositions(t.attributes.position.array),this}computeBoundingBox(){this.boundingBox===null&&(this.boundingBox=new tt);const e=this.attributes.instanceStart,t=this.attributes.instanceEnd;e!==void 0&&t!==void 0&&(this.boundingBox.setFromBufferAttribute(e),lt.setFromBufferAttribute(t),this.boundingBox.union(lt))}computeBoundingSphere(){this.boundingSphere===null&&(this.boundingSphere=new vt),this.boundingBox===null&&this.computeBoundingBox();const e=this.attributes.instanceStart,t=this.attributes.instanceEnd;if(e!==void 0&&t!==void 0){const i=this.boundingSphere.center;this.boundingBox.getCenter(i);let a=0;for(let s=0,o=e.count;s<o;s++)Te.fromBufferAttribute(e,s),a=Math.max(a,i.distanceToSquared(Te)),Te.fromBufferAttribute(t,s),a=Math.max(a,i.distanceToSquared(Te));this.boundingSphere.radius=Math.sqrt(a),isNaN(this.boundingSphere.radius)&&console.error("THREE.LineSegmentsGeometry.computeBoundingSphere(): Computed radius is NaN. The instanced position data is likely to have NaN values.",this)}}toJSON(){}}const hi=Object.freeze(Object.defineProperty({__proto__:null,LineSegmentsGeometry:xt},Symbol.toStringTag,{value:"Module"})),Xe=new he,ct=new A,dt=new A,y=new he,w=new he,z=new he,Ye=new A,Qe=new ue,T=new Zt,ft=new A,Pe=new tt,Ee=new vt,L=new he;let V,Y;function ut(l,e,t){return L.set(0,0,-e,1).applyMatrix4(l.projectionMatrix),L.multiplyScalar(1/L.w),L.x=Y/t.width,L.y=Y/t.height,L.applyMatrix4(l.projectionMatrixInverse),L.multiplyScalar(1/L.w),Math.abs(Math.max(L.x,L.y))}function ni(l,e){const t=l.matrixWorld,i=l.geometry,a=i.attributes.instanceStart,s=i.attributes.instanceEnd,o=Math.min(i.instanceCount,a.count);for(let n=0,d=o;n<d;n++){T.start.fromBufferAttribute(a,n),T.end.fromBufferAttribute(s,n),T.applyMatrix4(t);const r=new A,c=new A;V.distanceSqToSegment(T.start,T.end,c,r),c.distanceTo(r)<Y*.5&&e.push({point:c,pointOnLine:r,distance:V.origin.distanceTo(c),object:l,face:null,faceIndex:n,uv:null,uv1:null})}}function oi(l,e,t){const i=e.projectionMatrix,s=l.material.resolution,o=l.matrixWorld,n=l.geometry,d=n.attributes.instanceStart,r=n.attributes.instanceEnd,c=Math.min(n.instanceCount,d.count),f=-e.near;V.at(1,z),z.w=1,z.applyMatrix4(e.matrixWorldInverse),z.applyMatrix4(i),z.multiplyScalar(1/z.w),z.x*=s.x/2,z.y*=s.y/2,z.z=0,Ye.copy(z),Qe.multiplyMatrices(e.matrixWorldInverse,o);for(let g=0,p=c;g<p;g++){if(y.fromBufferAttribute(d,g),w.fromBufferAttribute(r,g),y.w=1,w.w=1,y.applyMatrix4(Qe),w.applyMatrix4(Qe),y.z>f&&w.z>f)continue;if(y.z>f){const h=y.z-w.z,u=(y.z-f)/h;y.lerp(w,u)}else if(w.z>f){const h=w.z-y.z,u=(w.z-f)/h;w.lerp(y,u)}y.applyMatrix4(i),w.applyMatrix4(i),y.multiplyScalar(1/y.w),w.multiplyScalar(1/w.w),y.x*=s.x/2,y.y*=s.y/2,w.x*=s.x/2,w.y*=s.y/2,T.start.copy(y),T.start.z=0,T.end.copy(w),T.end.z=0;const P=T.closestPointToPointParameter(Ye,!0);T.at(P,ft);const U=Xt.lerp(y.z,w.z,P),N=U>=-1&&U<=1,_=Ye.distanceTo(ft)<Y*.5;if(N&&_){T.start.fromBufferAttribute(d,g),T.end.fromBufferAttribute(r,g),T.start.applyMatrix4(o),T.end.applyMatrix4(o);const h=new A,u=new A;V.distanceSqToSegment(T.start,T.end,u,h),t.push({point:u,pointOnLine:h,distance:V.origin.distanceTo(u),object:l,face:null,faceIndex:g,uv:null,uv1:null})}}}class ri extends ht{constructor(e=new xt,t=new St({color:Math.random()*16777215})){super(e,t),this.isLineSegments2=!0,this.type="LineSegments2"}computeLineDistances(){const e=this.geometry,t=e.attributes.instanceStart,i=e.attributes.instanceEnd,a=new Float32Array(2*t.count);for(let o=0,n=0,d=t.count;o<d;o++,n+=2)ct.fromBufferAttribute(t,o),dt.fromBufferAttribute(i,o),a[n]=n===0?0:a[n-1],a[n+1]=a[n]+ct.distanceTo(dt);const s=new Ke(a,2,1);return e.setAttribute("instanceDistanceStart",new Q(s,1,0)),e.setAttribute("instanceDistanceEnd",new Q(s,1,1)),this}raycast(e,t){const i=this.material.worldUnits,a=e.camera;a===null&&!i&&console.error('LineSegments2: "Raycaster.camera" needs to be set in order to raycast against LineSegments2 while worldUnits is set to false.');const s=e.params.Line2!==void 0&&e.params.Line2.threshold||0;V=e.ray;const o=this.matrixWorld,n=this.geometry,d=this.material;Y=d.linewidth+s,n.boundingSphere===null&&n.computeBoundingSphere(),Ee.copy(n.boundingSphere).applyMatrix4(o);let r;if(i)r=Y*.5;else{const f=Math.max(a.near,Ee.distanceToPoint(V.origin));r=ut(a,f,d.resolution)}if(Ee.radius+=r,V.intersectsSphere(Ee)===!1)return;n.boundingBox===null&&n.computeBoundingBox(),Pe.copy(n.boundingBox).applyMatrix4(o);let c;if(i)c=Y*.5;else{const f=Math.max(a.near,Pe.distanceToPoint(V.origin));c=ut(a,f,d.resolution)}Pe.expandByScalar(c),V.intersectsBox(Pe)!==!1&&(i?ni(this,t):oi(this,a,t))}onBeforeRender(e){const t=this.material.uniforms;t&&t.resolution&&(e.getViewport(Xe),this.material.uniforms.resolution.value.set(Xe.z,Xe.w))}}const pi=Object.freeze(Object.defineProperty({__proto__:null,LineSegments2:ri},Symbol.toStringTag,{value:"Module"}));export{ci as G,ui as L,di as O,fi as S,hi as a,pi as b};
