// 介面契約的最小範例(不是成品)。真正的貓放在 cats/pixar/ 與 cats/real/。
import * as THREE from 'three';

export const meta = { id: '_example', name: '範例', renderer: { antialias: true, toneMapping: 'ACESFilmic', exposure: 1, shadows: false } };

export function createCatScene({ renderer, quality, aspect, seed }) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#2b4f86');
  const camera = new THREE.PerspectiveCamera(30, aspect, .05, 50); camera.position.set(0, .35, 2.2); camera.lookAt(0, .3, 0);
  scene.add(new THREE.HemisphereLight('#cfe2ff', '#20304a', 1.2));
  const key = new THREE.DirectionalLight('#fff2dc', 2.2); key.position.set(-1.5, 2, 2); scene.add(key);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.36, quality === 'tv' ? 32 : 64, quality === 'tv' ? 24 : 48), new THREE.MeshStandardMaterial({ color: '#15171c', roughness: .7 }));
  head.position.y = .38; scene.add(head);
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(6, .6, 1), new THREE.MeshStandardMaterial({ color: '#8fb4e6', roughness: 1 })); ledge.position.set(0, -.22, .35); scene.add(ledge);
  let gaze = null;
  return {
    scene, camera,
    update(dt, t) { head.rotation.z = Math.sin(t * 1.3) * .08; head.rotation.y = gaze ? gaze[0] * .3 : Math.sin(t * .4) * .2; },
    resize(a) { camera.aspect = a; camera.updateProjectionMatrix(); },
    setGaze(x, y) { gaze = x == null ? null : [x, y]; }, setMood() {}, setHour() {}, poke() {},
    dispose() { scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); }); },
  };
}
